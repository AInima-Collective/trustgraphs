//! The 21-word `paramsHash` encoding (INTERFACES.md §3) — frozen, golden-locked against
//! `ContributionsParamsCodec.sol` and the TS port via `tests/golden/contributions.json`.

use crate::{Params, PARAMS_SCHEMA_VERSION};
use alloy_primitives::{keccak256, B256};
use pagerank_core::encode::{word_u256, word_u32, word_u64};
use pagerank_core::merkle;

/// The governance-pinned `paramsHash`: keccak over the concatenation of the 21 static ABI words.
/// `seedSetRoot` (slot 9) is computed over the *sorted* trusted-seed set, so the hash depends only
/// on the seed set, not the input order. Bound the same way every program binds params: the
/// contrib `MerkleSnapshot.submitProof` builds the journal digest from its stored `paramsHash`,
/// so a proof under different params yields a different digest and fails verification.
pub fn params_hash(p: &Params) -> B256 {
    let mut seeds = p.trusted_seeds.clone();
    seeds.sort();
    let seed_set_root = merkle::seed_set_root(&seeds);

    let mut buf = Vec::with_capacity(32 * 21);
    buf.extend_from_slice(&word_u32(PARAMS_SCHEMA_VERSION));
    buf.extend_from_slice(&word_u256(p.damping_fp));
    buf.extend_from_slice(&word_u256(p.tolerance_fp));
    buf.extend_from_slice(&word_u32(p.max_iterations));
    buf.extend_from_slice(&word_u256(p.min_weight_fp));
    buf.extend_from_slice(&word_u256(p.max_weight_fp));
    buf.extend_from_slice(&word_u256(p.trust_share_fp));
    buf.extend_from_slice(&word_u256(p.trust_decay_fp));
    buf.extend_from_slice(seed_set_root.as_slice());
    buf.extend_from_slice(&word_u256(p.precision_scale));
    buf.extend_from_slice(&word_u32(p.weight_field_index));
    buf.extend_from_slice(&word_u64(p.round_start));
    buf.extend_from_slice(&word_u64(p.round_end));
    buf.extend_from_slice(&word_u256(p.unaccepted_mult_fp));
    buf.extend_from_slice(&word_u256(p.collaborator_mult_fp));
    buf.extend_from_slice(&word_u256(p.min_rater_rep_fp));
    buf.extend_from_slice(&word_u32(p.evaluator_carveout_bps));
    buf.extend_from_slice(&word_u256(p.total_pool));
    buf.extend_from_slice(p.claim_schema_uid.as_slice());
    buf.extend_from_slice(p.response_schema_uid.as_slice());
    buf.extend_from_slice(p.valuation_schema_uid.as_slice());
    keccak256(&buf)
}

#[cfg(test)]
mod tests {
    use super::*;
    use alloy_primitives::{Address, U256};

    pub fn sample_params() -> Params {
        let s = U256::from(1_000_000_000_000_000_000u64);
        Params {
            damping_fp: s * U256::from(85) / U256::from(100),
            tolerance_fp: s / U256::from(1_000_000u64),
            max_iterations: 100,
            min_weight_fp: U256::ZERO,
            max_weight_fp: s * U256::from(100),
            trust_share_fp: s,
            trust_decay_fp: s * U256::from(80) / U256::from(100),
            trusted_seeds: vec![Address::from([0x11; 20]), Address::from([0x22; 20])],
            precision_scale: s,
            weight_field_index: 1,
            round_start: 1_700_000_000,
            round_end: 1_700_604_800,
            unaccepted_mult_fp: s / U256::from(2),
            collaborator_mult_fp: s / U256::from(2),
            min_rater_rep_fp: U256::from(1_000_000_000u64),
            evaluator_carveout_bps: 100,
            total_pool: U256::from(5_000_000_000u64),
            claim_schema_uid: B256::from([0xAA; 32]),
            response_schema_uid: B256::from([0xBB; 32]),
            valuation_schema_uid: B256::from([0xCC; 32]),
        }
    }

    #[test]
    fn seed_order_does_not_change_hash() {
        let p = sample_params();
        let mut q = p.clone();
        q.trusted_seeds.reverse();
        assert_eq!(params_hash(&p), params_hash(&q));
    }

    #[test]
    fn every_field_feeds_the_hash() {
        let p = sample_params();
        let h = params_hash(&p);
        let one = U256::from(1);
        let mutations: Vec<Params> = vec![
            Params { damping_fp: p.damping_fp + one, ..p.clone() },
            Params { tolerance_fp: p.tolerance_fp + one, ..p.clone() },
            Params { max_iterations: p.max_iterations + 1, ..p.clone() },
            Params { min_weight_fp: p.min_weight_fp + one, ..p.clone() },
            Params { max_weight_fp: p.max_weight_fp + one, ..p.clone() },
            Params { trust_share_fp: p.trust_share_fp + one, ..p.clone() },
            Params { trust_decay_fp: p.trust_decay_fp + one, ..p.clone() },
            Params { trusted_seeds: vec![Address::from([0x33; 20])], ..p.clone() },
            Params { precision_scale: p.precision_scale + one, ..p.clone() },
            Params { weight_field_index: p.weight_field_index + 1, ..p.clone() },
            Params { round_start: p.round_start + 1, ..p.clone() },
            Params { round_end: p.round_end + 1, ..p.clone() },
            Params { unaccepted_mult_fp: p.unaccepted_mult_fp + one, ..p.clone() },
            Params { collaborator_mult_fp: p.collaborator_mult_fp + one, ..p.clone() },
            Params { min_rater_rep_fp: p.min_rater_rep_fp + one, ..p.clone() },
            Params { evaluator_carveout_bps: p.evaluator_carveout_bps + 1, ..p.clone() },
            Params { total_pool: p.total_pool + one, ..p.clone() },
            Params { claim_schema_uid: B256::from([0x01; 32]), ..p.clone() },
            Params { response_schema_uid: B256::from([0x02; 32]), ..p.clone() },
            Params { valuation_schema_uid: B256::from([0x03; 32]), ..p.clone() },
        ];
        for (i, m) in mutations.iter().enumerate() {
            assert_ne!(params_hash(m), h, "mutation {i} did not change paramsHash");
        }
    }
}
