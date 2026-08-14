//! Exact mass-conserving personalized PageRank for the weighted-prior program.

use std::collections::{BTreeMap, BTreeSet};

use alloy_primitives::Address;

use crate::{
    reconcile::{FlatGraph, Graph},
    Params, PriorEntry, WeightedError, SCALE,
};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Iteration {
    /// The exact damping allocation across source accounts.
    pub source_budgets: BTreeMap<Address, u64>,
    /// Source budget whose row has no positive, non-self outgoing weight.
    pub dangling_budget: u64,
    /// The combined `(S - d) + dangling_budget` allocated once across the prior.
    pub prior_budget: u64,
    /// The next normalized rank vector, including zero-mass graph-only nodes.
    pub scores: BTreeMap<Address, u64>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RankResult {
    pub scores: BTreeMap<Address, u64>,
    pub iterations: u32,
}

/// Hamilton/largest-remainder allocation of `budget` across `items / denominator`.
///
/// The caller supplies items in any order. This function validates that their numerators sum to
/// `denominator`, returns address-sorted results, and resolves equal remainders by address.
pub fn apportion(
    items: &[(Address, u64)],
    budget: u64,
    denominator: u128,
) -> Result<BTreeMap<Address, u64>, WeightedError> {
    if items.is_empty() || denominator == 0 {
        return Err(WeightedError::InvalidApportionment);
    }

    let mut seen = BTreeSet::new();
    let mut numerator_sum = 0u128;
    let mut rows = Vec::with_capacity(items.len());
    for (account, numerator) in items {
        if !seen.insert(*account) {
            return Err(WeightedError::InvalidApportionment);
        }
        numerator_sum = numerator_sum
            .checked_add(u128::from(*numerator))
            .ok_or(WeightedError::ArithmeticOverflow)?;
        let product = u128::from(*numerator)
            .checked_mul(u128::from(budget))
            .ok_or(WeightedError::ArithmeticOverflow)?;
        let floor =
            u64::try_from(product / denominator).map_err(|_| WeightedError::ArithmeticOverflow)?;
        rows.push((*account, floor, product % denominator));
    }
    if numerator_sum != denominator {
        return Err(WeightedError::InvalidApportionment);
    }

    let floor_sum = rows.iter().try_fold(0u64, |sum, (_, floor, _)| {
        sum.checked_add(*floor).ok_or(WeightedError::ArithmeticOverflow)
    })?;
    let missing = budget.checked_sub(floor_sum).ok_or(WeightedError::InvalidApportionment)?;
    if missing as usize > rows.len() {
        return Err(WeightedError::InvalidApportionment);
    }

    let mut remainder_order = (0..rows.len()).collect::<Vec<_>>();
    remainder_order.sort_by(|left, right| {
        rows[*right].2.cmp(&rows[*left].2).then_with(|| rows[*left].0.cmp(&rows[*right].0))
    });
    for index in remainder_order.into_iter().take(missing as usize) {
        rows[index].1 = rows[index].1.checked_add(1).ok_or(WeightedError::ArithmeticOverflow)?;
    }

    rows.sort_by_key(|(account, _, _)| *account);
    Ok(rows.into_iter().map(|(account, value, _)| (account, value)).collect())
}

fn node_universe(graph: &Graph, prior: &[PriorEntry]) -> Vec<Address> {
    prior
        .iter()
        .map(|entry| entry.account)
        .chain(graph.nodes.iter().copied())
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect()
}

pub fn initial_scores(graph: &Graph, prior: &[PriorEntry]) -> BTreeMap<Address, u64> {
    let prior_by_account =
        prior.iter().map(|entry| (entry.account, entry.weight)).collect::<BTreeMap<_, _>>();
    node_universe(graph, prior)
        .into_iter()
        .map(|account| (account, prior_by_account.get(&account).copied().unwrap_or(0)))
        .collect()
}

/// Evaluate one normative iteration. The returned source, dangling, prior, and final allocations
/// are intentionally public so golden/property tests can pin every rounding boundary.
pub fn next_iteration(
    graph: &Graph,
    prior: &[PriorEntry],
    current: &BTreeMap<Address, u64>,
    damping_fp: u64,
) -> Result<Iteration, WeightedError> {
    let current_sum = current.values().try_fold(0u64, |sum, value| {
        sum.checked_add(*value).ok_or(WeightedError::ArithmeticOverflow)
    })?;
    if current_sum != SCALE {
        return Err(WeightedError::InvalidNormalizedSum(current_sum));
    }

    let source_items = current.iter().map(|(account, rank)| (*account, *rank)).collect::<Vec<_>>();
    let source_budgets = apportion(&source_items, damping_fp, u128::from(SCALE))?;
    let mut scores = current.keys().map(|account| (*account, 0u64)).collect::<BTreeMap<_, _>>();
    let mut dangling_budget = 0u64;

    for (source, source_budget) in &source_budgets {
        let transition = graph.outgoing.get(source).map(|row| {
            row.iter()
                .filter(|(target, weight)| **target != *source && **weight > 0)
                .map(|(target, weight)| (*target, *weight))
                .collect::<Vec<_>>()
        });
        let Some(transition) = transition.filter(|row| !row.is_empty()) else {
            dangling_budget = dangling_budget
                .checked_add(*source_budget)
                .ok_or(WeightedError::ArithmeticOverflow)?;
            continue;
        };
        let denominator = transition.iter().try_fold(0u128, |sum, (_, weight)| {
            sum.checked_add(u128::from(*weight)).ok_or(WeightedError::ArithmeticOverflow)
        })?;
        for (target, contribution) in apportion(&transition, *source_budget, denominator)? {
            let value = scores.entry(target).or_insert(0);
            *value = value.checked_add(contribution).ok_or(WeightedError::ArithmeticOverflow)?;
        }
    }

    let prior_budget = SCALE
        .checked_sub(damping_fp)
        .and_then(|base| base.checked_add(dangling_budget))
        .ok_or(WeightedError::ArithmeticOverflow)?;
    let prior_items = prior.iter().map(|entry| (entry.account, entry.weight)).collect::<Vec<_>>();
    for (account, contribution) in apportion(&prior_items, prior_budget, u128::from(SCALE))? {
        let value = scores.entry(account).or_insert(0);
        *value = value.checked_add(contribution).ok_or(WeightedError::ArithmeticOverflow)?;
    }

    let score_sum = scores.values().try_fold(0u64, |sum, value| {
        sum.checked_add(*value).ok_or(WeightedError::ArithmeticOverflow)
    })?;
    if score_sum != SCALE {
        return Err(WeightedError::InvalidNormalizedSum(score_sum));
    }

    Ok(Iteration { source_budgets, dangling_budget, prior_budget, scores })
}

pub fn calculate(
    graph: &Graph,
    prior: &[PriorEntry],
    params: &Params,
) -> Result<RankResult, WeightedError> {
    calculate_indexed(graph, prior, params)
}

/// Clear address-keyed reference implementation. Property tests compare this against the indexed
/// guest kernel; it is intentionally retained as the audit oracle for optimized consensus code.
pub fn calculate_reference(
    graph: &Graph,
    prior: &[PriorEntry],
    params: &Params,
) -> Result<RankResult, WeightedError> {
    let mut current = initial_scores(graph, prior);
    for iteration in 1..=params.max_iterations {
        let next = next_iteration(graph, prior, &current, params.damping_fp)?;
        let max_delta = current
            .iter()
            .map(|(account, value)| value.abs_diff(next.scores[account]))
            .max()
            .unwrap_or(0);
        current = next.scores;
        if max_delta < params.tolerance_fp {
            return Ok(RankResult { scores: current, iterations: iteration });
        }
    }
    Ok(RankResult { scores: current, iterations: params.max_iterations })
}

/// Exact `(numerator * budget) / denominator` without the compiler's very expensive software
/// `u128` division on RISC-V. Valid Hamilton inputs guarantee the quotient fits `u64`.
fn mul_div_rem(
    numerator: u64,
    budget: u64,
    denominator: u128,
) -> Result<(u64, u128), WeightedError> {
    if denominator == 0 {
        return Err(WeightedError::InvalidApportionment);
    }
    if denominator == u128::from(SCALE) && numerator <= SCALE && budget <= SCALE {
        return mul_scale_rem(numerator, budget)
            .map(|(quotient, remainder)| (quotient, u128::from(remainder)));
    }
    if let Ok(denominator_u64) = u64::try_from(denominator) {
        if let Some(product) = numerator.checked_mul(budget) {
            return Ok((product / denominator_u64, u128::from(product % denominator_u64)));
        }

        let product = u128::from(numerator) * u128::from(budget);
        let high = (product >> 64) as u64;
        let low = product as u64;
        if high >= denominator_u64 {
            return Err(WeightedError::ArithmeticOverflow);
        }
        let mut quotient = 0u64;
        let mut remainder = u128::from(high);
        let divisor = u128::from(denominator_u64);
        for bit in (0..64).rev() {
            remainder = (remainder << 1) | u128::from((low >> bit) & 1);
            if remainder >= divisor {
                remainder -= divisor;
                quotient |= 1u64 << bit;
            }
        }
        return Ok((quotient, remainder));
    }

    // A transition denominator can exceed u64 only when a row's relative weights sum above
    // 2^64-1. Preserve the full V1 domain; ordinary bounded-degree rows stay on the fast path.
    let product = u128::from(numerator)
        .checked_mul(u128::from(budget))
        .ok_or(WeightedError::ArithmeticOverflow)?;
    Ok((
        u64::try_from(product / denominator).map_err(|_| WeightedError::ArithmeticOverflow)?,
        product % denominator,
    ))
}

/// Exact `(numerator * budget) / 10^18` using only bounded `u64` operations. Splitting both
/// operands at `10^9` makes every partial product smaller than `2 * 10^18`, so the SP1 guest
/// avoids a 64-round software `u128 / u64` loop for its source and prior allocations.
fn mul_scale_rem(numerator: u64, budget: u64) -> Result<(u64, u64), WeightedError> {
    const BASE: u64 = 1_000_000_000;
    let numerator_high = numerator / BASE;
    let numerator_low = numerator % BASE;
    let budget_high = budget / BASE;
    let budget_low = budget % BASE;

    let high = numerator_high.checked_mul(budget_high).ok_or(WeightedError::ArithmeticOverflow)?;
    let cross = numerator_high
        .checked_mul(budget_low)
        .and_then(|left| {
            numerator_low.checked_mul(budget_high).and_then(|right| left.checked_add(right))
        })
        .ok_or(WeightedError::ArithmeticOverflow)?;
    let tail = (cross % BASE)
        .checked_mul(BASE)
        .and_then(|value| {
            numerator_low.checked_mul(budget_low).and_then(|low| value.checked_add(low))
        })
        .ok_or(WeightedError::ArithmeticOverflow)?;
    let quotient = high
        .checked_add(cross / BASE)
        .and_then(|value| value.checked_add(tail / SCALE))
        .ok_or(WeightedError::ArithmeticOverflow)?;
    Ok((quotient, tail % SCALE))
}

fn allocate_indexed(
    numerators: &[u64],
    budget: u64,
    denominator: u128,
) -> Result<Vec<u64>, WeightedError> {
    if numerators.is_empty() || denominator == 0 {
        return Err(WeightedError::InvalidApportionment);
    }
    let sum = numerators.iter().try_fold(0u128, |total, numerator| {
        total.checked_add(u128::from(*numerator)).ok_or(WeightedError::ArithmeticOverflow)
    })?;
    if sum != denominator {
        return Err(WeightedError::InvalidApportionment);
    }

    let mut values = Vec::with_capacity(numerators.len());
    let mut remainders = Vec::with_capacity(numerators.len());
    let mut floor_sum = 0u64;
    for numerator in numerators {
        let (floor, remainder) = mul_div_rem(*numerator, budget, denominator)?;
        floor_sum = floor_sum.checked_add(floor).ok_or(WeightedError::ArithmeticOverflow)?;
        values.push(floor);
        remainders.push(remainder);
    }
    let missing = budget.checked_sub(floor_sum).ok_or(WeightedError::InvalidApportionment)?;
    if missing as usize > values.len() {
        return Err(WeightedError::InvalidApportionment);
    }
    let mut order = (0..values.len()).collect::<Vec<_>>();
    order.sort_by(|left, right| {
        remainders[*right].cmp(&remainders[*left]).then_with(|| left.cmp(right))
    });
    for index in order.into_iter().take(missing as usize) {
        values[index] = values[index].checked_add(1).ok_or(WeightedError::ArithmeticOverflow)?;
    }
    Ok(values)
}

fn calculate_indexed(
    graph: &Graph,
    prior: &[PriorEntry],
    params: &Params,
) -> Result<RankResult, WeightedError> {
    let nodes = node_universe(graph, prior);
    let indices = nodes
        .iter()
        .enumerate()
        .map(|(index, account)| (*account, index))
        .collect::<BTreeMap<_, _>>();
    let mut prior_weights = vec![0u64; nodes.len()];
    for entry in prior {
        prior_weights[indices[&entry.account]] = entry.weight;
    }
    let mut outgoing = vec![Vec::<(usize, u64)>::new(); nodes.len()];
    for (source, row) in &graph.outgoing {
        let Some(source_index) = indices.get(source).copied() else { continue };
        for (target, weight) in row {
            let Some(target_index) = indices.get(target).copied() else { continue };
            if target_index != source_index && *weight > 0 {
                outgoing[source_index].push((target_index, *weight));
            }
        }
    }

    run_indexed(nodes, prior_weights, outgoing, params)
}

pub fn calculate_flat(
    graph: &FlatGraph,
    prior: &[PriorEntry],
    params: &Params,
) -> Result<RankResult, WeightedError> {
    let nodes = prior
        .iter()
        .map(|entry| entry.account)
        .chain(graph.nodes.iter().copied())
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect::<Vec<_>>();
    let indices = nodes
        .iter()
        .enumerate()
        .map(|(index, account)| (*account, index))
        .collect::<BTreeMap<_, _>>();
    let mut prior_weights = vec![0u64; nodes.len()];
    for entry in prior {
        prior_weights[indices[&entry.account]] = entry.weight;
    }
    let mut outgoing = vec![Vec::<(usize, u64)>::new(); nodes.len()];
    for (source, target, weight) in &graph.edges {
        let source_index = indices[source];
        let target_index = indices[target];
        if source_index != target_index && *weight > 0 {
            outgoing[source_index].push((target_index, *weight));
        }
    }
    run_indexed(nodes, prior_weights, outgoing, params)
}

fn run_indexed(
    nodes: Vec<Address>,
    prior_weights: Vec<u64>,
    outgoing: Vec<Vec<(usize, u64)>>,
    params: &Params,
) -> Result<RankResult, WeightedError> {
    let mut current = prior_weights.clone();
    let mut completed = params.max_iterations;
    for iteration in 1..=params.max_iterations {
        let source_budgets = allocate_indexed(&current, params.damping_fp, u128::from(SCALE))?;
        let mut next = vec![0u64; nodes.len()];
        let mut dangling = 0u64;
        for (source_index, source_budget) in source_budgets.into_iter().enumerate() {
            let row = &outgoing[source_index];
            if row.is_empty() {
                dangling =
                    dangling.checked_add(source_budget).ok_or(WeightedError::ArithmeticOverflow)?;
                continue;
            }
            let weights = row.iter().map(|(_, weight)| *weight).collect::<Vec<_>>();
            let denominator = weights.iter().try_fold(0u128, |sum, weight| {
                sum.checked_add(u128::from(*weight)).ok_or(WeightedError::ArithmeticOverflow)
            })?;
            let contributions = allocate_indexed(&weights, source_budget, denominator)?;
            for ((target, _), contribution) in row.iter().zip(contributions) {
                next[*target] = next[*target]
                    .checked_add(contribution)
                    .ok_or(WeightedError::ArithmeticOverflow)?;
            }
        }

        let prior_budget = SCALE
            .checked_sub(params.damping_fp)
            .and_then(|base| base.checked_add(dangling))
            .ok_or(WeightedError::ArithmeticOverflow)?;
        let teleport = allocate_indexed(&prior_weights, prior_budget, u128::from(SCALE))?;
        for (score, contribution) in next.iter_mut().zip(teleport) {
            *score = score.checked_add(contribution).ok_or(WeightedError::ArithmeticOverflow)?;
        }
        let sum = next.iter().try_fold(0u64, |total, value| {
            total.checked_add(*value).ok_or(WeightedError::ArithmeticOverflow)
        })?;
        if sum != SCALE {
            return Err(WeightedError::InvalidNormalizedSum(sum));
        }
        let max_delta = current
            .iter()
            .zip(&next)
            .map(|(previous, following)| previous.abs_diff(*following))
            .max()
            .unwrap_or(0);
        current = next;
        if max_delta < params.tolerance_fp {
            completed = iteration;
            break;
        }
    }

    Ok(RankResult { scores: nodes.into_iter().zip(current).collect(), iterations: completed })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn account(byte: u8) -> Address {
        Address::from([byte; 20])
    }

    fn prior() -> Vec<PriorEntry> {
        vec![
            PriorEntry { account: account(1), weight: 500_000_000_000_000_000 },
            PriorEntry { account: account(2), weight: 500_000_000_000_000_000 },
        ]
    }

    #[test]
    fn hamilton_ties_use_address_order() {
        let rows = apportion(&[(account(3), 1), (account(1), 1), (account(2), 1)], 2, 3).unwrap();
        assert_eq!(rows[&account(1)], 1);
        assert_eq!(rows[&account(2)], 1);
        assert_eq!(rows[&account(3)], 0);
    }

    #[test]
    fn empty_graph_is_byte_exact_prior_and_conserves_every_budget() {
        let graph = Graph::default();
        let current = initial_scores(&graph, &prior());
        let step = next_iteration(&graph, &prior(), &current, 850_000_000_000_000_000).unwrap();
        assert_eq!(step.scores, current);
        assert_eq!(step.source_budgets.values().sum::<u64>(), 850_000_000_000_000_000);
        assert_eq!(step.dangling_budget, 850_000_000_000_000_000);
        assert_eq!(step.prior_budget, SCALE);
        assert_eq!(step.scores.values().sum::<u64>(), SCALE);
    }

    #[test]
    fn disconnected_nonprior_component_receives_no_mass() {
        let mut graph = Graph { nodes: vec![account(3), account(4)], ..Graph::default() };
        graph.outgoing.insert(account(3), BTreeMap::from([(account(4), 1)]));
        graph.outgoing.insert(account(4), BTreeMap::from([(account(3), 1)]));
        let current = initial_scores(&graph, &prior());
        let step = next_iteration(&graph, &prior(), &current, 850_000_000_000_000_000).unwrap();
        assert_eq!(step.scores[&account(3)], 0);
        assert_eq!(step.scores[&account(4)], 0);
        assert_eq!(step.scores.values().sum::<u64>(), SCALE);
    }

    #[test]
    fn self_only_row_is_dangling() {
        let mut graph = Graph { nodes: vec![account(1)], ..Graph::default() };
        graph.outgoing.insert(account(1), BTreeMap::from([(account(1), 100)]));
        let current = initial_scores(&graph, &prior());
        let step = next_iteration(&graph, &prior(), &current, 850_000_000_000_000_000).unwrap();
        assert_eq!(step.dangling_budget, 850_000_000_000_000_000);
        assert_eq!(step.scores, current);
    }

    #[test]
    fn fast_mul_div_matches_u128_for_overflowing_products() {
        for (numerator, budget, denominator) in [
            (SCALE, SCALE - 1, SCALE),
            (SCALE - 17, 850_000_000_000_000_000, SCALE),
            (u64::MAX - 2, 17, u64::MAX),
            (123_456_789_012_345_678, 987_654_321_098_765_432, SCALE),
        ] {
            let product = u128::from(numerator) * u128::from(budget);
            assert_eq!(
                mul_div_rem(numerator, budget, u128::from(denominator)).unwrap(),
                ((product / u128::from(denominator)) as u64, product % u128::from(denominator))
            );
        }
    }

    #[test]
    fn decimal_scale_division_matches_u128_boundaries() {
        for numerator in
            [0, 1, 999_999_999, 1_000_000_000, 123_456_789_012_345_678, SCALE - 1, SCALE]
        {
            for budget in [
                0,
                1,
                999_999_999,
                1_000_000_000,
                150_000_000_000_000_000,
                850_000_000_000_000_000,
                SCALE - 1,
                SCALE,
            ] {
                let product = u128::from(numerator) * u128::from(budget);
                assert_eq!(
                    mul_scale_rem(numerator, budget).unwrap(),
                    ((product / u128::from(SCALE)) as u64, (product % u128::from(SCALE)) as u64)
                );
            }
        }
    }
}
