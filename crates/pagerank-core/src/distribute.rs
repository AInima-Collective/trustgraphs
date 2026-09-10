//! Full-precision Hamilton allocation of an integer pool across positive scores.
//!
//! Each account receives its exact proportional floor, then the remaining units go to the
//! largest fractional remainders (ties by key ascending). Zero scores receive nothing. This
//! preserves the entire pool without quantizing away low scores or favoring the last account.

use crate::Params;
use alloy_primitives::{Address, U256, U512};

/// Key-generic Hamilton allocation. Scores must have unique keys and a sum fitting U256.
/// The scale is retained in this shared API; proportional allocation depends on the actual
/// sum of scores, which may be below the scale after fixed-point arithmetic.
pub fn distribute_points_generic<K: Ord + Copy>(
    scores_fp: &[(K, U256)],
    _scale: U256,
    total_pool: U256,
) -> (Vec<(K, U256)>, U256) {
    let mut scores: Vec<_> = scores_fp.iter().copied().filter(|(_, v)| !v.is_zero()).collect();
    scores.sort_by_key(|(key, _)| *key);
    assert!(scores.windows(2).all(|pair| pair[0].0 != pair[1].0), "duplicate allocation key");
    if scores.is_empty() || total_pool.is_zero() {
        return (Vec::new(), U256::ZERO);
    }
    let total = scores
        .iter()
        .try_fold(U256::ZERO, |sum, (_, value)| sum.checked_add(*value))
        .expect("allocation score sum overflow");
    let denominator = U512::from(total);
    let mut rows = Vec::with_capacity(scores.len());
    let mut floor_sum = U256::ZERO;
    for (key, score) in scores {
        let product = U512::from(score) * U512::from(total_pool);
        // score <= total, so each quotient is <= total_pool and fits U256.
        let (quotient, remainder) = product.div_rem(denominator);
        let floor = U256::from(quotient);
        floor_sum = floor_sum.checked_add(floor).expect("allocation floor sum overflow");
        rows.push((key, floor, remainder));
    }
    let missing = total_pool.checked_sub(floor_sum).expect("allocation exceeds pool");
    assert!(missing < U256::from(rows.len()), "invalid Hamilton remainder");
    let missing = missing.to::<usize>();
    let mut order: Vec<_> = (0..rows.len()).collect();
    order.sort_by(|a, b| rows[*b].2.cmp(&rows[*a].2).then(rows[*a].0.cmp(&rows[*b].0)));
    for index in order.into_iter().take(missing) {
        rows[index].1 = rows[index].1.checked_add(U256::from(1)).expect("allocation overflow");
    }
    let assigned = rows
        .into_iter()
        .filter_map(|(key, value, _)| (!value.is_zero()).then_some((key, value)))
        .collect();
    (assigned, total_pool)
}

/// Distribute `total_pool` across `scores_fp` (normalized PageRank scores, scaled by S,
/// `value > 0`) — the trust-graph program's Address-keyed entry (public API unchanged).
pub fn distribute_points(
    scores_fp: &[(Address, U256)],
    p: &Params,
) -> (Vec<(Address, U256)>, U256) {
    distribute_points_generic(scores_fp, p.precision_scale, p.total_pool)
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
