//! Contribution-record reconciliation: the folded record log (accumulator B) → the live sets
//! stage 2 scores over (CONTRIBUTION_FUNDING.md §2, GOAL.md M1).
//!
//! Rules (all mirroring lane-1 trust-edge reconciliation):
//! - revocation excludes: any revoke kind for a `uid` excludes that attestation entirely,
//!   regardless of fold order;
//! - last-write-wins per key by `(block_timestamp, fold_index)`: one live response per
//!   (responder, claim), one live valuation per (rater, claim);
//! - malformed payloads are deterministic skips (`records` decoders);
//! - claims count only if `block_timestamp ∈ [round_start, round_end]` (inclusive);
//!   responses and valuations count until the checkpoint freeze (no extra window).

use crate::records::{decode_claim, decode_response, decode_valuation};
use crate::{kind, Params};
use alloy_primitives::{Address, B256, U256};
use pagerank_core::RawEdge;
use std::collections::{BTreeMap, BTreeSet};

/// A live, in-window contribution claim with aggregated attribution.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LiveClaim {
    pub uid: B256,
    pub attester: Address,
    pub block_timestamp: u64,
    /// Attribution shares aggregated per contributor address (duplicates summed), in
    /// address order. Never empty; total share sum is never zero.
    pub shares: BTreeMap<Address, u64>,
    pub total_shares: u64,
}

/// The reconciled live state of one round's record log.
#[derive(Clone, Debug, Default)]
pub struct LiveState {
    /// Live in-window claims, keyed by claim uid.
    pub claims: BTreeMap<B256, LiveClaim>,
    /// Live responses: (claim uid, responder) → response (1 = accept, 2 = reject).
    /// Only kept for responders in the claim's contributor set.
    pub responses: BTreeMap<(B256, Address), u8>,
    /// Live valuations: (claim uid, rater) → score ∈ [0, 100]. One per key (LWW).
    /// Referencing a live claim; self-valuations are dropped later (stage-2 eligibility,
    /// which also needs the rater's reputation).
    pub valuations: BTreeMap<(B256, Address), u8>,
}

/// Reconcile the folded record log into live sets.
pub fn reconcile(records: &[RawEdge], p: &Params) -> LiveState {
    // 1. Revocation excludes, per schema kind (a revoke's uid kills the matching attest).
    let revoked: BTreeSet<B256> =
        records.iter().filter(|r| kind::is_revoke(r.kind)).map(|r| r.uid).collect();

    // 2. Canonical order: (block_timestamp, fold_index). Fold index is the vec position.
    let mut ordered: Vec<(u64, &RawEdge)> = records
        .iter()
        .enumerate()
        .filter(|(_, r)| !kind::is_revoke(r.kind) && !revoked.contains(&r.uid))
        .map(|(i, r)| (i as u64, r))
        .collect();
    ordered.sort_by(|a, b| a.1.block_timestamp.cmp(&b.1.block_timestamp).then(a.0.cmp(&b.0)));

    // 3. Claims first (responses/valuations reference them; map order is irrelevant since
    //    claim identity is the uid and uids are unique in EAS).
    let mut claims: BTreeMap<B256, LiveClaim> = BTreeMap::new();
    for (_, r) in &ordered {
        if r.kind != kind::KIND_CLAIM_ATTEST {
            continue;
        }
        // Round window (provable: timestamps are folded into every leaf).
        if r.block_timestamp < p.round_start || r.block_timestamp > p.round_end {
            continue;
        }
        let Some(payload) = decode_claim(&r.data) else { continue };
        let mut shares: BTreeMap<Address, u64> = BTreeMap::new();
        for (a, s) in payload.contributors.iter().zip(payload.shares.iter()) {
            *shares.entry(*a).or_default() += *s as u64;
        }
        let total_shares: u64 = shares.values().sum();
        // decode_claim guarantees a nonzero share exists.
        claims.insert(
            r.uid,
            LiveClaim {
                uid: r.uid,
                attester: r.attester,
                block_timestamp: r.block_timestamp,
                shares,
                total_shares,
            },
        );
    }

    // 4. Responses and valuations: LWW per (claim, actor) — later (timestamp, fold_index)
    //    overwrites earlier because `ordered` is sorted ascending.
    let mut responses: BTreeMap<(B256, Address), u8> = BTreeMap::new();
    let mut valuations: BTreeMap<(B256, Address), u8> = BTreeMap::new();
    for (_, r) in &ordered {
        match r.kind {
            kind::KIND_RESPONSE_ATTEST => {
                let Some(payload) = decode_response(&r.data) else { continue };
                let Some(claim) = claims.get(&payload.claim_uid) else { continue };
                // Only meaningful from an address in the claim's contributor set.
                if !claim.shares.contains_key(&r.attester) {
                    continue;
                }
                responses.insert((payload.claim_uid, r.attester), payload.response);
            }
            kind::KIND_VALUATION_ATTEST => {
                let Some(payload) = decode_valuation(&r.data) else { continue };
                if !claims.contains_key(&payload.claim_uid) {
                    continue;
                }
                valuations.insert((payload.claim_uid, r.attester), payload.score);
            }
            _ => {}
        }
    }

    LiveState { claims, responses, valuations }
}

/// The consent multiplier for contributor `a`'s share of `claim` (CONTRIBUTION_FUNDING.md §2.2),
/// in fixed point: accepted → S, no response → `unaccepted_mult_fp`, rejected → 0.
/// A self-claim's attester share is implicitly accepted (an explicit response still overrides —
/// people must be able to refuse attribution).
pub fn consent_mult_fp(state: &LiveState, claim: &LiveClaim, a: Address, p: &Params) -> U256 {
    match state.responses.get(&(claim.uid, a)) {
        Some(1) => p.precision_scale,
        Some(_) => U256::ZERO, // 2 = reject (decoder admits nothing else)
        None => {
            if a == claim.attester {
                p.precision_scale // self-claim: implicitly accepted
            } else {
                p.unaccepted_mult_fp
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testutil::{claim_data, edge, params, valuation_data};
    use crate::testutil::{response_data, A, B, C};

    #[test]
    fn revoked_claim_is_gone_and_its_valuations_are_inert() {
        let p = params();
        let uid = B256::from([1; 32]);
        let records = vec![
            edge(kind::KIND_CLAIM_ATTEST, A, uid, 1_760_000_100, claim_data(&[(A, 1)])),
            edge(
                kind::KIND_VALUATION_ATTEST,
                B,
                B256::from([2; 32]),
                1_760_000_200,
                valuation_data(uid, 80),
            ),
            edge(kind::KIND_CLAIM_REVOKE, A, uid, 1_760_000_300, claim_data(&[(A, 1)])),
        ];
        let s = reconcile(&records, &p);
        assert!(s.claims.is_empty());
        assert!(s.valuations.is_empty());
    }

    #[test]
    fn out_of_window_claim_is_inert() {
        let p = params();
        let uid = B256::from([1; 32]);
        let records = vec![
            edge(kind::KIND_CLAIM_ATTEST, A, uid, p.round_start - 1, claim_data(&[(A, 1)])),
            edge(
                kind::KIND_CLAIM_ATTEST,
                B,
                B256::from([2; 32]),
                p.round_end + 1,
                claim_data(&[(B, 1)]),
            ),
        ];
        let s = reconcile(&records, &p);
        assert!(s.claims.is_empty());
    }

    #[test]
    fn valuation_lww_and_revocation() {
        let p = params();
        let claim_uid = B256::from([1; 32]);
        let v1 = B256::from([2; 32]);
        let v2 = B256::from([3; 32]);
        let mut records = vec![
            edge(kind::KIND_CLAIM_ATTEST, A, claim_uid, 1_760_000_100, claim_data(&[(A, 1)])),
            edge(kind::KIND_VALUATION_ATTEST, B, v1, 1_760_000_200, valuation_data(claim_uid, 10)),
            edge(kind::KIND_VALUATION_ATTEST, B, v2, 1_760_000_300, valuation_data(claim_uid, 90)),
        ];
        let s = reconcile(&records, &p);
        assert_eq!(s.valuations[&(claim_uid, B)], 90, "later valuation wins");

        // Revoking the later one falls back to the earlier live valuation.
        records.push(edge(
            kind::KIND_VALUATION_REVOKE,
            B,
            v2,
            1_760_000_400,
            valuation_data(claim_uid, 90),
        ));
        let s = reconcile(&records, &p);
        assert_eq!(s.valuations[&(claim_uid, B)], 10, "revocation excludes; earlier survives");
    }

    #[test]
    fn response_only_from_contributors() {
        let p = params();
        let claim_uid = B256::from([1; 32]);
        let records = vec![
            edge(kind::KIND_CLAIM_ATTEST, A, claim_uid, 1_760_000_100, claim_data(&[(B, 2)])),
            edge(
                kind::KIND_RESPONSE_ATTEST,
                C,
                B256::from([2; 32]),
                1_760_000_200,
                response_data(claim_uid, 1),
            ),
            edge(
                kind::KIND_RESPONSE_ATTEST,
                B,
                B256::from([3; 32]),
                1_760_000_300,
                response_data(claim_uid, 2),
            ),
        ];
        let s = reconcile(&records, &p);
        assert!(!s.responses.contains_key(&(claim_uid, C)), "non-contributor response ignored");
        assert_eq!(s.responses[&(claim_uid, B)], 2);
    }

    #[test]
    fn consent_mults() {
        let p = params();
        let claim_uid = B256::from([1; 32]);
        // A self-claims with B nominated.
        let records = vec![edge(
            kind::KIND_CLAIM_ATTEST,
            A,
            claim_uid,
            1_760_000_100,
            claim_data(&[(A, 1), (B, 1)]),
        )];
        let s = reconcile(&records, &p);
        let c = &s.claims[&claim_uid];
        assert_eq!(
            consent_mult_fp(&s, c, A, &p),
            p.precision_scale,
            "self share implicitly accepted"
        );
        assert_eq!(consent_mult_fp(&s, c, B, &p), p.unaccepted_mult_fp, "nominee unaccepted");

        // B rejects; A explicitly rejects their own share too.
        let mut records = records;
        records.push(edge(
            kind::KIND_RESPONSE_ATTEST,
            B,
            B256::from([2; 32]),
            1_760_000_200,
            response_data(claim_uid, 2),
        ));
        records.push(edge(
            kind::KIND_RESPONSE_ATTEST,
            A,
            B256::from([3; 32]),
            1_760_000_300,
            response_data(claim_uid, 2),
        ));
        let s = reconcile(&records, &p);
        let c = &s.claims[&claim_uid];
        assert_eq!(consent_mult_fp(&s, c, B, &p), U256::ZERO, "explicit reject zeroes");
        assert_eq!(
            consent_mult_fp(&s, c, A, &p),
            U256::ZERO,
            "explicit reject beats implicit self-accept"
        );
    }

    #[test]
    fn duplicate_contributors_aggregate() {
        let p = params();
        let claim_uid = B256::from([1; 32]);
        let records = vec![edge(
            kind::KIND_CLAIM_ATTEST,
            A,
            claim_uid,
            1_760_000_100,
            claim_data(&[(B, 2), (B, 3), (C, 5)]),
        )];
        let s = reconcile(&records, &p);
        let c = &s.claims[&claim_uid];
        assert_eq!(c.shares[&B], 5);
        assert_eq!(c.shares[&C], 5);
        assert_eq!(c.total_shares, 10);
    }
}
