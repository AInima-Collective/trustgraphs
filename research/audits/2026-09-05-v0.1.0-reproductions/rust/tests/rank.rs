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
fn zero_weight_edge_grants_teleport() {
    let c = cfg();
    let mut graph = BTreeMap::from([
        (a(2), BTreeMap::from([(a(3), U256::from(1))])),
        (a(3), BTreeMap::from([(a(2), U256::from(1))])),
    ]);
    let before = calculate_generic_detailed(&[a(1), a(2), a(3)], &graph, &c);
    assert_eq!(before.scores[&a(2)], U256::ZERO);
    graph.insert(a(1), BTreeMap::from([(a(2), U256::ZERO)]));
    let after = calculate_generic_detailed(&[a(1), a(2), a(3)], &graph, &c);
    assert!(after.scores[&a(2)] > U256::ZERO);
    println!(
        "zero weight vouch gives previously disconnected accounts standing {:?}",
        after.scores
    );
}
#[test]
fn zero_weight_shortcut_boosts_default_trust_share() {
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
    assert!(after.scores[&a(5)] > before.scores[&a(5)]);
    println!(
        "zero weight shortcut increases downstream standing {} -> {}",
        before.scores[&a(5)],
        after.scores[&a(5)]
    );
}
#[test]
fn remainder_awarded_to_zero_quantum_score() {
    let c = cfg();
    let dust = U256::from(1);
    let scores =
        vec![(a(1), c.scale / U256::from(2)), (a(2), c.scale / U256::from(2) - dust), (a(3), dust)];
    let (result, total) =
        pagerank_core::distribute::distribute_points_generic(&scores, c.scale, U256::from(2));
    assert_eq!(total, U256::from(2));
    assert!(result.contains(&(a(3), U256::from(1))));
    println!("two-unit pool awards dust account half the pool: {:?}", result);
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
fn factory_admissible_small_pool_awards_everything_to_lower_ranked_account() {
    let p = native_params(U256::from(1));
    let result = pagerank_core::compute::compute(&pagerank_core::GuestInput {
        edges: vec![raw(1, 2, 1, 100)],
        params: p,
        binding: Default::default(),
    });
    assert_eq!(result.scores, vec![(a(2), U256::from(1))]);
    println!("full pipeline, positive pool 1: seed has more raw rank, lower-ranked recipient gets 100% of score allocation {:?}",result.scores);
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
    assert!(after.scores.iter().any(|(a, v)| *a != self::a(1) && *v > U256::ZERO));
    println!(
        "full pipeline under factory-admissible params: zero vouch scored allocations {:?}",
        after.scores
    );
}
