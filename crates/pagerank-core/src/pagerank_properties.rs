use crate::distribute::distribute_points_generic;
use crate::fixed::{fp_div, fp_mul};
use crate::pagerank::{calculate_generic, calculate_generic_detailed, RankConfig};
use crate::pagerank_oracle;
use alloy_primitives::U256;
use proptest::prelude::*;
use std::collections::{BTreeMap, BTreeSet};
use std::panic::{catch_unwind, AssertUnwindSafe};

fn scale() -> U256 {
    U256::from(10u64).pow(U256::from(18u64))
}

fn config(
    node_count: usize,
    seed_count: usize,
    damping_percent: u8,
    trust_share_percent: u8,
    decay_percent: u8,
    tolerance: u64,
    max_iterations: u8,
) -> RankConfig<u8> {
    let s = scale();
    RankConfig {
        damping_fp: s * U256::from(damping_percent) / U256::from(100u64),
        tolerance_fp: U256::from(tolerance),
        max_iterations: u32::from(max_iterations),
        trust_share_fp: s * U256::from(trust_share_percent) / U256::from(100u64),
        trust_decay_fp: s * U256::from(decay_percent) / U256::from(100u64),
        scale: s,
        seeds: (0..seed_count.min(node_count) as u8).collect(),
    }
}

fn closed_graph(
    node_count: usize,
    raw_edges: &[(u8, u8, u16)],
) -> (Vec<u8>, BTreeMap<u8, BTreeMap<u8, U256>>) {
    let nodes: Vec<u8> = (0..node_count as u8).collect();
    let mut outgoing = BTreeMap::<u8, BTreeMap<u8, U256>>::new();
    for (raw_source, raw_target, raw_weight) in raw_edges {
        let source = usize::from(*raw_source) % node_count;
        let target = usize::from(*raw_target) % node_count;
        outgoing.entry(source as u8).or_default().insert(target as u8, U256::from(*raw_weight));
    }
    (nodes, outgoing)
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(256))]

    #[test]
    fn push_is_bit_identical_to_pull_over_admissible_graphs(
        node_count in 1usize..14,
        raw_edges in prop::collection::vec((any::<u8>(), any::<u8>(), any::<u16>()), 0..80),
        seed_count in 0usize..14,
        damping in prop::sample::select(vec![0u8, 1, 50, 85, 99, 100]),
        trust_share in prop::sample::select(vec![0u8, 1, 15, 50, 99, 100]),
        decay in prop::sample::select(vec![0u8, 1, 60, 80, 99, 100]),
        tolerance in prop::sample::select(vec![0u64, 1, 1_000_000_000_000]),
        max_iterations in 0u8..16,
    ) {
        let (nodes, outgoing) = closed_graph(node_count, &raw_edges);
        let cfg = config(
            node_count,
            seed_count,
            damping,
            trust_share,
            decay,
            tolerance,
            max_iterations,
        );

        let old = pagerank_oracle::calculate(&nodes, &outgoing, &cfg);
        let new = calculate_generic(&nodes, &outgoing, &cfg);
        let normalized_total = new.values().copied().fold(U256::ZERO, |sum, value| sum + value);
        if !normalized_total.is_zero() {
            prop_assert_eq!(normalized_total, scale());

            let scores: Vec<_> = new.iter().map(|(node, score)| (*node, *score)).collect();
            let (_, distributed) = distribute_points_generic(
                &scores,
                scale(),
                U256::from(1_000_000u64),
            );
            prop_assert_eq!(distributed, U256::from(1_000_000u64));
        }
        prop_assert_eq!(new, old);
    }

    #[test]
    fn graph_is_closed_and_ranking_ignores_row_insertion_order(
        node_count in 1usize..24,
        raw_edges in prop::collection::vec((any::<u8>(), any::<u8>(), any::<u16>()), 0..120),
    ) {
        let (nodes, outgoing) = closed_graph(node_count, &raw_edges);
        let node_set: BTreeSet<_> = nodes.iter().copied().collect();
        for (source, row) in &outgoing {
            prop_assert!(node_set.contains(source));
            prop_assert!(row.keys().all(|target| node_set.contains(target)));
        }

        let mut reversed = BTreeMap::new();
        for (source, row) in outgoing.iter().rev() {
            reversed.insert(*source, row.iter().rev().map(|(k, v)| (*k, *v)).collect());
        }
        let cfg = config(node_count, 1, 85, 100, 80, 1_000_000_000_000, 20);
        prop_assert_eq!(
            calculate_generic(&nodes, &outgoing, &cfg),
            calculate_generic(&nodes, &reversed, &cfg),
        );
    }
}

#[test]
fn convergence_telemetry_preserves_unreachable_skip_rule() {
    let nodes = vec![0u8, 1, 2, 3];
    let outgoing = BTreeMap::from([
        (0, BTreeMap::from([(1, U256::from(1u64))])),
        (2, BTreeMap::from([(3, U256::from(1u64))])),
    ]);
    let cfg = config(4, 1, 85, 100, 80, u64::MAX, 100);
    let result = calculate_generic_detailed(&nodes, &outgoing, &cfg);
    assert_eq!(result.iterations, 1);
    assert!(result.converged);
    assert_eq!(result.scores, pagerank_oracle::calculate(&nodes, &outgoing, &cfg));
}

#[test]
fn outgoing_sum_overflow_rejection_matches_pull_oracle() {
    let nodes = vec![0u8, 1, 2];
    let outgoing = BTreeMap::from([(0, BTreeMap::from([(1, U256::MAX), (2, U256::from(1u64))]))]);
    let cfg = config(3, 0, 85, 0, 0, 0, 1);

    let old =
        catch_unwind(AssertUnwindSafe(|| pagerank_oracle::calculate(&nodes, &outgoing, &cfg)));
    let new = catch_unwind(AssertUnwindSafe(|| calculate_generic(&nodes, &outgoing, &cfg)));
    assert!(old.is_err());
    assert!(new.is_err());
}

#[test]
fn malformed_edge_endpoints_are_rejected() {
    let nodes = vec![0u8, 1];
    let missing_source = BTreeMap::from([(2, BTreeMap::from([(1, U256::from(1u64))]))]);
    let missing_target = BTreeMap::from([(0, BTreeMap::from([(2, U256::from(1u64))]))]);
    let cfg = config(2, 0, 85, 0, 0, 0, 1);

    assert!(catch_unwind(AssertUnwindSafe(|| {
        calculate_generic(&nodes, &missing_source, &cfg)
    }))
    .is_err());
    assert!(catch_unwind(AssertUnwindSafe(|| {
        calculate_generic(&nodes, &missing_target, &cfg)
    }))
    .is_err());
}

#[test]
fn disconnected_component_is_exactly_gated_and_metamorphic() {
    let connected_nodes = vec![10u8, 11, 12];
    let connected_edges = BTreeMap::from([
        (10, BTreeMap::from([(11, U256::from(3u64))])),
        (11, BTreeMap::from([(12, U256::from(2u64))])),
        (12, BTreeMap::from([(10, U256::from(1u64))])),
    ]);
    let cfg = RankConfig {
        damping_fp: scale() * U256::from(85u64) / U256::from(100u64),
        tolerance_fp: U256::from(1_000_000u64),
        max_iterations: 100,
        trust_share_fp: scale(),
        trust_decay_fp: scale() * U256::from(80u64) / U256::from(100u64),
        scale: scale(),
        seeds: BTreeSet::from([10]),
    };
    let baseline = calculate_generic(&connected_nodes, &connected_edges, &cfg);

    for disconnected_edges in [
        BTreeMap::from([(1, BTreeMap::from([(2, U256::from(1u64))]))]),
        BTreeMap::from([
            (1, BTreeMap::from([(2, U256::from(7u64))])),
            (2, BTreeMap::from([(1, U256::from(9u64))])),
        ]),
        BTreeMap::from([(2, BTreeMap::from([(1, U256::from(5u64))]))]),
    ] {
        let nodes = vec![1u8, 2, 10, 11, 12];
        let mut edges = connected_edges.clone();
        edges.extend(disconnected_edges);
        let scores = calculate_generic(&nodes, &edges, &cfg);
        assert_eq!(scores[&1], U256::ZERO);
        assert_eq!(scores[&2], U256::ZERO);
        for node in &connected_nodes {
            assert_eq!(scores[node], baseline[node]);
        }
    }
}

#[test]
fn absent_seeds_join_the_ranked_universe_once_in_canonical_order() {
    let nodes = vec![9u8];
    let cfg = RankConfig {
        damping_fp: scale() * U256::from(85u64) / U256::from(100u64),
        tolerance_fp: U256::from(1_000_000u64),
        max_iterations: 10,
        trust_share_fp: scale(),
        trust_decay_fp: scale(),
        scale: scale(),
        seeds: BTreeSet::from([1, 3, 5]),
    };
    let result = calculate_generic_detailed(&nodes, &BTreeMap::new(), &cfg);
    assert_eq!(result.unique_nodes, 4);
    assert_eq!(result.scores.keys().copied().collect::<Vec<_>>(), vec![1, 3, 5, 9]);
    assert_eq!(result.scores[&9], U256::ZERO);
    assert_eq!(result.scores.values().copied().sum::<U256>(), scale());
}

#[test]
fn retired_founder_multiplier_is_inert_when_folded_into_the_row_denominator() {
    let s = scale();
    let weight = U256::from(37u64);
    let row_total = U256::from(113u64);
    let baseline = fp_div(weight, row_total, s);

    for factor in [1u64, 2, 4, 10] {
        let multiplier = s * U256::from(factor);
        let boosted_weight = fp_mul(weight, multiplier, s);
        let boosted_total = fp_mul(row_total, multiplier, s);
        assert_eq!(fp_div(boosted_weight, boosted_total, s), baseline);
    }
}
