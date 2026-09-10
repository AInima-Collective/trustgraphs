import { eq } from 'drizzle-orm'
import { ponder } from 'ponder:registry'
import {
  networkMetadataRevision,
  weightedPriorEntry,
  weightedPriorInstance,
  weightedPriorVersion,
} from 'ponder:schema'
import {
  type Address,
  type Hex,
  keccak256,
  stringToHex,
  zeroAddress,
} from 'viem'

import { fetchNetworkMetadata } from './factory'
import { revalidateNetwork } from './utils'
import { weightedManifestFromCalldata } from './weighted-prior-calldata'
import {
  type WeightedParams,
  type WeightedParamsJson,
  normalizeWeightedParams,
  rawCid,
  verifyWeightedManifest,
} from './weighted-prior-shared'

const sameHex = (left: string, right: string) =>
  left.toLowerCase() === right.toLowerCase()

const onchainParams = (params: any): WeightedParams => ({
  version: Number(params.version),
  dampingFp: BigInt(params.dampingFp),
  toleranceFp: BigInt(params.toleranceFp),
  maxIterations: Number(params.maxIterations),
  minWeight: BigInt(params.minWeight),
  maxWeight: BigInt(params.maxWeight),
  priorRoot: params.priorRoot,
  priorCount: Number(params.priorCount),
  manifestSha256: params.manifestSha256,
  schemaUid: params.schemaUid,
  weightFieldIndex: Number(params.weightFieldIndex),
  accumulator: params.accumulator,
  chainId: BigInt(params.chainId),
})

const jsonParams = (params: WeightedParamsJson): WeightedParams => ({
  version: params.version,
  dampingFp: BigInt(params.dampingFp),
  toleranceFp: BigInt(params.toleranceFp),
  maxIterations: params.maxIterations,
  minWeight: BigInt(params.minWeight),
  maxWeight: BigInt(params.maxWeight),
  priorRoot: params.priorRoot,
  priorCount: params.priorCount,
  manifestSha256: params.manifestSha256,
  schemaUid: params.schemaUid,
  weightFieldIndex: params.weightFieldIndex,
  accumulator: params.accumulator,
  chainId: BigInt(params.chainId),
})

const manifestFromTransaction = async (
  context: any,
  hash: Hex,
  kind: 'create' | 'propose'
): Promise<Hex> => {
  const transaction = await context.client.getTransaction({ hash })
  return weightedManifestFromCalldata(transaction.input, kind)
}

const recover = async (
  context: any,
  transactionHash: Hex,
  kind: 'create' | 'propose',
  params: WeightedParams
) => {
  try {
    const manifest = await manifestFromTransaction(
      context,
      transactionHash,
      kind
    )
    const verified = verifyWeightedManifest(
      manifest,
      params,
      BigInt(context.chain.id)
    )
    return {
      manifest,
      entries: verified.entries,
      cid: verified.cid,
      availability: 'available',
      provenance: 'transaction',
      error: null,
    }
  } catch (error) {
    return {
      manifest: null,
      entries: [],
      cid: rawCid(params.manifestSha256),
      availability: 'unavailable',
      provenance: 'transaction',
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

const insertEntries = async (
  context: any,
  instanceId: Hex,
  version: bigint,
  entries: Array<{ account: Address; normalizedWeight: bigint }>
) => {
  for (const [position, entry] of entries.entries()) {
    await context.db
      .insert(weightedPriorEntry)
      .values({
        id: `${instanceId}-${version}-${position}`,
        instanceId,
        version,
        position,
        account: entry.account,
        normalizedWeight: entry.normalizedWeight,
      })
      .onConflictDoUpdate({
        account: entry.account,
        normalizedWeight: entry.normalizedWeight,
      })
  }
}

ponder.on(
  'weightedTrustgraphsFactory:WeightedInstanceCreated',
  async ({ event, context }) => {
    const {
      instanceId,
      creator,
      admin,
      name,
      metadataURI,
      resolver,
      schemaUid,
      snapshot,
      distributor,
      distributorToken,
      epochLength,
      metadataDigest,
      params: eventParams,
    } = event.args
    const params = onchainParams(eventParams)
    const normalized = normalizeWeightedParams(params)
    const { metadata, status: metadataStatus } =
      await fetchNetworkMetadata(metadataURI)
    const metadataURIHash = keccak256(stringToHex(metadataURI))
    await context.db
      .insert(weightedPriorInstance)
      .values({
        id: instanceId,
        chainId: `${context.chain.id}`,
        factory: event.log.address,
        controller: null,
        creator,
        admin,
        name,
        metadataURI,
        metadataURIHash,
        metadataRevision: 0n,
        metadataStatus,
        metadataUpdatedBlock: event.block.number,
        metadataUpdatedTimestamp: event.block.timestamp,
        metadataUpdatedTxHash: event.transaction.hash,
        metadata,
        resolver,
        schemaUid,
        snapshot,
        distributor: distributor === zeroAddress ? null : distributor,
        distributorToken:
          distributorToken === zeroAddress ? null : distributorToken,
        epochLength,
        currentVersion: 1n,
        currentParamsHash: normalized.hash,
        params: normalized.paramsJson,
        metadataDigest,
        createdBlock: event.block.number,
        createdTimestamp: event.block.timestamp,
        createdTxHash: event.transaction.hash,
      })
      .onConflictDoNothing()

    await context.db
      .insert(networkMetadataRevision)
      .values({
        id: `${snapshot.toLowerCase()}-0`,
        instanceId,
        snapshot,
        revision: 0n,
        authority: admin,
        metadataURI,
        metadataURIHash,
        previousMetadataURIHash: null,
        metadata,
        status: metadataStatus,
        blockNumber: event.block.number,
        timestamp: event.block.timestamp,
        txHash: event.transaction.hash,
      })
      .onConflictDoNothing()

    await revalidateNetwork(instanceId)
  }
)

ponder.on(
  'weightedTrustgraphsFactory:WeightedParamsControllerCreated',
  async ({ event, context }) => {
    const { instanceId, controller } = event.args
    // Safe because: `WeightedInstanceCreated` (which inserts this row above) precedes this event
    // from the same statically configured factory contract in the same createInstance transaction,
    // discovery-before-children order. Ponder replays one contract's logs in logIndex order and a
    // start block cannot split a transaction, so the row always exists here. Do not "generalize"
    // this into an ensure — a missing row would mean the factory's event order changed, and that
    // contract bug should be loud.
    await context.db
      .update(weightedPriorInstance, { id: instanceId })
      .set({ controller })
  }
)

ponder.on(
  'weightedPriorParamsController:InitialPriorPublished',
  async ({ event, context }) => {
    const { instanceId, version, paramsHash, metadataDigest } = event.args
    const params = onchainParams(event.args.params)
    const normalized = normalizeWeightedParams(params)
    const recovered = await recover(
      context,
      event.transaction.hash,
      'create',
      params
    )
    const consistent = sameHex(normalized.hash, paramsHash)
    const error = [
      consistent
        ? null
        : `event params encode ${normalized.hash}, event names ${paramsHash}`,
      recovered.error,
    ]
      .filter(Boolean)
      .join('; ')

    await context.db
      .insert(weightedPriorVersion)
      .values({
        id: `${instanceId}-${version}`,
        instanceId,
        controller: event.log.address,
        version,
        // Chain lifecycle and byte availability are independent axes: an active commitment whose
        // archival transaction is temporarily unavailable remains active, but serves no entries.
        status: consistent ? 'active' : 'inconsistent',
        paramsHash,
        previousParamsHash: null,
        params: normalized.paramsJson,
        proposalId: null,
        priorRoot: params.priorRoot,
        priorCount: params.priorCount,
        manifestSha256: params.manifestSha256,
        manifestCid: recovered.cid,
        metadataDigest,
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
        provenance: recovered.provenance,
        sourceTxHash: event.transaction.hash,
        manifestBytes: recovered.manifest,
        availabilityError: error || null,
        verifiedAt:
          recovered.availability === 'available' ? event.block.timestamp : null,
      })
      .onConflictDoNothing()
    await insertEntries(context, instanceId, version, recovered.entries)
  }
)

ponder.on(
  'weightedPriorParamsController:PriorProposed',
  async ({ event, context }) => {
    const {
      instanceId,
      version,
      proposalId,
      priorRoot,
      priorCount,
      manifestSha256,
      metadataDigest,
      paramsHash,
      readyAt,
    } = event.args
    const instance = await context.db.find(weightedPriorInstance, {
      id: instanceId,
    })
    if (!instance) {
      console.error(
        `weighted prior proposal for unknown instance ${instanceId}`
      )
      return
    }
    const params = {
      ...jsonParams(instance.params as WeightedParamsJson),
      priorRoot,
      priorCount,
      manifestSha256,
    }
    const normalized = normalizeWeightedParams(params)
    const recovered = await recover(
      context,
      event.transaction.hash,
      'propose',
      params
    )
    const consistent = sameHex(normalized.hash, paramsHash)
    const error = [
      consistent
        ? null
        : `proposed params encode ${normalized.hash}, event names ${paramsHash}`,
      recovered.error,
    ]
      .filter(Boolean)
      .join('; ')

    await context.db
      .insert(weightedPriorVersion)
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
        priorRoot,
        priorCount,
        manifestSha256,
        manifestCid: recovered.cid,
        metadataDigest,
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
        provenance: recovered.provenance,
        sourceTxHash: event.transaction.hash,
        manifestBytes: recovered.manifest,
        availabilityError: error || null,
        verifiedAt:
          recovered.availability === 'available' ? event.block.timestamp : null,
      })
      .onConflictDoNothing()
    await insertEntries(context, instanceId, version, recovered.entries)
  }
)

ponder.on(
  'weightedPriorParamsController:PriorActivated',
  async ({ event, context }) => {
    const {
      instanceId,
      version,
      paramsHash,
      previousParamsHash,
      proposalId,
      params: eventParams,
    } = event.args
    const [instance, prior] = await Promise.all([
      context.db.find(weightedPriorInstance, { id: instanceId }),
      context.db.find(weightedPriorVersion, { id: `${instanceId}-${version}` }),
    ])
    if (!instance || !prior) {
      console.error(
        `weighted activation ${instanceId} v${version} has no proposal history`
      )
      return
    }
    const params = onchainParams(eventParams)
    const normalized = normalizeWeightedParams(params)
    const consistent =
      sameHex(normalized.hash, paramsHash) &&
      sameHex(prior.paramsHash, paramsHash) &&
      sameHex(instance.currentParamsHash, previousParamsHash) &&
      prior.proposalId !== null &&
      sameHex(prior.proposalId, proposalId)

    const previousId = `${instanceId}-${instance.currentVersion}`
    const previous = await context.db.find(weightedPriorVersion, {
      id: previousId,
    })
    if (consistent && previous) {
      await context.db
        .update(weightedPriorVersion, { id: previousId })
        .set({ status: 'superseded' })
    }
    await context.db
      .update(weightedPriorVersion, { id: `${instanceId}-${version}` })
      .set({
        status: consistent ? 'active' : 'inconsistent',
        activatedBlock: event.block.number,
        activatedTimestamp: event.block.timestamp,
        activatedTxHash: event.transaction.hash,
        availabilityError: consistent
          ? prior.availabilityError
          : 'activation did not match proposal/current chain state',
      })
    if (consistent) {
      await context.db.update(weightedPriorInstance, { id: instanceId }).set({
        currentVersion: version,
        currentParamsHash: paramsHash,
        params: normalized.paramsJson,
        metadataDigest: event.args.metadataDigest,
      })
    }
  }
)

ponder.on(
  'weightedMerkleSnapshot:CheckpointParamsPinned',
  async ({ event, context }) => {
    const [instance] = await context.db.sql
      .select()
      .from(weightedPriorInstance)
      .where(eq(weightedPriorInstance.snapshot, event.log.address))
      .limit(1)
    if (!instance) return
    const version = await context.db.find(weightedPriorVersion, {
      id: `${instance.id}-${instance.currentVersion}`,
    })
    if (
      !version ||
      !sameHex(version.paramsHash, event.args.paramsHash) ||
      version.firstCheckpoint !== null
    ) {
      return
    }
    await context.db.update(weightedPriorVersion, { id: version.id }).set({
      firstCheckpoint: event.args.checkpointId,
      firstCheckpointBlock: event.block.number,
      firstCheckpointTimestamp: event.block.timestamp,
      firstCheckpointTxHash: event.transaction.hash,
    })
  }
)

ponder.on(
  'weightedPriorParamsController:PriorProposalCancelled',
  async ({ event, context }) => {
    const { instanceId, version, proposalId } = event.args
    const prior = await context.db.find(weightedPriorVersion, {
      id: `${instanceId}-${version}`,
    })
    if (
      !prior ||
      prior.proposalId === null ||
      !sameHex(prior.proposalId, proposalId)
    ) {
      console.error(
        `weighted cancellation ${instanceId} v${version} has no matching proposal`
      )
      return
    }
    await context.db
      .update(weightedPriorVersion, { id: `${instanceId}-${version}` })
      .set({ status: 'cancelled' })
  }
)
