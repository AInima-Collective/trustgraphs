//! The contribution accumulator's fold `kind` tagging (INTERFACES.md §2):
//! `kind = schemaIndex * 2 + isRevoke`, schemaIndex 0 = claim, 1 = response, 2 = valuation.
//! Mirrors `contributions_core::kind`.

/** Schema indices into the resolver's immutable allowlist. */
export const SCHEMA_CLAIM = 0
export const SCHEMA_RESPONSE = 1
export const SCHEMA_VALUATION = 2

export const KIND_CLAIM_ATTEST = 0
export const KIND_CLAIM_REVOKE = 1
export const KIND_RESPONSE_ATTEST = 2
export const KIND_RESPONSE_REVOKE = 3
export const KIND_VALUATION_ATTEST = 4
export const KIND_VALUATION_REVOKE = 5

/** `kind = schemaIndex * 2 + isRevoke`. */
export const kindTag = (schemaIndex: number, isRevoke: boolean): number =>
  schemaIndex * 2 + (isRevoke ? 1 : 0)

/** The schema index a kind tags (kind / 2, truncating). */
export const schemaIndex = (kind: number): number => Math.floor(kind / 2)

/** Whether a kind is a revocation (kind % 2 == 1). */
export const isRevoke = (kind: number): boolean => kind % 2 === 1
