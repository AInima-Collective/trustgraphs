//! Point distribution — the integer port of `graph_computer.rs::distribute_points`.
//!
//! Scores (scaled by S) are re-scaled to the legacy 1e6 quantum, sorted descending (ties broken by
//! address ascending — a determinism fix over the legacy HashMap-order tie), and paid out
//! proportionally; the last account absorbs the remainder so the total equals `total_pool` exactly.

use crate::fixed::mul_div;
use crate::Params;
use alloy_primitives::{Address, U256};

/// The legacy precision quantum: `f64` scores were scaled to `u64` by 1e6 before distribution.
const QUANTUM: u64 = 1_000_000;

/// Distribute `total_pool` across `scores_fp` (normalized PageRank scores, scaled by S, `value > 0`).
/// Returns `(assigned, total_value)` where `assigned` holds only `value > 0` entries and
/// `total_value == total_pool` whenever anything is distributed.
pub fn distribute_points(scores_fp: &[(Address, U256)], p: &Params) -> (Vec<(Address, U256)>, U256) {
    if scores_fp.is_empty() {
        return (Vec::new(), U256::ZERO);
    }
    let s = p.precision_scale;
    let quantum = U256::from(QUANTUM);

    // score * 1e6 (truncating), kept as U256.
    let mut scaled: Vec<(Address, U256)> =
        scores_fp.iter().map(|(a, sc)| (*a, mul_div(*sc, quantum, s))).collect();

    let total_scaled: U256 = scaled.iter().map(|(_, v)| *v).fold(U256::ZERO, |a, b| a + b);
    if total_scaled.is_zero() {
        return (Vec::new(), U256::ZERO);
    }

    // Sort by scaled score descending, then address ascending (deterministic tie-break).
    scaled.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(&b.0)));

    let total_pool = p.total_pool;
    let mut remaining = total_pool;
    let mut assigned: Vec<(Address, U256)> = Vec::new();
    let len = scaled.len();

    for (i, (addr, sc)) in scaled.iter().enumerate() {
        let points = if i == len - 1 {
            remaining
        } else {
            let proportional = mul_div(*sc, total_pool, total_scaled);
            if proportional > remaining {
                remaining
            } else {
                proportional
            }
        };
        let actual = if points > remaining { remaining } else { points };
        if !actual.is_zero() {
            remaining -= actual;
            assigned.push((*addr, actual));
        }
        if remaining.is_zero() {
            break;
        }
    }

    let total_value: U256 = assigned.iter().map(|(_, v)| *v).fold(U256::ZERO, |a, b| a + b);
    (assigned, total_value)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tests::default_params;

    #[test]
    fn distributes_exactly_the_pool() {
        let mut p = default_params();
        p.total_pool = U256::from(1_000_000u64);
        let s = p.precision_scale;
        // three normalized scores summing to S.
        let scores = vec![
            (Address::from([1; 20]), s / U256::from(2)),
            (Address::from([2; 20]), s / U256::from(3)),
            (Address::from([3; 20]), s / U256::from(6)),
        ];
        let (assigned, total) = distribute_points(&scores, &p);
        assert_eq!(total, p.total_pool, "must distribute the whole pool");
        assert!(assigned.iter().all(|(_, v)| !v.is_zero()));
    }

    #[test]
    fn empty_scores_distribute_nothing() {
        let p = default_params();
        let (assigned, total) = distribute_points(&[], &p);
        assert!(assigned.is_empty());
        assert_eq!(total, U256::ZERO);
    }
}
