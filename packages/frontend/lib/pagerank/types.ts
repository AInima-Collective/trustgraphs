import { type Hex } from 'viem'

export type { Hex }

/**
 * A single folded edge, in accumulator fold order. Mirrors `pagerank_core::RawEdge`.
 * `data` is the raw EAS attestation ABI-encoded `data` (preimage of `dataHash = keccak256(data)`);
 * the confidence (weight) is decoded from it at `Params.weightFieldIndex`.
 */
export interface RawEdge {
  /** 0 = attest, 1 = revoke. */
  kind: number
  attester: Hex
  recipient: Hex
  uid: Hex
  /** The `block.timestamp` folded on-chain (drives the reconciliation order). */
  blockTimestamp: bigint
  /** Raw attestation data (ABI-encoded `string comment, uint256 confidence`). */
  data: Hex
}

/**
 * Governance-pinned parameters. All `*Fp` fields are scaled by `precisionScale` (1e18).
 * Mirrors `pagerank_core::Params`. The exact ABI tuple hashed into `paramsHash` is frozen in
 * `encode.paramsHash`.
 */
export interface Params {
  dampingFp: bigint
  toleranceFp: bigint
  maxIterations: number
  minWeightFp: bigint
  maxWeightFp: bigint
  trustShareFp: bigint
  trustDecayFp: bigint
  /** Trusted seed addresses. `seedSetRoot` is computed over the *sorted* set. */
  trustedSeeds: Hex[]
  totalPool: bigint
  /** Internal fixed-point scale S (1e18). */
  precisionScale: bigint
  schemaUid: Hex
  /** ABI head-slot index of the confidence field in the attestation `data` (currently 1). */
  weightFieldIndex: number
  /** Lane 2 (envelope 0): accepted EIP-712 domain separators; empty/absent = lane 2 disabled. */
  envelope0DomainSeparators?: Hex[]
  /** Rule-Φ staleness horizon in seconds (nonzero when lane 2 is enabled). */
  lane2MaxHeadAge?: number | bigint
  /**
   * Domain separation (introduced in params-schema v2 and retained in v3): the instance's
   * `EASIndexerResolver` address. Together
   * with `chainId` this is what stops two identically-configured instances from accepting each
   * other's proofs. Required — a recompute that guesses these produces a paramsHash that will not
   * match the chain, and silently defaulting them is exactly the bug the field exists to prevent.
   */
  accumulator: Hex
  /** Domain separation (introduced in params-schema v2 and retained in v3): creation chain id. */
  chainId: number | bigint
}

/** Trust is enabled iff there is at least one trusted seed (mirrors `has_trust_enabled`). */
export const hasTrustEnabled = (p: Params): boolean => p.trustedSeeds.length > 0

/**
 * The two journal-v3 pass-through commitments. Neither is computed: the prover supplies both, the
 * guest copies them verbatim, and `MerkleSnapshot.submitProof` is what makes them binding (it
 * rebuilds the digest with its own `recipient` argument and an `instanceDomain` derived from
 * `address(this)` and `block.chainid`). Mirrors `pagerank_core::Binding`.
 */
export interface Binding {
  /** The bounty payee. The zero address is legitimate and means "no bounty". */
  recipient: Hex
  /** `keccak256(abi.encode(snapshot, chainId))` — see `encode.instanceDomain`. */
  instanceDomain: Hex
}

/** The complete input the canonical computer receives. Mirrors `pagerank_core::GuestInput`. */
export interface GuestInput {
  /** Edges in accumulator fold order (index = `leafCount` position). */
  edges: RawEdge[]
  params: Params
  /** Journal-v3 pass-through commitments. Absent = both zero (no bounty, no domain). */
  binding?: Binding
}

/**
 * The 12 public journal fields (journal v3 — two-lane plus the two bindings).
 * `keccak256(abi.encode(..))` of these is the digest the on-chain verifier binds. Field order is
 * FROZEN — see `encode.journalDigest`. An empty lane is the zero accumulator (lane-1-only:
 * anchorAcc = 0x0, anchorCount = 0, skippedDigest = 0x0).
 */
export interface Journal {
  acc: Hex
  leafCount: bigint
  anchorAcc: Hex
  anchorCount: bigint
  paramsHash: Hex
  outputRoot: Hex
  ipfsHash: Hex
  cidDigest: Hex
  totalValue: bigint
  skippedDigest: Hex
  /** v3: the bounty payee, committed verbatim from `Binding.recipient`. */
  recipient: Hex
  /** v3: the instance this proof is for, committed verbatim from `Binding.instanceDomain`. */
  instanceDomain: Hex
}

/** Full result of a canonical computation. Mirrors `pagerank_core::ComputeResult`. */
export interface ComputeResult {
  journal: Journal
  /** `[account, value]` for accounts with `value > 0`, sorted ascending by address. */
  scores: Array<[Hex, bigint]>
  /** The canonical JSON blob string (what `ipfsHash`/`cid` commit to). */
  blob: string
  /** The CIDv1 (raw, sha2-256) string. */
  cid: string
  /** Non-consensus diagnostics for honest UI preview copy. */
  rankDiagnostics: {
    iterations: number
    converged: boolean
  }
}

/**
 * Governance-pinned parameters for the Safe signer-sync selection rule. Mirrors
 * `pagerank_core::SelectionParams`. Hashed to `selectionParamsHash` (see `encode.selectionParamsHash`).
 */
export interface SelectionParams {
  /** Maximum number of top-scored accounts to select as Safe owners. */
  topN: number
  /** Minimum resulting Safe threshold (>= 1). */
  minThreshold: number
  /** Target threshold as a fraction of the selected owner count, in basis points (e.g. 5000 = 50%). */
  targetThresholdBps: number
  /** Direct-governance activity remains fresh for this many blocks. */
  maxInactiveBlocks: bigint
  /** Distinct fresh principals required before inactivity may change the Safe owner set. */
  minActivityWitnesses: number
}

export interface SignerActivity {
  account: Hex
  proposalId: bigint
  blockNumber: bigint
}

export interface ActivityCheckpoint {
  acc: Hex
  count: bigint
  blockNumber: bigint
}

/**
 * The input the signer-sync computer receives: the same folded edges + params as the root producer,
 * plus the selection parameters and the instance binding. Mirrors `pagerank_core::SignerInput`.
 */
export interface SignerInput {
  edges: RawEdge[]
  params: Params
  selection: SelectionParams
  activity?: SignerActivity[]
  activityCheckpoint?: ActivityCheckpoint
  activityCheckpointId?: bigint
  currentSigners?: Hex[]
  currentThreshold?: bigint
  wasInitialized?: boolean
  /**
   * `keccak256(abi.encode(module, chainId))` — see `encode.instanceDomain`, with the
   * `SignerSyncZkModule` address in the snapshot slot. Committed verbatim into the signer journal
   * and made binding by `submitSignerProof`, which rebuilds it from `address(this)` and
   * `block.chainid` (audit M-3). Optional to mirror the Rust `#[serde(default)]`; a missing value
   * commits the zero word, which no deployed module accepts.
   */
  instanceDomain?: Hex
}

/**
 * The 13 public signer-journal fields. `keccak256(abi.encode(..))` is the digest the on-chain
 * `SignerSyncZkModule` binds. Field order is FROZEN — see `encode.signerJournalEncoded`.
 * Mirrors `pagerank_core::SignerJournal`.
 */
export interface SignerJournal {
  acc: Hex
  leafCount: bigint
  paramsHash: Hex
  selectionParamsHash: Hex
  activityAcc: Hex
  activityCount: bigint
  activityBlock: bigint
  wasInitialized: boolean
  currentSignerSetRoot: Hex
  currentThreshold: bigint
  /**
   * OZ StandardMerkleTree root over the canonically-sorted selected owner set (leaf =
   * `keccak256(abi.encode(address))`), identical to `seedSetRoot`.
   */
  signerSetRoot: Hex
  targetThreshold: bigint
  /** M-3: the module this proof is for, committed verbatim from `SignerInput.instanceDomain`. */
  instanceDomain: Hex
}

/**
 * Full result of a signer-sync computation. Mirrors `pagerank_core::SignerComputeResult`.
 */
export interface SignerComputeResult {
  journal: SignerJournal
  /** The selected owner set, sorted ascending by address (lowercase `0x` addresses). */
  signers: Hex[]
  targetThreshold: bigint
  activityApplied: boolean
}
