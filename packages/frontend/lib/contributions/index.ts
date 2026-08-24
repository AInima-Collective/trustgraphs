//! Contributions program — the TypeScript mirror of `crates/contributions-core` (the single
//! source of truth). The fourth parity leg (Rust ⟷ Solidity ⟷ SP1 guest ⟷ TS), locked by
//! `golden.test.ts` against `tests/golden/contributions.json`.
//!
//! Interface contract: `research/operations/contributions/interfaces.md` (FROZEN). Stage-1 reputation is the
//! `../pagerank` port, imported — never forked. This module owns only the contribution record
//! decoding, reconciliation, the stage-2 aggregation, and the program's params encoding.
//!
//! Dependency-clean by design: pure TS + viem hashing utils, no React/browser imports — the
//! indexer (M3) imports the exact same logic the frontend recomputes with.

export * from './types'
export {
  isRevoke,
  kindTag,
  schemaIndex,
  KIND_CLAIM_ATTEST,
  KIND_CLAIM_REVOKE,
  KIND_RESPONSE_ATTEST,
  KIND_RESPONSE_REVOKE,
  KIND_VALUATION_ATTEST,
  KIND_VALUATION_REVOKE,
  SCHEMA_CLAIM,
  SCHEMA_RESPONSE,
  SCHEMA_VALUATION,
} from './kind'
export {
  decodeClaim,
  decodeResponse,
  decodeValuation,
  type ClaimPayload,
  type ResponsePayload,
  type ValuationPayload,
} from './records'
export {
  actorKey,
  consentMultFp,
  reconcile,
  splitActorKey,
  type LiveClaim,
  type LiveState,
} from './reconcile'
export {
  eligibility,
  type Eligibility,
  type EligibleValuation,
  type SkipReason,
  type SkippedValuation,
} from './eligibility'
export { stage2, type Stage2 } from './stage2'
export { contributionsSeedSetRoot, paramsHash } from './params'
export {
  computeContributions,
  journalDigest,
  journalEncoded,
  reputation,
  type ContributionsResult,
} from './compute'
