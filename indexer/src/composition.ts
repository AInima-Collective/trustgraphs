import { and, desc, eq } from 'drizzle-orm'
import { ponder } from 'ponder:registry'
import {
  compositionCapture,
  compositionInstance,
  compositionPolicyVersion,
} from 'ponder:schema'
import {
  type Address,
  type Hex,
  decodeFunctionData,
  encodeAbiParameters,
  keccak256,
  sha256,
  zeroAddress,
} from 'viem'

import {
  COMPOSITION_OUTPUT_KIND,
  type CompositionParams,
  type CompositionParamsJson,
  compositionParamsFromJson,
  normalizeCompositionParams,
  parseCompositionCapture,
  policyManifestFromCapture,
  verifyCompositionPolicy,
} from './composition-shared'
import {
  compositionAccumulatorAbi,
  compositionSourceAdapterAbi,
  trustComposeFactoryAbi,
  trustComposeParamsControllerAbi,
} from '../abis/composition'

const sameHex = (left: string, right: string) =>
  left.toLowerCase() === right.toLowerCase()

export const compositionParamsFromChain = (params: any): CompositionParams => ({
  version: Number(params.version),
  programId: params.programId,
  scopeHash: params.scopeHash,
  identityDomain: params.identityDomain,
  outputKind: params.outputKind,
  outputDomain: params.outputDomain,
  admittedProgramId: params.admittedProgramId,
  weightScale: BigInt(params.weightScale),
  outputPool: BigInt(params.outputPool),
  sourcePolicyRoot: params.sourcePolicyRoot,
  sourceCount: Number(params.sourceCount),
  policyManifestSha256: params.policyManifestSha256,
  maxSources: Number(params.maxSources),
  maxEntriesPerSource: Number(params.maxEntriesPerSource),
  maxAggregateEntries: Number(params.maxAggregateEntries),
  maxUnionAccounts: Number(params.maxUnionAccounts),
  maxAggregateBlobBytes: Number(params.maxAggregateBlobBytes),
  maxSourceAgeBlocks: BigInt(params.maxSourceAgeBlocks),
  accumulator: params.accumulator,
  chainId: BigInt(params.chainId),
})

const policyFromTransaction = async (
  context: any,
  transactionHash: Hex,
  kind: 'create' | 'propose'
) => {
  const transaction = await context.client.getTransaction({
    hash: transactionHash,
  })
  const decoded = decodeFunctionData({
    abi:
      kind === 'create'
        ? trustComposeFactoryAbi
        : trustComposeParamsControllerAbi,
    data: transaction.input,
  }) as any
  if (kind === 'create' && decoded.functionName === 'createInstance') {
    return {
      manifest: decoded.args[0].policyManifest as Hex,
      adapters: decoded.args[0].sourceAdapters as Address[],
    }
  }
  if (kind === 'propose' && decoded.functionName === 'proposePolicy') {
    return {
      manifest: decoded.args[0] as Hex,
      adapters: decoded.args[1] as Address[],
    }
  }
  throw new Error(
    `source transaction decoded as ${decoded.functionName}, expected composition ${kind}`
  )
}

const recoverPolicy = async (
  context: any,
  transactionHash: Hex,
  kind: 'create' | 'propose',
  params: CompositionParams,
  expectedAdapterSetHash: Hex
) => {
  try {
    const { manifest, adapters } = await policyFromTransaction(
      context,
      transactionHash,
      kind
    )
    const verified = verifyCompositionPolicy(
      manifest,
      params,
      BigInt(context.chain.id)
    )
    if (adapters.length !== verified.sources.length)
      throw new Error('adapter count does not match source count')
    const adapterSetHash = keccak256(
      encodeAbiParameters([{ type: 'address[]' }], [adapters])
    )
    if (!sameHex(adapterSetHash, expectedAdapterSetHash))
      throw new Error('adapter-set hash does not match event commitment')

    const admitted = await Promise.all(
      adapters.map(async (adapter, position) => {
        const [
          sourceId,
          snapshot,
          familyId,
          programId,
          outputKind,
          chainId,
          provenance,
        ] = await Promise.all([
          context.client.readContract({
            address: adapter,
            abi: compositionSourceAdapterAbi,
            functionName: 'sourceId',
          }),
          context.client.readContract({
            address: adapter,
            abi: compositionSourceAdapterAbi,
            functionName: 'snapshot',
          }),
          context.client.readContract({
            address: adapter,
            abi: compositionSourceAdapterAbi,
            functionName: 'familyId',
          }),
          context.client.readContract({
            address: adapter,
            abi: compositionSourceAdapterAbi,
            functionName: 'programId',
          }),
          context.client.readContract({
            address: adapter,
            abi: compositionSourceAdapterAbi,
            functionName: 'outputKind',
          }),
          context.client.readContract({
            address: adapter,
            abi: compositionSourceAdapterAbi,
            functionName: 'chainId',
          }),
          context.client.readContract({
            address: adapter,
            abi: compositionSourceAdapterAbi,
            functionName: 'deploymentProvenance',
          }),
        ])
        const source = verified.sources[position]!
        if (
          !sameHex(sourceId, source.sourceId) ||
          !sameHex(snapshot, source.snapshot) ||
          !sameHex(familyId, source.familyId) ||
          !sameHex(programId, source.programId) ||
          !sameHex(outputKind, COMPOSITION_OUTPUT_KIND) ||
          BigInt(chainId) !== params.chainId ||
          /^0x0{64}$/.test(provenance)
        )
          throw new Error(
            `adapter ${position} conflicts with its admitted policy`
          )
        return {
          position,
          adapter,
          deploymentProvenance: provenance,
          sourceId,
          snapshot,
          familyId,
          programId,
          outputKind,
          chainId: BigInt(chainId).toString(),
        }
      })
    )
    return {
      manifest,
      sources: verified.sources.map((source) => ({
        ...source,
        weight: source.weight.toString(),
        maxAgeBlocks: source.maxAgeBlocks.toString(),
      })),
      adapters: admitted,
      availability: 'available',
      error: null,
    }
  } catch (error) {
    return {
      manifest: null,
      sources: [],
      adapters: [],
      availability: 'unavailable',
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

ponder.on(
  'trustComposeFactory:TrustComposeInstanceCreated',
  async ({ event, context }) => {
    const {
      instanceId,
      creator,
      admin,
      name,
      metadataURI,
      accumulator,
      snapshot,
      distributor,
      distributorToken,
      epochLength,
      programVKey,
      metadataDigest,
      params: eventParams,
    } = event.args
    const params = compositionParamsFromChain(eventParams)
    const normalized = normalizeCompositionParams(params)
    await context.db
      .insert(compositionInstance)
      .values({
        id: instanceId,
        chainId: `${context.chain.id}`,
        factory: event.log.address,
        controller: null,
        creator,
        admin,
        name,
        metadataURI,
        accumulator,
        snapshot,
        distributor: distributor === zeroAddress ? null : distributor,
        distributorToken:
          distributorToken === zeroAddress ? null : distributorToken,
        epochLength,
        programVKey,
        currentVersion: 1n,
        currentParamsHash: normalized.hash,
        params: normalized.paramsJson,
        metadataDigest,
        createdBlock: event.block.number,
        createdTimestamp: event.block.timestamp,
        createdTxHash: event.transaction.hash,
      })
      .onConflictDoNothing()
  }
)

ponder.on(
  'trustComposeFactory:TrustComposeParamsControllerCreated',
  async ({ event, context }) => {
    await context.db
      .update(compositionInstance, { id: event.args.instanceId })
      .set({ controller: event.args.controller })
  }
)

ponder.on(
  'trustComposeParamsController:InitialPolicyPublished',
  async ({ event, context }) => {
    const { instanceId, version, paramsHash, adapterSetHash, metadataDigest } =
      event.args
    const params = compositionParamsFromChain(event.args.params)
    const normalized = normalizeCompositionParams(params)
    const recovered = await recoverPolicy(
      context,
      event.transaction.hash,
      'create',
      params,
      adapterSetHash
    )
    const consistent = sameHex(normalized.hash, paramsHash)
    const error = [
      consistent ? null : 'event params do not encode the named params hash',
      recovered.error,
    ]
      .filter(Boolean)
      .join('; ')
    await context.db
      .insert(compositionPolicyVersion)
      .values({
        id: `${instanceId}-${version}`,
        instanceId,
        controller: event.log.address,
        version,
        status: consistent ? 'active' : 'inconsistent',
        paramsHash,
        previousParamsHash: null,
        params: normalized.paramsJson,
        proposalId: null,
        sourcePolicyRoot: params.sourcePolicyRoot,
        sourceCount: params.sourceCount,
        manifestSha256: params.policyManifestSha256,
        adapterSetHash,
        metadataDigest,
        policyManifest: recovered.manifest,
        sources: recovered.sources,
        adapters: recovered.adapters,
        readyAt: event.block.timestamp,
        proposedBlock: event.block.number,
        proposedTimestamp: event.block.timestamp,
        proposedTxHash: event.transaction.hash,
        activatedBlock: event.block.number,
        activatedTimestamp: event.block.timestamp,
        activatedTxHash: event.transaction.hash,
        firstCheckpoint: null,
        firstCheckpointBlock: null,
        firstCheckpointTimestamp: null,
        firstCheckpointTxHash: null,
        availability: recovered.availability,
        availabilityError: error || null,
        verifiedAt:
          recovered.availability === 'available' ? event.block.timestamp : null,
      })
      .onConflictDoNothing()
  }
)

ponder.on(
  'trustComposeParamsController:PolicyProposed',
  async ({ event, context }) => {
    const {
      instanceId,
      version,
      proposalId,
      sourcePolicyRoot,
      sourceCount,
      manifestSha256,
      adapterSetHash,
      metadataDigest,
      paramsHash,
      readyAt,
    } = event.args
    const instance = await context.db.find(compositionInstance, {
      id: instanceId,
    })
    if (!instance)
      throw new Error(`composition proposal for unknown ${instanceId}`)
    const params = {
      ...compositionParamsFromJson(instance.params as CompositionParamsJson),
      sourcePolicyRoot,
      sourceCount: Number(sourceCount),
      policyManifestSha256: manifestSha256,
    }
    const normalized = normalizeCompositionParams(params)
    const recovered = await recoverPolicy(
      context,
      event.transaction.hash,
      'propose',
      params,
      adapterSetHash
    )
    const consistent = sameHex(normalized.hash, paramsHash)
    const error = [
      consistent ? null : 'proposal params do not encode the named params hash',
      recovered.error,
    ]
      .filter(Boolean)
      .join('; ')
    await context.db
      .insert(compositionPolicyVersion)
      .values({
        id: `${instanceId}-${version}`,
        instanceId,
        controller: event.log.address,
        version,
        status: consistent ? 'pending' : 'inconsistent',
        paramsHash,
        previousParamsHash: instance.currentParamsHash,
        params: normalized.paramsJson,
        proposalId,
        sourcePolicyRoot,
        sourceCount: Number(sourceCount),
        manifestSha256,
        adapterSetHash,
        metadataDigest,
        policyManifest: recovered.manifest,
        sources: recovered.sources,
        adapters: recovered.adapters,
        readyAt: BigInt(readyAt),
        proposedBlock: event.block.number,
        proposedTimestamp: event.block.timestamp,
        proposedTxHash: event.transaction.hash,
        activatedBlock: null,
        activatedTimestamp: null,
        activatedTxHash: null,
        firstCheckpoint: null,
        firstCheckpointBlock: null,
        firstCheckpointTimestamp: null,
        firstCheckpointTxHash: null,
        availability: recovered.availability,
        availabilityError: error || null,
        verifiedAt:
          recovered.availability === 'available' ? event.block.timestamp : null,
      })
      .onConflictDoNothing()
  }
)

ponder.on(
  'trustComposeParamsController:PolicyActivated',
  async ({ event, context }) => {
    const { instanceId, version, paramsHash, previousParamsHash } = event.args
    const params = compositionParamsFromChain(event.args.params)
    const normalized = normalizeCompositionParams(params)
    const policy = await context.db.find(compositionPolicyVersion, {
      id: `${instanceId}-${version}`,
    })
    if (!policy)
      throw new Error(`composition activation has no proposal ${version}`)
    const valid =
      sameHex(normalized.hash, paramsHash) &&
      sameHex(policy.paramsHash, paramsHash) &&
      sameHex(policy.adapterSetHash, event.args.adapterSetHash)
    const active = await context.db.sql
      .select()
      .from(compositionPolicyVersion)
      .where(
        and(
          eq(compositionPolicyVersion.instanceId, instanceId),
          eq(compositionPolicyVersion.status, 'active')
        )
      )
    for (const previous of active) {
      await context.db
        .update(compositionPolicyVersion, { id: previous.id })
        .set({ status: 'superseded' })
    }
    await context.db.update(compositionPolicyVersion, { id: policy.id }).set({
      status: valid ? 'active' : 'inconsistent',
      previousParamsHash,
      params: normalized.paramsJson,
      activatedBlock: event.block.number,
      activatedTimestamp: event.block.timestamp,
      activatedTxHash: event.transaction.hash,
      availabilityError: valid
        ? policy.availabilityError
        : 'activation commitments conflict with proposal',
    })
    if (valid) {
      await context.db.update(compositionInstance, { id: instanceId }).set({
        currentVersion: version,
        currentParamsHash: paramsHash,
        params: normalized.paramsJson,
        metadataDigest: event.args.metadataDigest,
      })
    }
  }
)

ponder.on(
  'trustComposeParamsController:PolicyProposalCancelled',
  async ({ event, context }) => {
    const policy = await context.db.find(compositionPolicyVersion, {
      id: `${event.args.instanceId}-${event.args.version}`,
    })
    if (!policy || !sameHex(policy.proposalId ?? '', event.args.proposalId))
      throw new Error('composition cancellation has no matching proposal')
    await context.db
      .update(compositionPolicyVersion, { id: policy.id })
      .set({ status: 'cancelled' })
  }
)

ponder.on(
  'compositionAccumulator:CaptureManifestStored',
  async ({ event, context }) => {
    const [instance] = await context.db.sql
      .select()
      .from(compositionInstance)
      .where(eq(compositionInstance.accumulator, event.log.address))
      .limit(1)
    if (!instance)
      throw new Error('composition capture belongs to no catalog instance')
    const manifest = event.args.manifest as Hex
    if (!sameHex(sha256(manifest), event.args.sha256Digest))
      throw new Error('composition capture event digest mismatch')
    const parsed = parseCompositionCapture(manifest, BigInt(context.chain.id))
    const [policyVersion, adapterSetHash, sourceCheckpointIds] =
      await Promise.all([
        context.client.readContract({
          address: event.log.address,
          abi: compositionAccumulatorAbi,
          functionName: 'checkpointPolicyVersion',
          args: [event.args.checkpointId],
        }),
        context.client.readContract({
          address: event.log.address,
          abi: compositionAccumulatorAbi,
          functionName: 'checkpointAdapterSetHash',
          args: [event.args.checkpointId],
        }),
        context.client.readContract({
          address: event.log.address,
          abi: compositionAccumulatorAbi,
          functionName: 'getCaptureSourceCheckpointIds',
          args: [event.args.checkpointId],
        }),
      ])
    if (sourceCheckpointIds.length !== parsed.sources.length)
      throw new Error('composition source checkpoint provenance is incomplete')
    const policy = await context.db.find(compositionPolicyVersion, {
      id: `${instance.id}-${policyVersion}`,
    })
    if (
      !policy ||
      policy.availability !== 'available' ||
      !sameHex(policy.adapterSetHash, adapterSetHash)
    )
      throw new Error('composition capture policy is unavailable or mismatched')
    const params = compositionParamsFromJson(
      policy.params as CompositionParamsJson
    )
    verifyCompositionPolicy(
      policyManifestFromCapture(manifest),
      params,
      BigInt(context.chain.id)
    )
    await context.db
      .insert(compositionCapture)
      .values({
        id: `${instance.id}-${event.args.checkpointId}`,
        instanceId: instance.id,
        accumulator: event.log.address,
        checkpointId: event.args.checkpointId,
        policyVersion,
        adapterSetHash,
        manifestSha256: event.args.sha256Digest,
        manifest,
        sourceCheckpointIds: sourceCheckpointIds.map((id) => id.toString()),
        captureBlock: parsed.captureBlock,
        blockNumber: event.block.number,
        timestamp: event.block.timestamp,
        txHash: event.transaction.hash,
      })
      .onConflictDoNothing()
  }
)

ponder.on(
  'compositionMerkleSnapshot:CheckpointParamsPinned',
  async ({ event, context }) => {
    const [instance] = await context.db.sql
      .select()
      .from(compositionInstance)
      .where(eq(compositionInstance.snapshot, event.log.address))
      .limit(1)
    if (!instance) return
    const [version] = await context.db.sql
      .select()
      .from(compositionPolicyVersion)
      .where(
        and(
          eq(compositionPolicyVersion.instanceId, instance.id),
          eq(compositionPolicyVersion.paramsHash, event.args.paramsHash)
        )
      )
      .orderBy(desc(compositionPolicyVersion.version))
      .limit(1)
    if (!version || version.firstCheckpoint !== null) return
    await context.db.update(compositionPolicyVersion, { id: version.id }).set({
      firstCheckpoint: event.args.checkpointId,
      firstCheckpointBlock: event.block.number,
      firstCheckpointTimestamp: event.block.timestamp,
      firstCheckpointTxHash: event.transaction.hash,
    })
  }
)
