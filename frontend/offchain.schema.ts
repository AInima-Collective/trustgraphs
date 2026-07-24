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
    totalValue: t
      .numeric({ precision: 78, scale: 0, mode: 'bigint' })
      .notNull(),
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

// hypercertsMetadata — per-root journal fields for the hypercerts (lane-2) instance. The `merkle_metadata`
// twin, but keyed to the hypercerts snapshot and carrying the lane-2 journal fields the trust-graph
// metadata table doesn't have (`skippedDigest`, `anchorAcc`, `anchorCount`). Populated by the OFF-CHAIN
// prover/witness pipeline (the guest commits only the journal digest on-chain; the nodeId→score preimage
// and its skipped set come from the archived blob) and validated against the on-chain `outputRoot` —
// same provenance discipline as `skipped_node`. Ingestion is stubbed for now (see
// `ingestHypercertsScores` in src/anchor.ts); the bundle API reads these rows.
export const hypercertsMetadata = offchainSchema.table(
  'hypercerts_metadata',
  (t) => ({
    merkleSnapshotContract: t.text().notNull(),
    root: t.text().notNull(), // the on-chain outputRoot (hex)
    ipfsHash: t.text().notNull(),
    ipfsHashCid: t.text().notNull(),
    numNodes: t.integer().notNull(),
    // uint256-scale total distributed value; numeric(78,0), not int8 (overflows above ~9.2e18).
    totalValue: t
      .numeric({ precision: 78, scale: 0, mode: 'bigint' })
      .notNull(),
    // Journal v2 lane-2 commitments (32-byte hex) — served in the bundle for auditability.
    skippedDigest: t.text().notNull(),
    anchorAcc: t.text().notNull(),
    anchorCount: t.bigint({ mode: 'bigint' }).notNull(),
    blockNumber: t.bigint({ mode: 'bigint' }).notNull(),
    timestamp: t.bigint({ mode: 'bigint' }).notNull(),
  }),
  (t) => [
    primaryKey({ columns: [t.merkleSnapshotContract, t.root] }),
    index().on(t.root),
    index().on(t.ipfsHashCid),
    index().on(t.timestamp),
  ]
)

// hypercertsScore — the `merkle_entry` twin for the hypercerts instance, keyed by 32-byte nodeId
// (`keccak256(did)` for actors, `keccak256("at://did/coll/rkey")` for artifacts) instead of a 20-byte
// address. `boundAddress` is the verified `link.evm` binding (nullable); when present it earns the extra
// v1 address leaf in the output tree so address-keyed consumers verify against the same root. `proof`
// may be precomputed at ingestion (like `merkle_entry`); if null, the bundle API rebuilds the tree from
// the full score set for the root and derives the proof on the fly (both yield the same OZ proof).
export const hypercertsScore = offchainSchema.table(
  'hypercerts_score',
  (t) => ({
    merkleSnapshotContract: t.text().notNull(),
    root: t.text().notNull(),
    nodeId: t.text().notNull(),
    // uint256-scale per-node score; numeric(78,0).
    value: t.numeric({ precision: 78, scale: 0, mode: 'bigint' }).notNull(),
    // Display label from the prover sidecar, integrity-checked at ingestion
    // (`keccak256(did) == nodeId`), or null for artifact/unlabeled nodes.
    did: t.text(),
    // The verified link.evm binding (hex address), or null for satellite/artifact nodes.
    boundAddress: t.text(),
    // Optional precomputed OZ proof; null ⇒ the API derives it from the root's full score set.
    proof: t.jsonb().$type<string[]>(),
    blockNumber: t.bigint({ mode: 'bigint' }).notNull(),
    timestamp: t.bigint({ mode: 'bigint' }).notNull(),
  }),
  (t) => [
    primaryKey({ columns: [t.merkleSnapshotContract, t.root, t.nodeId] }),
    index().on(t.root),
    index().on(t.nodeId),
    index().on(t.boundAddress),
    index().on(t.timestamp),
  ]
)

/*///////////////////////////////////////////////////////////////
          CONTRIBUTIONS PROGRAM — derived scoring (M3)
//////////////////////////////////////////////////////////////*/

// contributionRound — per-(snapshot, root) round metadata for the contributions program: the
// journal commitments, the validated params snapshot, and the verification verdict of the display
// recompute. Populated on `MerkleRootUpdated` by `ingestContributionsScores` (src/contributions.ts):
// the indexer re-derives the FULL stage-2 computation from its own fold-log rows (truncated to the
// checkpointed leaf counts) + the params sidecar, and only writes score/audit rows when the
// recomputed output root equals the proven on-chain root. `verified = false` rows exist so the API
// can answer 409 ("refuse to serve") instead of silently serving nothing — the recompute is a
// display validation, never a second source of truth.
export const contributionRound = offchainSchema.table(
  'contribution_round',
  (t) => ({
    merkleSnapshotContract: t.text().notNull(),
    root: t.text().notNull(), // the on-chain outputRoot (hex)
    checkpointId: t.text().notNull(), // uint256 as decimal string
    ipfsHash: t.text().notNull(),
    ipfsHashCid: t.text().notNull(),
    // Journal v2 input commitments: slot A = trust accumulator, slot B = contribution accumulator.
    trustAcc: t.text().notNull(),
    trustLeafCount: t.bigint({ mode: 'bigint' }).notNull(),
    anchorAcc: t.text().notNull(),
    anchorCount: t.bigint({ mode: 'bigint' }).notNull(),
    paramsHash: t.text().notNull(),
    // The validated params snapshot (bigints as decimal strings), from the params sidecar whose
    // hash reproduced the on-chain paramsHash. Null when the sidecar was missing/invalid.
    params: t.jsonb().$type<Record<string, unknown> | null>(),
    // uint64 unix seconds (null without valid params). numeric(78,0), NOT int8: an open-ended
    // round pins roundEnd = u64::MAX (1.8e19), which overflows Postgres bigint (~9.2e18).
    roundStart: t.numeric({ precision: 78, scale: 0, mode: 'bigint' }),
    roundEnd: t.numeric({ precision: 78, scale: 0, mode: 'bigint' }),
    // uint256-scale pool/total; numeric(78,0) per the offchain big-value rule.
    totalPool: t.numeric({ precision: 78, scale: 0, mode: 'bigint' }),
    totalValue: t
      .numeric({ precision: 78, scale: 0, mode: 'bigint' })
      .notNull(),
    numClaims: t.integer().notNull(), // live in-window claims in the recompute (0 if unverified)
    numRecipients: t.integer().notNull(), // payout leaves (0 if unverified)
    // Whether the display recompute reproduced the proven root (score/audit rows only exist when
    // true); `failureReason` explains a false verdict for operators.
    verified: t.boolean().notNull(),
    failureReason: t.text(),
    blockNumber: t.bigint({ mode: 'bigint' }).notNull(),
    timestamp: t.bigint({ mode: 'bigint' }).notNull(),
  }),
  (t) => [
    primaryKey({ columns: [t.merkleSnapshotContract, t.root] }),
    index().on(t.root),
    index().on(t.ipfsHashCid),
    index().on(t.timestamp),
  ]
)

// contributionScore — S(c) per (snapshot, root, claim), plus the per-contributor payout breakdown
// (attribution share, consent multiplier, and resulting weight — everything the round view needs to
// explain a payout in plain language). All *Fp values are fixed point scaled by the round's
// precisionScale (1e18), stored as numeric(78,0). Only written when the recompute verified.
export const contributionScore = offchainSchema.table(
  'contribution_score',
  (t) => ({
    merkleSnapshotContract: t.text().notNull(),
    root: t.text().notNull(),
    claimUid: t.text().notNull(),
    // S(c): the rep-weighted budgeted claim score, fixed point.
    scoreFp: t.numeric({ precision: 78, scale: 0, mode: 'bigint' }).notNull(),
    // Per-contributor breakdown: raw aggregated share, normalized attribution (fp), consent
    // multiplier applied (fp: S = accepted/self, unacceptedMultFp = no response, 0 = rejected),
    // and the resulting pre-carve-out payout weight (fp). Decimal strings inside the JSON.
    contributors: t.jsonb().notNull().$type<
      {
        contributor: string
        share: string
        attribFp: string
        consentFp: string
        weightFp: string
      }[]
    >(),
    blockNumber: t.bigint({ mode: 'bigint' }).notNull(),
    timestamp: t.bigint({ mode: 'bigint' }).notNull(),
  }),
  (t) => [
    primaryKey({ columns: [t.merkleSnapshotContract, t.root, t.claimUid] }),
    index().on(t.root),
    index().on(t.claimUid),
  ]
)

// contributionValuationAudit — why each live valuation counted, was discounted, or was filtered at
// a given root (the honest-UI audit surface: research/CONTRIBUTION_FUNDING.md §5). One row per
// (root, claim, rater) live valuation from the guest-identical eligibility partition:
//   status 'counted'    — eligible at full weight
//   status 'discounted' — eligible, collaborator-discounted (discountFp = collaboratorMultFp)
//   status 'filtered'   — skipped, with reason 'selfValuation' | 'belowMinRep'
export const contributionValuationAudit = offchainSchema.table(
  'contribution_valuation_audit',
  (t) => ({
    merkleSnapshotContract: t.text().notNull(),
    root: t.text().notNull(),
    claimUid: t.text().notNull(),
    rater: t.text().notNull(),
    score: t.integer().notNull(), // the live (post-LWW) 0–100 score
    status: t.text().notNull(), // 'counted' | 'discounted' | 'filtered'
    reason: t.text(), // skip reason when filtered: 'selfValuation' | 'belowMinRep'
    // The applied discount (fp; precisionScale = none, collaboratorMultFp = discounted). Null when
    // filtered (the valuation contributed nothing).
    discountFp: t.numeric({ precision: 78, scale: 0, mode: 'bigint' }),
    // The rater's stage-1 reputation (fp) — context for "weighted by standing" copy.
    raterRepFp: t
      .numeric({ precision: 78, scale: 0, mode: 'bigint' })
      .notNull(),
    updatedAt: t.bigint({ mode: 'bigint' }).notNull(),
  }),
  (t) => [
    primaryKey({
      columns: [t.merkleSnapshotContract, t.root, t.claimUid, t.rater],
    }),
    index().on(t.root),
    index().on(t.claimUid),
    index().on(t.rater),
    index().on(t.status),
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
