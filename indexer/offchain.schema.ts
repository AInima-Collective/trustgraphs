import { index, pgSchema, primaryKey } from 'drizzle-orm/pg-core'

export const offchainSchema = pgSchema('offchain')

export const merkleMetadata = offchainSchema.table(
  'merkle_metadata',
  (t) => ({
    merkleSnapshotContract: t.text().notNull(),
    root: t.text().notNull(),
    ipfsHash: t.text().notNull(),
    ipfsHashCid: t.text().notNull(),
    numAccounts: t.integer().notNull(),
    // uint256-scale (the reward pool can exceed 1e18); Postgres bigint (int8) is only 64-bit, so use
    // numeric(78,0) — same convention Ponder uses for its own bigint columns.
    totalValue: t.numeric({ precision: 78, scale: 0, mode: 'bigint' }).notNull(),
    sources: t.jsonb().notNull().$type<
      {
        name: string
        metadata: any
      }[]
    >(),
    blockNumber: t.bigint({ mode: 'bigint' }).notNull(),
    timestamp: t.bigint({ mode: 'bigint' }).notNull(),
  }),
  (t) => [
    primaryKey({ columns: [t.merkleSnapshotContract, t.root] }),
    index().on(t.root),
    index().on(t.ipfsHashCid),
    index().on(t.blockNumber),
    index().on(t.timestamp),
  ]
)

export const merkleEntry = offchainSchema.table(
  'merkle_entry',
  (t) => ({
    merkleSnapshotContract: t.text().notNull(),
    root: t.text().notNull(),
    account: t.text().notNull(),
    ipfsHashCid: t.text().notNull(),
    // uint256-scale per-account score; numeric(78,0), not int8 (which overflows above ~9.2e18).
    value: t.numeric({ precision: 78, scale: 0, mode: 'bigint' }).notNull(),
    proof: t.jsonb().notNull().$type<string[]>(),
    blockNumber: t.bigint({ mode: 'bigint' }).notNull(),
    timestamp: t.bigint({ mode: 'bigint' }).notNull(),
  }),
  (t) => [
    primaryKey({ columns: [t.merkleSnapshotContract, t.root, t.account] }),
    index().on(t.root),
    index().on(t.account),
    index().on(t.ipfsHashCid),
    index().on(t.blockNumber),
    index().on(t.timestamp),
    index().on(t.account, t.timestamp),
  ]
)

// skippedNode — the rule-Φ / deterministic-skip audit trail for lane 2 (OFFCHAIN_ATTESTATIONS_ZK §4.3,
// MULTI_PROGRAM_PLATFORM §5). The guest commits only a 32-byte `skippedDigest` on-chain (a submitProof
// argument bound into the journal); the PREIMAGE — which nodes were skipped, and why — is NOT on-chain.
// These rows are therefore populated by the OFF-CHAIN prover/witness pipeline (the witness bundle the
// prover archives) and then VALIDATED against the on-chain `skippedDigest` for the matching checkpoint.
// This is an `offchain` (non-Ponder) table because its source is that pipeline, not a chain event.
// Ingestion is stubbed for M2 — see `ingestSkippedNodes` in src/anchor.ts.
export const skippedNode = offchainSchema.table(
  'skipped_node',
  (t) => ({
    // A node can be skipped in more than one checkpoint, so key on (checkpointId, nodeId).
    checkpointId: t.text().notNull(), // uint256 as decimal string
    nodeId: t.text().notNull(),
    reason: t.text().notNull(), // guest skip-rule label (e.g. "bad-signature", "stale-head")
    epochObserved: t.bigint({ mode: 'bigint' }).notNull(), // input-freeze block / epoch the skip applies to
    // Whether the reconstructed digest of the full skipped set validated against the on-chain
    // skippedDigest for this checkpoint (null until the validation hook runs).
    validated: t.boolean(),
    updatedAt: t.bigint({ mode: 'bigint' }).notNull(),
  }),
  (t) => [
    primaryKey({ columns: [t.checkpointId, t.nodeId] }),
    index().on(t.checkpointId),
    index().on(t.nodeId),
    index().on(t.reason),
  ]
)

export const localismFundApplication = offchainSchema.table(
  'localism_fund_application',
  (t) => ({
    address: t.text().primaryKey(),
    url: t.text().notNull(),
    updatedAt: t.bigint({ mode: 'bigint' }).notNull(),
  }),
  (t) => [index().on(t.url)]
)
