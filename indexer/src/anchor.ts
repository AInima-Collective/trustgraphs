import { ponder } from 'ponder:registry'
import { anchor, anchorCheckpoint, nodeRegistration } from 'ponder:schema'

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
  const { foldIndex, nodeId, envelopeKind, head, dataCommitment, blockTimestamp } =
    event.args

  await context.db.insert(anchor).values({
    id: event.id,
    address: event.log.address,
    foldIndex,
    nodeId,
    envelopeKind,
    head,
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

// MerkleSnapshot.AnchorsCheckpointed — the lane-2 accumulator frozen at each trigger.
ponder.on('merkleSnapshot:AnchorsCheckpointed', async ({ event, context }) => {
  const { checkpointId, anchorAcc, anchorCount } = event.args

  await context.db.insert(anchorCheckpoint).values({
    checkpointId,
    address: event.log.address,
    anchorAcc,
    anchorCount,
    blockTimestamp: event.block.timestamp,
    txHash: event.transaction.hash,
    blockNumber: event.block.number,
  })
})

/*///////////////////////////////////////////////////////////////
    STUB — skippedNode ingestion (off-chain prover/witness pipeline)
//////////////////////////////////////////////////////////////*/

/**
 * NOT WIRED UP for M2 — intentionally stubbed.
 *
 * The guest commits only a 32-byte `skippedDigest` on-chain (a `MerkleSnapshot.submitProof` argument
 * bound into the journal — it is NOT emitted in any event, and its PREIMAGE is not on-chain at all).
 * The set of skipped nodes and their reasons therefore has to come from the OFF-CHAIN prover/witness
 * bundle that the prover archives (MULTI_PROGRAM_PLATFORM §7 — the indexer is the availability mirror).
 *
 * Wiring this up (a later milestone) means:
 *   1. Read the prover's witness bundle for a given `checkpointId` (skipped nodeIds + reason labels).
 *   2. Recover the on-chain `skippedDigest` for that checkpoint by decoding the `submitProof` calldata
 *      of the tx that emitted `MerkleProofSubmitted` / `MerkleRootUpdated` (the digest is a calldata
 *      argument, not an event field).
 *   3. Reconstruct the digest from the bundled skipped set using the frozen four-way-golden leaf/fold
 *      encoding and assert it equals the on-chain `skippedDigest` before trusting the rows.
 *   4. Upsert the validated rows into `offchain.skipped_node` with `validated = true`.
 *
 * Left as a documented no-op so the audit table exists and its provenance is unambiguous.
 */
export async function ingestSkippedNodes(_checkpointId: bigint): Promise<void> {
  // TODO(lane-2): implement off-chain bundle read + on-chain skippedDigest validation (see above).
  return
}
