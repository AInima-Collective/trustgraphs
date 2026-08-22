import { and, eq } from 'drizzle-orm'
import {
  compositionCapture,
  compositionInstance,
  compositionPolicyVersion,
} from 'ponder:schema'
import { type Hex, bytesToHex, keccak256, sha256 } from 'viem'

import { compositionCheckpointForEvent } from './composition-receipt'
import {
  type CompositionParamsJson,
  compositionParamsFromJson,
  decodeCompositionScoreBlob,
  rawCompositionCid,
  verifyCompositionAcceptance,
} from './composition-shared'
import type { ScoreProgramProvenance } from './score-program'
import { merkleSnapshotAbi } from '../../frontend/lib/contract-abis'
import { compositionAccumulatorAbi } from '../abis/composition'
import * as offchainSchema from '../offchain.schema'

const sameHex = (left: string, right: string) =>
  left.toLowerCase() === right.toLowerCase()

const jsonBigints = (value: unknown) =>
  JSON.parse(
    JSON.stringify(value, (_key, item) =>
      typeof item === 'bigint' ? item.toString() : item
    )
  ) as Record<string, unknown>

/**
 * Verify and persist one composition atomically from authenticated chain state and exact bytes.
 * Any mismatch throws before a composition-owned row is written.
 */
export const ingestCompositionScores = async (
  event: any,
  context: any,
  outputBytes: Uint8Array,
  provenance: ScoreProgramProvenance,
  fetchSource: (cid: string) => Promise<Uint8Array>,
  offchainDb: any
) => {
  const snapshot = event.log.address as Hex
  const [instance] = await context.db.sql
    .select()
    .from(compositionInstance)
    .where(eq(compositionInstance.snapshot, snapshot))
    .limit(1)
  if (!instance)
    throw new Error('composition root has no authenticated catalog instance')
  if (
    !sameHex(instance.id, provenance.instanceId) ||
    !sameHex(instance.accumulator, provenance.registryOrAccumulator)
  )
    throw new Error('composition catalog conflicts with score-program binding')

  // Reads are block-scoped, not transaction-scoped. Recover this event's checkpoint from its own
  // receipt so two accepted compositions in one block cannot be confused with one another.
  const checkpointId = await compositionCheckpointForEvent(event, context)
  const paramsHash = await context.client.readContract({
    address: snapshot,
    abi: merkleSnapshotAbi,
    functionName: 'checkpointParamsHash',
    args: [checkpointId],
  })
  const accepted = await context.client.readContract({
    address: snapshot,
    abi: merkleSnapshotAbi,
    functionName: 'getAcceptedCheckpoint',
    args: [checkpointId],
  })
  const acceptedState = accepted[0]
  const acceptedProof = accepted[1]
  const verifierCode = await context.client.getCode({
    address: acceptedProof.verifier,
  })
  const accumulatorCheckpoint = await context.client.readContract({
    address: instance.accumulator,
    abi: compositionAccumulatorAbi,
    functionName: 'getCheckpoint',
    args: [checkpointId],
  })
  const capture = await context.db.find(compositionCapture, {
    id: `${instance.id}-${checkpointId}`,
  })
  if (!capture) throw new Error('composition capture preimage is unavailable')
  const policy = await context.db.find(compositionPolicyVersion, {
    id: `${instance.id}-${capture.policyVersion}`,
  })
  if (
    !policy ||
    policy.availability !== 'available' ||
    policy.status === 'inconsistent'
  )
    throw new Error(
      'composition policy preimage is unavailable or inconsistent'
    )
  if (
    !sameHex(paramsHash, policy.paramsHash) ||
    !sameHex(paramsHash, provenance.paramsHash) ||
    !sameHex(capture.manifestSha256, accumulatorCheckpoint.acc) ||
    BigInt(capture.checkpointId) !== BigInt(checkpointId) ||
    BigInt(accumulatorCheckpoint.leafCount) !==
      BigInt((capture.sourceCheckpointIds as string[]).length) ||
    BigInt(accumulatorCheckpoint.blockNumber) !== BigInt(capture.captureBlock)
  )
    throw new Error('composition checkpoint commitments conflict')
  if (
    BigInt(acceptedState.blockNumber) !== BigInt(capture.captureBlock) ||
    BigInt(acceptedState.timestamp) !== BigInt(event.block.timestamp) ||
    BigInt(acceptedProof.checkpointId) !== BigInt(checkpointId) ||
    !sameHex(acceptedProof.paramsHash, paramsHash) ||
    !sameHex(acceptedProof.programVKey, instance.programVKey) ||
    !sameHex(acceptedProof.verifier, provenance.verifier) ||
    !verifierCode ||
    !sameHex(keccak256(verifierCode), acceptedProof.verifierCodehash) ||
    BigInt(acceptedProof.acceptedAtBlock) !== BigInt(event.block.number)
  )
    throw new Error('composition proof acceptance provenance conflicts')

  if (!sameHex(sha256(outputBytes), event.args.ipfsHash))
    throw new Error('composition output gateway bytes do not match ipfsHash')
  if (rawCompositionCid(event.args.ipfsHash) !== event.args.ipfsHashCid)
    throw new Error('composition output CID is not raw-sha256 canonical')

  const adapters = policy.adapters as Array<{
    adapter: Hex
    deploymentProvenance: Hex
    sourceId: Hex
  }>
  const sourceCheckpointIds = capture.sourceCheckpointIds as string[]
  if (adapters.length !== sourceCheckpointIds.length)
    throw new Error('composition governance/source provenance is incomplete')
  const manifestBytes = capture.manifest as Hex
  const params = compositionParamsFromJson(
    policy.params as CompositionParamsJson
  )
  const parsedSources = (policy.sources as Array<{ sourceId: Hex }>).length
  if (parsedSources !== sourceCheckpointIds.length)
    throw new Error('composition policy source provenance is incomplete')

  // CIDs are derived from the TGCM sha256 fields by the recomputer, but source downloads need the
  // strings up front. rawCompositionCid is the only accepted derivation.
  const captureHex = manifestBytes.slice(2)
  const captureRecordBytes = 261
  const captureHeaderBytes = 23
  const sourcePreimages = await Promise.all(
    sourceCheckpointIds.map(async (_sourceCheckpointId, position) => {
      const start =
        (captureHeaderBytes + position * captureRecordBytes + 164) * 2
      const blobSha256 = `0x${captureHex.slice(start, start + 64)}` as Hex
      const cid = rawCompositionCid(blobSha256)
      return { cid, blob: await fetchSource(cid) }
    })
  )
  const result = verifyCompositionAcceptance(
    params,
    manifestBytes,
    sourcePreimages,
    {
      programId: provenance.programId,
      outputDomain: provenance.outputDomain,
      paramsHash,
      captureCommitment: accumulatorCheckpoint.acc,
      captureCount: accumulatorCheckpoint.leafCount,
      outputRoot: event.args.root,
      outputBlobSha256: event.args.ipfsHash,
      outputCid: event.args.ipfsHashCid,
      totalValue: event.args.totalValue,
      acceptedRoot: acceptedState.root,
      acceptedBlobSha256: acceptedState.ipfsHash,
      acceptedCid: acceptedState.ipfsHashCid,
      acceptedTotalValue: acceptedState.totalValue,
    },
    BigInt(context.chain.id)
  )
  if (bytesToHex(result.outputBlob) !== bytesToHex(outputBytes))
    throw new Error(
      'composition output gateway bytes are not canonical recompute bytes'
    )

  const cryptographicProvenance = {
    program: {
      id: provenance.programId,
      outputDomain: provenance.outputDomain,
      instanceId: provenance.instanceId,
    },
    checkpoint: {
      id: checkpointId.toString(),
      paramsHash,
      captureManifestSha256: result.manifestSha256,
      captureCount: result.sources.length,
    },
    proof: {
      acceptedAtBlock: acceptedProof.acceptedAtBlock.toString(),
      verifier: acceptedProof.verifier,
      verifierCodehash: acceptedProof.verifierCodehash,
      programVKey: acceptedProof.programVKey,
    },
    output: {
      root: result.outputRoot,
      blobSha256: result.outputBlobSha256,
      cid: result.outputCid,
      totalValue: result.totalValue.toString(),
    },
  }
  const governanceProvenance = {
    policyVersion: capture.policyVersion.toString(),
    adapterSetHash: capture.adapterSetHash,
    metadataDigest: policy.metadataDigest,
    policyTxHash: policy.proposedTxHash,
    adapters,
  }
  await offchainDb.transaction(async (tx: any) => {
    const checkpointWhere = (table: {
      merkleSnapshotContract: any
      checkpointId: any
    }) =>
      and(
        eq(table.merkleSnapshotContract, snapshot),
        eq(table.checkpointId, checkpointId)
      )

    // A Ponder replay after a reorg can present the same checkpoint with different accepted
    // commitments. Replace every derived row together so stale fork provenance cannot survive.
    await tx
      .delete(offchainSchema.compositionAttribution)
      .where(checkpointWhere(offchainSchema.compositionAttribution))
    await tx
      .delete(offchainSchema.compositionSource)
      .where(checkpointWhere(offchainSchema.compositionSource))
    await tx
      .delete(offchainSchema.compositionEpoch)
      .where(checkpointWhere(offchainSchema.compositionEpoch))

    for (const [position, source] of result.sources.entries()) {
      const allocation = result.sourceAllocations[position]!
      const adapter = adapters[position]!
      if (!sameHex(adapter.sourceId, source.sourceId))
        throw new Error(
          'composition adapter order conflicts with capture order'
        )
      const decoded = decodeCompositionScoreBlob(
        sourcePreimages[position]!.blob
      )
      await tx.insert(offchainSchema.compositionSource).values({
        merkleSnapshotContract: snapshot,
        root: result.outputRoot,
        checkpointId,
        sourceId: source.sourceId,
        position,
        snapshot: source.snapshot,
        familyId: source.familyId,
        programId: source.programId,
        adapter: adapter.adapter,
        deploymentProvenance: adapter.deploymentProvenance,
        stateIndex: source.stateIndex,
        sourceCheckpointId: BigInt(sourceCheckpointIds[position]!),
        freezeBlock: source.freezeBlock,
        outputRoot: source.outputRoot,
        blobSha256: source.blobSha256,
        cid: sourcePreimages[position]!.cid,
        totalValue: source.totalValue,
        weight: source.weight,
        maxAgeBlocks: source.maxAgeBlocks,
        quota: allocation.quota,
        entryCount: decoded.length,
        blobBytes: sourcePreimages[position]!.blob.length,
        cryptographicallyBound: true,
        governanceAdmitted: true,
      })
    }
    if (result.attribution.length > 0) {
      await tx.insert(offchainSchema.compositionAttribution).values(
        result.attribution.map((entry) => ({
          merkleSnapshotContract: snapshot,
          root: result.outputRoot,
          checkpointId,
          sourceId: entry.sourceId,
          account: entry.account,
          exactValue: entry.exactValue,
          idealNumerator: entry.idealNumerator.toString(),
          idealDenominator: entry.idealDenominator.toString(),
          roundingDeltaNumerator: entry.roundingDeltaNumerator.toString(),
        }))
      )
    }
    // The epoch is the completeness marker and is intentionally written last inside the same
    // transaction. A crash exposes either the prior complete epoch or this complete replacement.
    await tx.insert(offchainSchema.compositionEpoch).values({
      merkleSnapshotContract: snapshot,
      root: event.args.root,
      instanceId: instance.id,
      checkpointId,
      policyVersion: capture.policyVersion,
      paramsHash,
      captureManifestSha256: result.manifestSha256,
      outputBlobSha256: result.outputBlobSha256,
      outputCid: result.outputCid,
      totalValue: result.totalValue,
      work: jsonBigints(result.work),
      metrics: jsonBigints(result.metrics),
      cryptographicProvenance,
      governanceProvenance,
      verifiedAt: event.block.timestamp,
      blockNumber: event.block.number,
      timestamp: event.block.timestamp,
    })
  })
  return result
}

export const compositionEpochExists = async (
  offchainDb: any,
  snapshot: string,
  checkpointId: bigint
) =>
  (
    await offchainDb
      .select()
      .from(offchainSchema.compositionEpoch)
      .where(
        and(
          eq(offchainSchema.compositionEpoch.merkleSnapshotContract, snapshot),
          eq(offchainSchema.compositionEpoch.checkpointId, checkpointId)
        )
      )
      .limit(1)
  ).length > 0
