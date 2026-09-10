use alloy_primitives::{Address, U256};
use pagerank_core::pagerank::{calculate_generic_detailed, RankConfig};
use std::collections::{BTreeMap, BTreeSet};
fn a(v: u8) -> Address {
    Address::from([v; 20])
}
fn cfg() -> RankConfig<Address> {
    let s = U256::from(1_000_000_000_000_000_000u64);
    RankConfig {
        damping_fp: s * U256::from(85) / U256::from(100),
        tolerance_fp: U256::from(1_000_000),
        max_iterations: 100,
        trust_share_fp: s / U256::from(2),
        trust_decay_fp: s * U256::from(8) / U256::from(10),
        scale: s,
        seeds: BTreeSet::from([a(1)]),
    }
}
#[test]
fn zero_weight_edge_cannot_grant_teleport() {
    let c = cfg();
    let mut graph = BTreeMap::from([
        (a(2), BTreeMap::from([(a(3), U256::from(1))])),
        (a(3), BTreeMap::from([(a(2), U256::from(1))])),
    ]);
    let before = calculate_generic_detailed(&[a(1), a(2), a(3)], &graph, &c);
    assert_eq!(before.scores[&a(2)], U256::ZERO);
    graph.insert(a(1), BTreeMap::from([(a(2), U256::ZERO)]));
    let after = calculate_generic_detailed(&[a(1), a(2), a(3)], &graph, &c);
    assert_eq!(after.scores, before.scores);
}
#[test]
fn zero_weight_shortcut_cannot_change_default_trust_decay() {
    let mut c = cfg();
    c.trust_share_fp = c.scale;
    let mut graph = BTreeMap::from([
        (a(1), BTreeMap::from([(a(2), U256::from(1))])),
        (a(2), BTreeMap::from([(a(3), U256::from(1))])),
        (a(3), BTreeMap::from([(a(4), U256::from(1))])),
        (a(4), BTreeMap::from([(a(5), U256::from(1))])),
    ]);
    let nodes = [a(1), a(2), a(3), a(4), a(5)];
    let before = calculate_generic_detailed(&nodes, &graph, &c);
    graph.get_mut(&a(1)).unwrap().insert(a(4), U256::ZERO);
    let after = calculate_generic_detailed(&nodes, &graph, &c);
    assert_eq!(after.scores, before.scores);
}
#[test]
fn dust_score_cannot_capture_a_high_score_quota() {
    let c = cfg();
    let dust = U256::from(1);
    let scores =
        vec![(a(1), c.scale / U256::from(2)), (a(2), c.scale / U256::from(2) - dust), (a(3), dust)];
    let (result, total) =
        pagerank_core::distribute::distribute_points_generic(&scores, c.scale, U256::from(2));
    assert_eq!(total, U256::from(2));
    assert_eq!(result, vec![(a(1), U256::from(1)), (a(2), U256::from(1))]);
}

fn native_params(pool: U256) -> pagerank_core::Params {
    let c = cfg();
    pagerank_core::Params {
        damping_fp: c.damping_fp,
        tolerance_fp: c.tolerance_fp,
        max_iterations: c.max_iterations,
        min_weight_fp: U256::ZERO,
        max_weight_fp: c.scale * U256::from(100),
        trust_share_fp: c.scale,
        trust_decay_fp: c.trust_decay_fp,
        trusted_seeds: vec![a(1)],
        total_pool: pool,
        precision_scale: c.scale,
        schema_uid: alloy_primitives::B256::repeat_byte(0x11),
        weight_field_index: 1,
        envelope0_domain_separators: vec![],
        lane2_max_head_age: 0,
        accumulator: a(9),
        chain_id: 31337,
    }
}
fn raw(from: u8, to: u8, uid: u8, weight: u64) -> pagerank_core::RawEdge {
    // canonical abi.encode(string, uint256), with the empty string at offset 64.
    let mut data = vec![0u8; 96];
    data[31] = 64;
    data[32..64].copy_from_slice(&U256::from(weight).to_be_bytes::<32>());
    pagerank_core::RawEdge {
        kind: 0,
        attester: a(from),
        recipient: a(to),
        uid: alloy_primitives::B256::repeat_byte(uid),
        block_timestamp: 100,
        data,
    }
}
#[test]
fn factory_admissible_single_unit_pool_preserves_ranking() {
    let p = native_params(U256::from(1));
    let result = pagerank_core::compute::compute(&pagerank_core::GuestInput {
        edges: vec![raw(1, 2, 1, 100)],
        params: p,
        binding: Default::default(),
    });
    assert_eq!(result.scores, vec![(a(1), U256::from(1))]);
}
#[test]
fn factory_admissible_zero_vouch_full_pipeline() {
    let mut p = native_params(U256::from(1_000_000_000_000_000_000u64));
    p.trust_share_fp = p.precision_scale / U256::from(2);
    let mut input = pagerank_core::GuestInput {
        edges: vec![raw(2, 3, 1, 100), raw(3, 2, 2, 100)],
        params: p,
        binding: Default::default(),
    };
    let before = pagerank_core::compute::compute(&input);
    assert_eq!(before.scores, vec![(a(1), input.params.total_pool)]);
    input.edges.push(raw(1, 2, 3, 0));
    let after = pagerank_core::compute::compute(&input);
    assert_eq!(after.scores, before.scores);
}

#[test]
fn full_precision_allocation_handles_u256_max_pool_and_zero_scores() {
    let scores = vec![(a(3), U256::ZERO), (a(2), U256::from(1)), (a(1), U256::from(1))];
    let (result, total) =
        pagerank_core::distribute::distribute_points_generic(&scores, U256::from(1), U256::MAX);
    assert_eq!(total, U256::MAX);
    assert_eq!(
        result,
        vec![(a(1), U256::MAX / U256::from(2) + U256::from(1)), (a(2), U256::MAX / U256::from(2))]
    );
}

proptest::proptest! {
    #[test]
    fn hamilton_conserves_pool_respects_quotas_and_input_order(
        weights in proptest::collection::vec(0u64..=u64::MAX, 1..30),
        pool in proptest::prelude::any::<u128>(),
    ) {
        let scores: Vec<_> = weights.iter().enumerate()
            .map(|(i, weight)| (i, U256::from(*weight))).collect();
        let sum = scores.iter().fold(U256::ZERO, |sum, (_, weight)| sum + *weight);
        let pool = U256::from(pool);
        let (assigned, total) = pagerank_core::distribute::distribute_points_generic(
            &scores, U256::from(1), pool,
        );
        let actual: BTreeMap<_, _> = assigned.iter().copied().collect();
        proptest::prop_assert_eq!(
            assigned.iter().fold(U256::ZERO, |sum, (_, value)| sum + *value), total,
        );
        proptest::prop_assert_eq!(total, if sum.is_zero() { U256::ZERO } else { pool });
        for (key, weight) in &scores {
            let value = actual.get(key).copied().unwrap_or(U256::ZERO);
            if weight.is_zero() {
                proptest::prop_assert_eq!(value, U256::ZERO);
            }
            if !sum.is_zero() {
                let quota = pagerank_core::fixed::mul_div(*weight, pool, sum);
                proptest::prop_assert!(value == quota || value == quota + U256::from(1));
            }
        }
        let mut reversed = scores.clone();
        reversed.reverse();
        proptest::prop_assert_eq!(
            pagerank_core::distribute::distribute_points_generic(
                &reversed, U256::from(1), pool,
            ).0,
            assigned,
        );
    }
}
