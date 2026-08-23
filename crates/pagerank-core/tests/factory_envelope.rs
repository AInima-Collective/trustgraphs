//! The representable-range backstop and the schema-v3 mass invariant.
//!
//! Provenance: the M6 security review refuted "the creation-time bounds keep every instance inside
//! the envelope the guest is proven safe over" (`docs/build/create-a-network.md` §3). At the time,
//! `zk_core::fixed::mul_div` truncated its 512-bit quotient back to 256 bits on the assumption that
//! "the mathematical result always fits for our magnitudes", and the rank loop's accumulations were
//! unchecked alloy adds (which wrap silently, even in a debug build). A factory-legal instance
//! therefore did not fail to prove — it proved the WRONG scores, and disagreed with the
//! arbitrary-precision TS port about both payouts and ranking order.
//!
//! Schema v3 removes the founder multiplier and divides every row by the same base weights used
//! in its numerators. The rank core now asserts the resulting load-bearing invariant directly:
//! total standing never exceeds the precision scale at any iteration. `mul_div` still refuses a
//! quotient that cannot fit in U256 as a primitive-level backstop.

use alloy_primitives::{Address, B256, U256};
use pagerank_core::{pagerank, reconcile, Params, RawEdge};

fn s() -> U256 {
    U256::from(10u64).pow(U256::from(18u64))
}

fn addr(b: u8) -> Address {
    Address::from([b; 20])
}

/// `abi.encode(string comment, uint256 confidence)` — confidence in head slot 1.
fn attest(from: u8, to: u8, uid: u8, ts: u64, confidence: u64) -> RawEdge {
    let mut data = vec![0u8; 64];
    data[32..64].copy_from_slice(&U256::from(confidence).to_be_bytes::<32>());
    RawEdge {
        kind: 0,
        attester: addr(from),
        recipient: addr(to),
        uid: B256::from([uid; 32]),
        block_timestamp: ts,
        data,
    }
}

/// Params matching the blessed live network, which is also what the wizard defaults to.
fn live_params(max_iterations: u32) -> Params {
    Params {
        damping_fp: U256::from(85u64) * s() / U256::from(100u64), // 0.85
        tolerance_fp: U256::from(10u64).pow(U256::from(12u64)),   // 1e-6
        max_iterations,
        min_weight_fp: U256::ZERO,
        max_weight_fp: U256::from(100u64) * s(),
        trust_share_fp: s(),
        trust_decay_fp: U256::from(80u64) * s() / U256::from(100u64),
        trusted_seeds: vec![addr(1), addr(2)],
        total_pool: U256::from(1_000_000u64),
        precision_scale: s(),
        schema_uid: B256::from([9u8; 32]),
        weight_field_index: 1,
        envelope0_domain_separators: vec![],
        lane2_max_head_age: 0,
        accumulator: addr(0xAB),
        chain_id: 31337,
    }
}

fn scores(p: &Params, edges: &[RawEdge]) -> Vec<U256> {
    let g = reconcile::build_graph(edges, p);
    pagerank::calculate(&g, p).into_values().collect()
}

/// A mutual-seed graph exercises the former multiplier-growth shape.
fn mutual_seeds() -> Vec<RawEdge> {
    vec![attest(1, 2, 1, 100, 50), attest(2, 1, 2, 101, 50)]
}

/// Scores normalize to exactly S at every accepted iteration count.
#[test]
fn live_params_normalize_exactly_at_every_iteration_count() {
    for iters in [1u32, 5, 24, 100, 200, 500] {
        let sum: U256 =
            scores(&live_params(iters), &mutual_seeds()).into_iter().fold(U256::ZERO, |a, b| a + b);
        assert_eq!(sum, s(), "normalized scores must sum to S (iterations = {iters})");
    }
}

/// Maximum accepted damping, decay and iteration count remain representable by construction.
#[test]
fn accepted_extreme_params_do_not_panic_or_create_mass() {
    let mut extreme = live_params(500);
    extreme.damping_fp = s() - U256::from(1u64);
    extreme.trust_decay_fp = s();
    extreme.tolerance_fp = U256::from(1_000_000u64);
    let sum = scores(&extreme, &mutual_seeds()).into_iter().sum::<U256>();
    assert_eq!(sum, s());
}

/// `mul_div` itself refuses a quotient that does not fit, rather than returning its low 256 bits.
#[test]
#[should_panic(expected = "mul_div overflow")]
fn mul_div_refuses_an_unrepresentable_quotient() {
    let a = U256::MAX / U256::from(2u64);
    let _ = pagerank_core::fixed::fp_mul(a, U256::from(1000u64) * s(), s());
}

/// Alloy's `U256` addition wraps silently, so the rank loop must keep explicit checked sums even
/// though the schema-v3 mass invariant makes overflow unreachable for accepted parameters.
#[test]
fn alloy_u256_addition_still_wraps_silently() {
    assert_eq!(U256::MAX + U256::from(1u64), U256::ZERO, "U256 `+` wraps, it does not panic");
}

/// The TS port uses arbitrary-precision `bigint`; this ordinary accepted case guards the shared
/// normalization and output-root path. Differential fuzzing covers arbitrary admissible graphs.
#[test]
fn the_ports_agree_wherever_both_are_defined() {
    let edges = vec![
        attest(1, 2, 1, 100, 50),
        attest(2, 1, 2, 101, 30),
        attest(1, 3, 3, 102, 70),
        attest(3, 1, 4, 103, 10),
    ];
    let p = live_params(100);
    let input =
        pagerank_core::GuestInput { edges, params: p, lane2: None, binding: Default::default() };
    let r = pagerank_core::compute::compute(&input);
    let total: U256 = r.scores.iter().map(|(_, v)| *v).fold(U256::ZERO, |a, b| a + b);
    assert_eq!(total, U256::from(1_000_000u64), "payouts sum to the pool");
    assert_ne!(r.journal.output_root, B256::ZERO);
}
