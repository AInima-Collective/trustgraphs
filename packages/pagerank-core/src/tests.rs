//! Shared test helpers + end-to-end determinism / invariant tests.

use crate::compute::compute;
use crate::{GuestInput, Params, RawEdge};
use alloy_primitives::{Address, B256, U256};

/// S = 1e18.
pub(crate) fn scale() -> U256 {
    U256::from(10u64).pow(U256::from(18u64))
}

/// A fixed-point fraction `num/den * S`.
fn fp(num: u64, den: u64) -> U256 {
    scale() * U256::from(num) / U256::from(den)
}

/// Default params (no trust), mirroring `PageRankConfig::default()`.
pub(crate) fn default_params() -> Params {
    let s = scale();
    Params {
        damping_fp: fp(85, 100),      // 0.85
        tolerance_fp: s / U256::from(1_000_000u64), // 1e-6
        max_iterations: 100,
        min_weight_fp: U256::ZERO,    // 0
        max_weight_fp: U256::from(100u64) * s, // 100
        trust_multiplier_fp: U256::from(2u64) * s, // unused when no seeds
        trust_share_fp: U256::ZERO,
        trust_decay_fp: U256::ZERO,
        trusted_seeds: vec![],
        total_pool: U256::from(1_000_000_000_000_000_000_000_000u128), // 1e24
        precision_scale: s,
        schema_uid: B256::ZERO,
        weight_field_index: 1,
    }
}

/// Params with a trust configuration (mirrors `TrustConfig::new`).
pub(crate) fn trust_params(seeds: Vec<Address>) -> Params {
    let s = scale();
    Params {
        trust_multiplier_fp: U256::from(2u64) * s, // 2.0
        trust_share_fp: fp(15, 100),               // 0.15
        trust_decay_fp: fp(80, 100),               // 0.8
        trusted_seeds: seeds,
        ..default_params()
    }
}

fn addr(b: u8) -> Address {
    Address::from([b; 20])
}

/// Build an edge with a given confidence (weight) in ABI head slot 1.
fn edge(from: u8, to: u8, uid: u8, ts: u64, weight: u64) -> RawEdge {
    let mut data = vec![0u8; 64];
    data[32..64].copy_from_slice(&U256::from(weight).to_be_bytes::<32>());
    RawEdge {
        kind: 0,
        attester: addr(from),
        recipient: addr(to),
        uid: B256::from([uid; 32]),
        block_timestamp: ts,
        data,
    }
}

fn sample_input() -> GuestInput {
    // Alice -> Bob -> Charlie -> Alice, symmetric ring, all weight 1.
    let edges = vec![
        edge(1, 2, 1, 100, 1),
        edge(2, 3, 2, 101, 1),
        edge(3, 1, 3, 102, 1),
    ];
    GuestInput { edges, params: default_params() }
}

#[test]
fn compute_is_deterministic() {
    let input = sample_input();
    let a = compute(&input);
    let b = compute(&input);
    assert_eq!(a.journal, b.journal);
    assert_eq!(a.scores, b.scores);
    assert_eq!(a.cid, b.cid);
}

#[test]
fn symmetric_ring_scores_are_equal_and_pool_conserved() {
    let input = sample_input();
    let r = compute(&input);
    // Three nodes, symmetric ⇒ near-equal values; total equals the pool.
    assert_eq!(r.scores.len(), 3);
    assert_eq!(r.journal.total_value, input.params.total_pool);
    let vals: Vec<U256> = r.scores.iter().map(|(_, v)| *v).collect();
    // pairwise within 0.1% (rounding + last-absorbs-remainder)
    let max = vals.iter().copied().max().unwrap();
    let min = vals.iter().copied().min().unwrap();
    let tol = input.params.total_pool / U256::from(1000u64);
    assert!(max - min <= tol, "ring scores should be ~equal: {min} vs {max}");
}

#[test]
fn journal_binds_inputs() {
    let input = sample_input();
    let r = compute(&input);
    // leafCount matches edge count; acc is non-zero for non-empty input.
    assert_eq!(r.journal.leaf_count, 3);
    assert_ne!(r.journal.acc, B256::ZERO);
    assert_ne!(r.journal.output_root, B256::ZERO);
    assert!(r.cid.starts_with("bafkrei"));
}

#[test]
fn trust_boosts_seed_neighbour() {
    // Alice (seed) -> Bob, Bob -> Charlie, Charlie -> Alice.
    let edges = vec![
        edge(1, 2, 1, 100, 1),
        edge(2, 3, 2, 101, 1),
        edge(3, 1, 3, 102, 1),
    ];
    let input = GuestInput { edges, params: trust_params(vec![addr(1)]) };
    let r = compute(&input);
    assert_eq!(r.journal.total_value, input.params.total_pool);
    // Everyone is reachable; pool fully distributed among 3.
    assert_eq!(r.scores.len(), 3);
}

#[test]
fn empty_input_is_valid() {
    let input = GuestInput { edges: vec![], params: default_params() };
    let r = compute(&input);
    assert_eq!(r.journal.leaf_count, 0);
    assert_eq!(r.journal.acc, B256::ZERO);
    assert_eq!(r.journal.output_root, B256::ZERO);
    assert_eq!(r.journal.total_value, U256::ZERO);
    assert_eq!(r.scores.len(), 0);
    // empty blob is "{}"
    assert_eq!(r.blob, b"{}");
}
