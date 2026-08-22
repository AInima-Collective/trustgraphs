//! The contribution accumulator's fold `kind` tagging (INTERFACES.md §2):
//! `kind = schemaIndex * 2 + isRevoke`, schemaIndex 0 = claim, 1 = response, 2 = valuation.
//!
//! The leaf ABI is identical to `AttestationAccumulator` today; only the kind domain is new,
//! and it is per-accumulator-instance. The tag is trustworthy because the resolver holds an
//! immutable allowlist of the three schema UIDs and reverts anything else.

/// Schema indices into the resolver's immutable allowlist.
pub const SCHEMA_CLAIM: u8 = 0;
pub const SCHEMA_RESPONSE: u8 = 1;
pub const SCHEMA_VALUATION: u8 = 2;

pub const KIND_CLAIM_ATTEST: u8 = 0;
pub const KIND_CLAIM_REVOKE: u8 = 1;
pub const KIND_RESPONSE_ATTEST: u8 = 2;
pub const KIND_RESPONSE_REVOKE: u8 = 3;
pub const KIND_VALUATION_ATTEST: u8 = 4;
pub const KIND_VALUATION_REVOKE: u8 = 5;

/// `kind = schemaIndex * 2 + isRevoke`.
pub fn kind(schema_index: u8, is_revoke: bool) -> u8 {
    schema_index * 2 + is_revoke as u8
}

/// The schema index a kind tags (kind / 2).
pub fn schema_index(kind: u8) -> u8 {
    kind / 2
}

/// Whether a kind is a revocation (kind % 2 == 1).
pub fn is_revoke(kind: u8) -> bool {
    kind % 2 == 1
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn kind_round_trips() {
        for si in 0..=SCHEMA_VALUATION {
            for rv in [false, true] {
                let k = kind(si, rv);
                assert_eq!(schema_index(k), si);
                assert_eq!(is_revoke(k), rv);
            }
        }
        assert_eq!(kind(SCHEMA_CLAIM, false), KIND_CLAIM_ATTEST);
        assert_eq!(kind(SCHEMA_CLAIM, true), KIND_CLAIM_REVOKE);
        assert_eq!(kind(SCHEMA_RESPONSE, false), KIND_RESPONSE_ATTEST);
        assert_eq!(kind(SCHEMA_RESPONSE, true), KIND_RESPONSE_REVOKE);
        assert_eq!(kind(SCHEMA_VALUATION, false), KIND_VALUATION_ATTEST);
        assert_eq!(kind(SCHEMA_VALUATION, true), KIND_VALUATION_REVOKE);
    }
}
