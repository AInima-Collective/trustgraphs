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
  trustMultiplierFp: bigint
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
}

/** Trust is enabled iff there is at least one trusted seed (mirrors `has_trust_enabled`). */
export const hasTrustEnabled = (p: Params): boolean => p.trustedSeeds.length > 0

/** The complete input the canonical computer receives. Mirrors `pagerank_core::GuestInput`. */
export interface GuestInput {
  /** Edges in accumulator fold order (index = `leafCount` position). */
  edges: RawEdge[]
  params: Params
}

/**
 * The 7 public journal fields. `keccak256(abi.encode(..))` of these is the digest the on-chain
 * verifier binds. Field order is FROZEN — see `encode.journalDigest`.
 */
export interface Journal {
  acc: Hex
  leafCount: bigint
  paramsHash: Hex
  outputRoot: Hex
  ipfsHash: Hex
  cidDigest: Hex
  totalValue: bigint
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
}
