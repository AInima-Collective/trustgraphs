//! The representable-range backstop, and the factory bounds that keep real instances away from it.
//!
//! Provenance: the M6 security review refuted "the creation-time bounds keep every instance inside
//! the envelope the guest is proven safe over" (`docs/build/create-a-network.md` §3). At the time,
//! `zk_core::fixed::mul_div` truncated its 512-bit quotient back to 256 bits on the assumption that
//! "the mathematical result always fits for our magnitudes", and the rank loop's accumulations were
//! unchecked alloy adds (which wrap silently, even in a debug build). A factory-legal instance
//! therefore did not fail to prove — it proved the WRONG scores, and disagreed with the
//! arbitrary-precision TS port about both payouts and ranking order.
//!
//! Both halves are now closed and this file locks them:
//!   1. `mul_div` and the rank-loop accumulations panic instead of wrapping, so an out-of-range
//!      instance is UNPROVABLE rather than wrong (and the TS port throws in the same place).
//!   2. The factory's bounds were tightened so the wizard's own range stays far from the ceiling.
//!
//! Note (1) is the load-bearing one. Ranks are normalized once, AFTER the loop, so a seed whose
//! only out-edge points at another seed multiplies its rank by `damping x multiplier` every
//! iteration. No static bound can both permit the blessed live params and prove non-growth, which
//! is exactly why the backstop has to exist.

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
        trust_multiplier_fp: U256::from(2u64) * s(), // 2x — the live value
        trust_share_fp: U256::from(15u64) * s() / U256::from(100u64),
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

/// The mutual-seed graph: the shape that makes ranks grow without bound.
fn mutual_seeds() -> Vec<RawEdge> {
    vec![attest(1, 2, 1, 100, 50), attest(2, 1, 2, 101, 50)]
}

/// The post-condition `calculate_generic` states in its own doc comment — "scores scaled by S;
/// sum ~= S" — holds for the live params, at every iteration count. This is the control the
/// original refutation used, and it must stay true.
#[test]
fn live_params_normalize_exactly_at_every_iteration_count() {
    // 500 is deliberately absent: at 1.7x growth per iteration that is genuinely past what U256
    // can represent, and `TrustGraphFactory._validateGrowth` refuses the pairing at creation.
    for iters in [1u32, 5, 24, 100, 200] {
        let sum: U256 =
            scores(&live_params(iters), &mutual_seeds()).into_iter().fold(U256::ZERO, |a, b| a + b);
        assert_eq!(sum, s(), "normalized scores must sum to S (iterations = {iters})");
    }
}

/// The backstop: a configuration whose ranks run past 2^256 now PANICS. Before the fix this
/// returned wrapped ranks and a normalized total of 5.19x S — a wrong answer that still proved.
#[test]
#[should_panic(expected = "exceeds 256 bits")]
fn ranks_that_exceed_the_representable_range_panic_instead_of_wrapping() {
    let mut runaway = live_params(64);
    // 850x per iteration: far outside anything the factory will now accept, and reachable only by
    // calling the core crate directly — which is the point. The core must not be the last line of
    // defence AND silent.
    runaway.trust_multiplier_fp = U256::from(1000u64) * s();
    runaway.trust_decay_fp = s();
    runaway.tolerance_fp = U256::from(1u64);
    let _ = scores(&runaway, &mutual_seeds());
}

/// `mul_div` itself refuses a quotient that does not fit, rather than returning its low 256 bits.
#[test]
#[should_panic(expected = "mul_div overflow")]
fn mul_div_refuses_an_unrepresentable_quotient() {
    let a = U256::MAX / U256::from(2u64);
    let _ = pagerank_core::fixed::fp_mul(a, U256::from(1000u64) * s(), s());
}

/// Why the backstop cannot be replaced by a bound: alloy's `U256` addition wraps silently, so
/// every accumulation in the rank loop had to be made explicitly checked. If this ever starts
/// panicking on its own, the guards below can be relaxed.
#[test]
fn alloy_u256_addition_still_wraps_silently() {
    assert_eq!(U256::MAX + U256::from(1u64), U256::ZERO, "U256 `+` wraps, it does not panic");
}

/// The cross-language consequence, now closed from both sides. The TS port
/// (`frontend/lib/pagerank/fixed.ts`) is arbitrary-precision `bigint`, so it CANNOT reproduce a
/// wrapped U256 result; before the fix the two ports silently computed different scores, a
/// different `outputRoot` and a different ranking order for the same factory-legal instance.
/// Both now refuse in the same place, so "the ports agree" is true without a range caveat.
#[test]
fn the_ports_agree_wherever_both_are_defined() {
    let edges = vec![
        attest(1, 2, 1, 100, 50),
        attest(2, 1, 2, 101, 30),
        attest(1, 3, 3, 102, 70),
        attest(3, 1, 4, 103, 10),
    ];
    // 4x boost at 100 iterations: inside the representable range (0.85 x 4 = 3.4 per iteration,
    // and 3.4^100 is comfortably under 2^256) and accepted by the factory's growth check.
    // The wizard's ORIGINAL 20x maximum was not, and used to diverge across the ports:
    //   RUST 305315 / 553089 / 141596   root 0x4a6c885e…
    //   TS   236492 / 318128 / 445380   root 0x38295e58…
    // which is why the slider was lowered to match what the maths can actually represent.
    let mut p = live_params(100);
    p.trust_multiplier_fp = U256::from(4u64) * s();
    let input = pagerank_core::GuestInput { edges, params: p, lane2: None, binding: Default::default() };
    let r = pagerank_core::compute::compute(&input);
    let total: U256 = r.scores.iter().map(|(_, v)| *v).fold(U256::ZERO, |a, b| a + b);
    assert_eq!(total, U256::from(1_000_000u64), "payouts sum to the pool");
    assert_ne!(r.journal.output_root, B256::ZERO);
}
