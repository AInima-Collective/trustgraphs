import { readFileSync } from 'node:fs'

import { sql } from 'drizzle-orm'
import { ponder } from 'ponder:registry'
import { anchor, anchorCheckpoint, nodeRegistration } from 'ponder:schema'
import { type Hex, decodeFunctionData, keccak256, stringToHex } from 'viem'

import { merkleSnapshotAbi } from '../../frontend/lib/contract-abis'
import * as offchainSchema from '../offchain.schema'
import { offchainDb } from './api/db'
import {
  type ScoreRow,
  buildTree,
  leafSet,
  nodeOutputLeaf,
  proofFor,
} from './api/hypercerts-tree'
import type { ScoreProgramProvenance } from './score-program'
import { type SharedArgs } from './utils'

/**
 * Lane-2 (offchain-attestation) handlers — MULTI_PROGRAM_PLATFORM §5, OFFCHAIN_ATTESTATIONS_ZK §4.
 *
 * The `AnchorRegistry` is a chained-hash log of per-identity head anchors (the AttestationAccumulator
 * pattern lifted one level up). We index the two anchor-registry events and the MerkleSnapshot event
 * that freezes the lane-2 accumulator at each snapshot boundary. Single instance for M2 — the
 * multi-instance `instanceId` dimension is deferred to M4/M5.
 */

// AnchorRegistry.HeadAnchored — every anchor claim, in fold order.
ponder.on('anchorRegistry:HeadAnchored', async ({ event, context }) => {
  const {
    foldIndex,
    nodeId,
    envelopeKind,
    head,
    count,
    dataCommitment,
    blockTimestamp,
  } = event.args

  await context.db.insert(anchor).values({
    id: event.id,
    address: event.log.address,
    foldIndex,
    nodeId,
    envelopeKind,
    head,
    count,
    dataCommitment,
    blockTimestamp,
    txHash: event.transaction.hash,
    blockNumber: event.block.number,
  })
})

// AnchorRegistry.NodeRegistered — a node joined the registry (once per node).
ponder.on('anchorRegistry:NodeRegistered', async ({ event, context }) => {
  const { nodeId, kind, registrant } = event.args

  await context.db.insert(nodeRegistration).values({
    nodeId,
    address: event.log.address,
    kind,
    registrant,
    at: event.block.timestamp,
    txHash: event.transaction.hash,
    blockNumber: event.block.number,
  })
})

// MerkleSnapshot.AnchorsCheckpointed — the lane-2 accumulator frozen at each trigger. Registered on
// both snapshot sources: `merkleSnapshot` is the factory-discovered trust-graph instances (which
// emit it with zeros, having no AnchorRegistry) and `programSnapshot` the statically-deployed
// contributions/hypercerts instances (see packages/indexer/ponder.config.ts).
const onAnchorsCheckpointed = async ({
  event,
  context,
}: SharedArgs<'merkleSnapshot:AnchorsCheckpointed'>) => {
  const { checkpointId, anchorAcc, anchorCount } = event.args

  await context.db.insert(anchorCheckpoint).values({
    checkpointId,
    address: event.log.address,
    anchorAcc,
    anchorCount,
    workCount: anchorCount,
    blockTimestamp: event.block.timestamp,
    txHash: event.transaction.hash,
    blockNumber: event.block.number,
  })
}

ponder.on('merkleSnapshot:AnchorsCheckpointed', onAnchorsCheckpointed)
ponder.on('programSnapshot:AnchorsCheckpointed', onAnchorsCheckpointed)
ponder.on(
  'contributionsMerkleSnapshot:AnchorsCheckpointed',
  onAnchorsCheckpointed
)

const onAnchorWorkCheckpointed = async ({
  event,
  context,
}: SharedArgs<'merkleSnapshot:AnchorWorkCheckpointed'>) => {
  const checkpoint = await context.db.find(anchorCheckpoint, {
    address: event.log.address,
    checkpointId: event.args.checkpointId,
  })
  if (!checkpoint) {
    console.warn(
      `anchor: work checkpoint ${event.args.checkpointId} has no preceding anchor checkpoint`
    )
    return
  }
  await context.db
    .update(anchorCheckpoint, {
      address: event.log.address,
      checkpointId: event.args.checkpointId,
    })
    .set({ workCount: event.args.workCount })
}

ponder.on('merkleSnapshot:AnchorWorkCheckpointed', onAnchorWorkCheckpointed)
ponder.on('programSnapshot:AnchorWorkCheckpointed', onAnchorWorkCheckpointed)
ponder.on(
  'contributionsMerkleSnapshot:AnchorWorkCheckpointed',
  onAnchorWorkCheckpointed
)

/*///////////////////////////////////////////////////////////////
    Hypercerts score ingestion (off-chain prover/witness pipeline)
//////////////////////////////////////////////////////////////*/

/**
 * The prover's ingestion sidecar (`hypercerts_bundle.json`, written by `hypercerts execute`/`prove`):
 * node labels + verified `link.evm` bindings. Availability, not truth — the bindings feed the tree
 * rebuild whose root MUST reproduce the on-chain `outputRoot` before any row is trusted, and the DIDs
 * are display labels (`keccak256(did)` must equal the nodeId or the label is dropped).
 */
interface HypercertsBundle {
  dids?: Record<string, string>
  bindings?: Record<string, string>
}

const loadBundle = (): HypercertsBundle => {
  const path = process.env.HYPERCERTS_BUNDLE_PATH
  if (!path) return {}
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as HypercertsBundle
  } catch (e) {
    console.warn(`hypercerts: could not read bundle at ${path}: ${e}`)
    return {}
  }
}

/**
 * Ingest one hypercerts `MerkleRootUpdated` into `offchain.hypercerts_metadata` +
 * `offchain.hypercerts_score` (the rows the `{nodeId, score, proof[]}` bundle API serves):
 *
 *   1. The caller (merkle.ts) fetched the canonical nodeId-keyed blob from IPFS at the event's
 *      `ipfsHashCid` (`{ "0x<nodeId>": "<decimal>", … }`, hypercerts_core::compute::canonical_blob)
 *      after the authenticated InstanceRegistry binding selected this decoder.
 *   2. `link.evm` bindings (nodeId → address) + DID labels come from the prover's sidecar
 *      (`HYPERCERTS_BUNDLE_PATH`); the journal's `checkpointId`/`skippedDigest` are decoded from the
 *      `submitProof` calldata, and the lane-2 checkpoint (`anchorAcc`, `anchorCount`) is read from
 *      chain state.
 *   3. Rebuild the guest's exact OZ output tree (unified nodeId leaves + v1 address leaves for bound
 *      nodes — src/api/hypercerts-tree.ts) and assert its root equals the on-chain `outputRoot`
 *      before trusting the rows (mirrors the `merkle.ts` root cross-check).
 *   4. Upsert `hypercerts_metadata` (root + journal fields) and `hypercerts_score` (per-node value,
 *      DID label, boundAddress, precomputed proof).
 */
export async function ingestHypercertsScores(
  scores: Record<string, string>,
  event: any,
  context: any,
  root: string,
  ipfsHash: string,
  ipfsHashCid: string,
  totalValue: bigint,
  provenance: ScoreProgramProvenance
): Promise<void> {
  const snapshot = event.log.address as Hex

  // Journal fields not present in the event: checkpointId + skippedDigest from the submitProof
  // calldata of the same tx, then the frozen lane-2 checkpoint from chain state.
  let skippedDigest: Hex = `0x${'00'.repeat(32)}`
  let anchorAcc: Hex = `0x${'00'.repeat(32)}`
  let anchorCount = 0n
  try {
    const decoded = decodeFunctionData({
      abi: merkleSnapshotAbi,
      data: event.transaction.input as Hex,
    })
    if (decoded.functionName === 'submitProof') {
      const [checkpointId, , , , , digest] = decoded.args as unknown as [
        bigint,
        Hex,
        Hex,
        string,
        bigint,
        Hex,
        Hex,
      ]
      skippedDigest = digest
      const ac = (await context.client.readContract({
        address: snapshot,
        abi: merkleSnapshotAbi,
        functionName: 'anchorCheckpoints',
        args: [checkpointId],
      })) as readonly [Hex, bigint]
      anchorAcc = ac[0]
      anchorCount = ac[1]
    }
  } catch (e) {
    console.warn(`hypercerts: could not decode submitProof calldata: ${e}`)
  }

  // Bindings + labels from the prover sidecar; the tree cross-check below decides trust.
  const bundle = loadBundle()
  const bindings = new Map(
    Object.entries(bundle.bindings ?? {}).map(([k, v]) => [
      k.toLowerCase(),
      v as Hex,
    ])
  )
  // A DID label is only kept if it actually hashes to its nodeId — the sidecar is unauthenticated.
  const dids = new Map(
    Object.entries(bundle.dids ?? {})
      .filter(([nodeId, did]) => {
        const ok =
          keccak256(stringToHex(did)).toLowerCase() === nodeId.toLowerCase()
        if (!ok) {
          console.warn(
            `hypercerts: bundle DID ${did} does not hash to ${nodeId}; dropping label`
          )
        }
        return ok
      })
      .map(([k, v]) => [k.toLowerCase(), v])
  )

  const rows: ScoreRow[] = Object.entries(scores).map(([nodeId, value]) => ({
    nodeId: nodeId as Hex,
    value: BigInt(value),
    boundAddress: bindings.get(nodeId.toLowerCase()) ?? null,
  }))

  // Rebuild the guest's exact output tree; a mismatch means the pinned blob (or the sidecar's
  // bindings) do not reproduce the proven root — store metadata, never the rows.
  const tree = buildTree(leafSet(rows))
  const rootMatches =
    tree.length === 0 || tree[0]?.toLowerCase() === root.toLowerCase()
  if (!rootMatches) {
    console.warn(
      `hypercerts: recomputed root ${tree[0]} != on-chain root ${root} for cid ${ipfsHashCid}; skipping score rows`
    )
  }

  await offchainDb
    .insert(offchainSchema.hypercertsMetadata)
    .values({
      merkleSnapshotContract: snapshot,
      root,
      ipfsHash,
      ipfsHashCid,
      numNodes: rows.length,
      totalValue,
      skippedDigest,
      anchorAcc,
      anchorCount,
      blockNumber: event.block.number,
      timestamp: event.block.timestamp,
      programId: provenance.programId,
      outputDomain: provenance.outputDomain,
      programProvenance: provenance,
    })
    .onConflictDoUpdate({
      target: [
        offchainSchema.hypercertsMetadata.merkleSnapshotContract,
        offchainSchema.hypercertsMetadata.root,
      ],
      set: {
        ipfsHash: sql.raw(
          `excluded."${offchainSchema.hypercertsMetadata.ipfsHash.name}"`
        ),
        ipfsHashCid: sql.raw(
          `excluded."${offchainSchema.hypercertsMetadata.ipfsHashCid.name}"`
        ),
        numNodes: sql.raw(
          `excluded."${offchainSchema.hypercertsMetadata.numNodes.name}"`
        ),
        totalValue: sql.raw(
          `excluded."${offchainSchema.hypercertsMetadata.totalValue.name}"`
        ),
        skippedDigest: sql.raw(
          `excluded."${offchainSchema.hypercertsMetadata.skippedDigest.name}"`
        ),
        anchorAcc: sql.raw(
          `excluded."${offchainSchema.hypercertsMetadata.anchorAcc.name}"`
        ),
        anchorCount: sql.raw(
          `excluded."${offchainSchema.hypercertsMetadata.anchorCount.name}"`
        ),
        blockNumber: sql.raw(
          `excluded."${offchainSchema.hypercertsMetadata.blockNumber.name}"`
        ),
        timestamp: sql.raw(
          `excluded."${offchainSchema.hypercertsMetadata.timestamp.name}"`
        ),
        programId: sql.raw(
          `excluded."${offchainSchema.hypercertsMetadata.programId.name}"`
        ),
        outputDomain: sql.raw(
          `excluded."${offchainSchema.hypercertsMetadata.outputDomain.name}"`
        ),
        programProvenance: sql.raw(
          `excluded."${offchainSchema.hypercertsMetadata.programProvenance.name}"`
        ),
      },
    })

  if (rows.length === 0 || !rootMatches) {
    return
  }

  await offchainDb
    .insert(offchainSchema.hypercertsScore)
    .values(
      rows.map((r) => ({
        merkleSnapshotContract: snapshot,
        root,
        nodeId: r.nodeId,
        value: r.value,
        did: dids.get(r.nodeId.toLowerCase()) ?? null,
        boundAddress: r.boundAddress ?? null,
        proof: proofFor(tree, nodeOutputLeaf(r.nodeId, r.value)) ?? [],
        blockNumber: event.block.number,
        timestamp: event.block.timestamp,
        programId: provenance.programId,
        outputDomain: provenance.outputDomain,
      }))
    )
    .onConflictDoUpdate({
      target: [
        offchainSchema.hypercertsScore.merkleSnapshotContract,
        offchainSchema.hypercertsScore.root,
        offchainSchema.hypercertsScore.nodeId,
      ],
      set: {
        value: sql.raw(
          `excluded."${offchainSchema.hypercertsScore.value.name}"`
        ),
        did: sql.raw(`excluded."${offchainSchema.hypercertsScore.did.name}"`),
        boundAddress: sql.raw(
          `excluded."${offchainSchema.hypercertsScore.boundAddress.name}"`
        ),
        proof: sql.raw(
          `excluded."${offchainSchema.hypercertsScore.proof.name}"`
        ),
        blockNumber: sql.raw(
          `excluded."${offchainSchema.hypercertsScore.blockNumber.name}"`
        ),
        timestamp: sql.raw(
          `excluded."${offchainSchema.hypercertsScore.timestamp.name}"`
        ),
        programId: sql.raw(
          `excluded."${offchainSchema.hypercertsScore.programId.name}"`
        ),
        outputDomain: sql.raw(
          `excluded."${offchainSchema.hypercertsScore.outputDomain.name}"`
        ),
      },
    })
}
