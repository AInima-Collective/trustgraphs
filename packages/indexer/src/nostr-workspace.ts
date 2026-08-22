import { readFileSync } from 'node:fs'

import { sql } from 'drizzle-orm'
import { type Address, type Hex, decodeFunctionData } from 'viem'

import { merkleSnapshotAbi } from '../../frontend/lib/contract-abis'
import * as offchainSchema from '../offchain.schema'
import { offchainDb } from './api/db'
import { nodeOutputLeaf, proofFor } from './api/hypercerts-tree'
import {
  type NostrArchiveVariant,
  type NostrIndexerSidecar,
  nostrEpochTrustClass,
  validateNostrScoreCommitment,
  validateNostrWorkspaceSidecar,
} from './nostr-workspace-shared'
import type { ScoreProgramProvenance } from './score-program'

const ZERO32 = `0x${'00'.repeat(32)}` as Hex

type ArchiveManifest = {
  accessPolicy: 'public' | 'member-scoped' | 'private-operator'
  commitmentVariant: NostrArchiveVariant
  dataCommitment: Hex
  count: number
  head: Hex
  cid: string
  eventIds: string[]
}

type AssemblyReceipt = {
  format: 'trustgraphs.nostr.guest-input-manifest.v1'
  checkpoint: number
  paramsHash: Hex
  guestInputSha256: Hex
  sourceManifests: string[]
  selectedCommitments: Hex[]
  duplicateEventIds: string[]
}

const readJson = <T>(path: string, label: string): T => {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T
  } catch (error) {
    throw new Error(`${label} ${path} is unavailable or malformed: ${error}`)
  }
}

const loadSidecar = (): NostrIndexerSidecar => {
  const path = process.env.NOSTR_WORKSPACE_SIDECAR_PATH
  if (!path) {
    throw new Error(
      'NOSTR_WORKSPACE_SIDECAR_PATH is required: scoped actor/binding provenance is not inferred from public score bytes'
    )
  }
  return readJson<NostrIndexerSidecar>(path, 'Nostr workspace sidecar')
}

const loadArchiveProvenance = () => {
  const path = process.env.NOSTR_WORKSPACE_ASSEMBLY_MANIFEST_PATH
  if (!path) {
    throw new Error(
      'NOSTR_WORKSPACE_ASSEMBLY_MANIFEST_PATH is required for redacted archive/access provenance'
    )
  }
  const receipt = readJson<AssemblyReceipt>(path, 'Nostr assembly receipt')
  if (receipt.format !== 'trustgraphs.nostr.guest-input-manifest.v1') {
    throw new Error(
      `unsupported Nostr assembly receipt format ${receipt.format}`
    )
  }
  const archives = receipt.sourceManifests.map((manifestPath) =>
    readJson<ArchiveManifest>(manifestPath, 'Nostr archive manifest')
  )
  if (archives.length === 0)
    throw new Error('Nostr assembly selected no archives')
  const commitments = archives.map((archive) =>
    archive.dataCommitment.toLowerCase()
  )
  if (
    commitments.length !== receipt.selectedCommitments.length ||
    commitments.some(
      (commitment, index) =>
        commitment !== receipt.selectedCommitments[index]?.toLowerCase()
    )
  ) {
    throw new Error(
      'Nostr archive manifests disagree with the assembly receipt'
    )
  }
  const policies = new Set(archives.map((archive) => archive.accessPolicy))
  if (policies.size !== 1) {
    throw new Error('one Nostr epoch cannot mix archive access policies')
  }
  const variants = archives.map((archive) => archive.commitmentVariant)
  const epochTrustClass = nostrEpochTrustClass(variants)
  return {
    checkpointId: BigInt(receipt.checkpoint),
    accessPolicy: archives[0]!.accessPolicy,
    epochTrustClass,
    publicValue: {
      paramsHash: receipt.paramsHash,
      guestInputSha256: receipt.guestInputSha256,
      selectedCommitments: receipt.selectedCommitments,
      duplicateEventIds: receipt.duplicateEventIds,
      archives: archives.map((archive) => ({
        accessPolicy: archive.accessPolicy,
        commitmentVariant: archive.commitmentVariant,
        dataCommitment: archive.dataCommitment,
        count: archive.count,
        head: archive.head,
        cid: archive.cid,
        eventIds: archive.eventIds,
      })),
    },
  }
}

const journalLane2 = async (event: any, context: any) => {
  let checkpointId = 0n
  let skipped = ZERO32
  try {
    const decoded = decodeFunctionData({
      abi: merkleSnapshotAbi,
      data: event.transaction.input as Hex,
    })
    if (decoded.functionName !== 'submitProof') {
      throw new Error(`unexpected submission function ${decoded.functionName}`)
    }
    const args = decoded.args as readonly unknown[]
    checkpointId = args[0] as bigint
    skipped = args[5] as Hex
  } catch (error) {
    throw new Error(`cannot recover Nostr journal calldata: ${error}`)
  }
  const checkpoint = (await context.client.readContract({
    address: event.log.address as Address,
    abi: merkleSnapshotAbi,
    functionName: 'anchorCheckpoints',
    args: [checkpointId],
  })) as readonly [Hex, bigint]
  return {
    checkpointId,
    skippedDigest: skipped,
    anchorAcc: checkpoint[0],
    anchorCount: checkpoint[1],
  }
}

/** Ingest only after program/output-domain authentication selected this decoder. */
export async function ingestNostrWorkspaceScores(
  scores: Record<string, string>,
  event: any,
  context: any,
  root: Hex,
  ipfsHash: Hex,
  ipfsHashCid: string,
  totalValue: bigint,
  outputBytes: Uint8Array,
  provenance: ScoreProgramProvenance
): Promise<void> {
  validateNostrScoreCommitment(
    scores,
    outputBytes,
    ipfsHash,
    ipfsHashCid,
    totalValue
  )
  const sidecar = loadSidecar()
  const archive = loadArchiveProvenance()
  const lane2 = await journalLane2(event, context)
  if (archive.checkpointId !== lane2.checkpointId) {
    throw new Error('Nostr assembly receipt belongs to a different checkpoint')
  }
  const { rows, tree, skipSummary } = validateNostrWorkspaceSidecar(
    scores,
    sidecar,
    root,
    lane2.skippedDigest
  )
  const snapshot = (event.log.address as string).toLowerCase()
  await offchainDb
    .insert(offchainSchema.nostrWorkspaceMetadata)
    .values({
      merkleSnapshotContract: snapshot,
      root,
      checkpointId: lane2.checkpointId,
      ipfsHash,
      ipfsHashCid,
      numNodes: rows.length,
      totalValue,
      skippedDigest: lane2.skippedDigest,
      anchorAcc: lane2.anchorAcc,
      anchorCount: lane2.anchorCount,
      accessPolicy: archive.accessPolicy,
      epochTrustClass: archive.epochTrustClass,
      reducedRecomputeStatus: 'production-core-and-output-root-reproduced',
      skipSummary,
      archiveProvenance: archive.publicValue,
      blockNumber: event.block.number,
      timestamp: event.block.timestamp,
      programId: provenance.programId,
      outputDomain: provenance.outputDomain,
      programProvenance: provenance,
    })
    .onConflictDoUpdate({
      target: [
        offchainSchema.nostrWorkspaceMetadata.merkleSnapshotContract,
        offchainSchema.nostrWorkspaceMetadata.root,
      ],
      set: {
        programId: sql.raw(
          `excluded."${offchainSchema.nostrWorkspaceMetadata.programId.name}"`
        ),
        outputDomain: sql.raw(
          `excluded."${offchainSchema.nostrWorkspaceMetadata.outputDomain.name}"`
        ),
        programProvenance: sql.raw(
          `excluded."${offchainSchema.nostrWorkspaceMetadata.programProvenance.name}"`
        ),
        archiveProvenance: sql.raw(
          `excluded."${offchainSchema.nostrWorkspaceMetadata.archiveProvenance.name}"`
        ),
        reducedRecomputeStatus: sql.raw(
          `excluded."${offchainSchema.nostrWorkspaceMetadata.reducedRecomputeStatus.name}"`
        ),
      },
    })

  await offchainDb
    .insert(offchainSchema.nostrWorkspaceScore)
    .values(
      rows.map((row) => ({
        merkleSnapshotContract: snapshot,
        root,
        nodeId: row.nodeId,
        value: row.value,
        nostrPubkey: row.nostrPubkey,
        actorKind: row.actorKind,
        ownerNodeId: row.ownerNodeId,
        boundAddress: row.boundAddress,
        proof: proofFor(tree, nodeOutputLeaf(row.nodeId, row.value)) ?? [],
        blockNumber: event.block.number,
        timestamp: event.block.timestamp,
        programId: provenance.programId,
        outputDomain: provenance.outputDomain,
      }))
    )
    .onConflictDoNothing()
}
