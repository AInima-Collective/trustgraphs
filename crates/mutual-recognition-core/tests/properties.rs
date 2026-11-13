use std::collections::BTreeMap;

use alloy_primitives::{Address, B256};
use mutual_recognition_core::{
    manifest::{canonical_manifest, manifest_digest, prior_root},
    rank::{calculate, calculate_flat, calculate_reference, initial_scores, next_iteration},
    reconcile::{build_flat_graph, mutualize, FlatGraph, Graph},
    Params, PriorEntry, RawEdge, PARAMS_VERSION, SCALE,
};

fn account(index: u64) -> Address {
    let mut bytes = [0u8; 20];
    bytes[12..].copy_from_slice(&index.to_be_bytes());
    Address::from(bytes)
}

fn prior(count: usize) -> Vec<PriorEntry> {
    let base = SCALE / count as u64;
    let remainder = SCALE % count as u64;
    (0..count)
        .map(|index| PriorEntry {
            account: account(index as u64 + 1),
            weight: base + u64::from((index as u64) < remainder),
        })
        .collect()
}

fn params(prior: &[PriorEntry]) -> Params {
    let manifest = canonical_manifest(10, prior).unwrap();
    Params {
        version: PARAMS_VERSION,
        damping_fp: 850_000_000_000_000_000,
        tolerance_fp: 0,
        max_iterations: 40,
        min_weight: 0,
        max_weight: u64::MAX,
        prior_root: prior_root(prior).unwrap(),
        prior_count: prior.len() as u32,
        manifest_sha256: manifest_digest(&manifest),
        schema_uid: B256::ZERO,
        weight_field_index: 0,
        accumulator: account(9_999),
        chain_id: 10,
    }
}

fn edge(kind: u8, from: u64, to: u64, uid: u64, timestamp: u64, weight: u64) -> RawEdge {
    let mut data = vec![0u8; 32];
    data[24..32].copy_from_slice(&weight.to_be_bytes());
    RawEdge {
        kind,
        attester: account(from),
        recipient: account(to),
        uid: B256::from([uid as u8; 32]),
        block_timestamp: timestamp,
        data,
    }
}

#[test]
fn sparse_dangling_concentrated_tie_and_max_degree_preserve_mass_every_iteration() {
    for count in [1usize, 2, 3, 17, 128] {
        let prior = prior(count);
        let params = params(&prior);
        let mut graph = Graph {
            nodes: (0..count).map(|index| account(index as u64 + 1)).collect(),
            ..Graph::default()
        };
        for source in 0..count {
            let mut row = BTreeMap::new();
            let degree = count.saturating_sub(1).min(16);
            for offset in 1..=degree {
                let target = (source + offset) % count;
                row.insert(account(target as u64 + 1), (offset as u64 % 3) + 1);
            }
            if source % 5 == 0 {
                row.clear();
            } else if source % 7 == 0 {
                row.clear();
                row.insert(account(source as u64 + 1), u64::MAX);
            }
            if !row.is_empty() {
                graph.outgoing.insert(account(source as u64 + 1), row);
            }
        }

        let mut current = initial_scores(&graph, &prior);
        for _ in 0..params.max_iterations {
            let step = next_iteration(&graph, &prior, &current, params.damping_fp).unwrap();
            assert_eq!(step.source_budgets.values().sum::<u64>(), params.damping_fp);
            assert_eq!(step.prior_budget, SCALE - params.damping_fp + step.dangling_budget);
            assert_eq!(step.scores.values().sum::<u64>(), SCALE);
            current = step.scores;
        }
        assert_eq!(
            calculate(&graph, &prior, &params).unwrap(),
            calculate_reference(&graph, &prior, &params).unwrap(),
            "indexed/reference mismatch at count {count}"
        );
    }
}

#[test]
fn concentrated_prior_and_equal_edge_remainders_are_deterministic() {
    let prior = vec![
        PriorEntry { account: account(1), weight: SCALE - 2 },
        PriorEntry { account: account(2), weight: 1 },
        PriorEntry { account: account(3), weight: 1 },
    ];
    let mut graph =
        Graph { nodes: vec![account(1), account(2), account(3), account(4)], ..Graph::default() };
    graph
        .outgoing
        .insert(account(1), BTreeMap::from([(account(2), 1), (account(3), 1), (account(4), 1)]));
    let step =
        next_iteration(&graph, &prior, &initial_scores(&graph, &prior), 850_000_000_000_000_000)
            .unwrap();
    assert_eq!(step.scores.values().sum::<u64>(), SCALE);
    assert!(step.scores[&account(2)] >= step.scores[&account(3)]);
    assert!(step.scores[&account(3)] >= step.scores[&account(4)]);
}

// ── Mutual-gate semantics ────────────────────────────────────────────

#[test]
fn one_way_vouches_carry_no_rank_to_nonprior_accounts() {
    // Prior seed (1) vouches for (2); (2) vouches for three nonprior accounts
    // that never reciprocate. Under the gate the 2→{3,4,5} rows are inert, so
    // 3/4/5 must score exactly zero even though a trusted account transitively
    // reaches them in the directed graph.
    let prior = prior(1);
    let params = params(&prior);
    let edges = vec![
        edge(0, 1, 2, 1, 100, 5),
        edge(0, 2, 1, 2, 101, 5),
        edge(0, 2, 3, 3, 102, 9),
        edge(0, 2, 4, 4, 102, 9),
        edge(0, 2, 5, 5, 102, 9),
    ];
    let gated = mutualize(&build_flat_graph(&edges, &params));
    let result = calculate_flat(&gated, &prior, &params).unwrap();
    // One-way targets drop out of the node universe entirely.
    for index in [3u64, 4, 5] {
        assert_eq!(result.scores.get(&account(index)).copied().unwrap_or(0), 0);
    }
    assert_eq!(result.scores.values().sum::<u64>(), SCALE);
    assert!(!gated.edges.iter().any(|(s, t, _)| *s == account(2) && *t != account(1)));
}

#[test]
fn mutual_ring_distributes_mass_to_every_member() {
    let prior = prior(1);
    let params = params(&prior);
    // Seed (1) mutually recognizes (2); the rest form a mutual ring 2↔3↔4↔5↔2.
    let edges = vec![
        edge(0, 1, 2, 1, 100, 5),
        edge(0, 2, 1, 2, 100, 5),
        edge(0, 2, 3, 3, 101, 4),
        edge(0, 3, 2, 4, 101, 4),
        edge(0, 3, 4, 5, 102, 4),
        edge(0, 4, 3, 6, 102, 4),
        edge(0, 4, 5, 7, 103, 4),
        edge(0, 5, 4, 8, 103, 4),
        edge(0, 5, 2, 9, 104, 4),
        edge(0, 2, 5, 10, 104, 4),
    ];
    let gated = mutualize(&build_flat_graph(&edges, &params));
    let result = calculate_flat(&gated, &prior, &params).unwrap();
    for index in 2u64..=5 {
        assert!(result.scores[&account(index)] > 0, "account {index} unscored");
    }
    assert_eq!(result.scores.values().sum::<u64>(), SCALE);
}

#[test]
fn asymmetric_pair_uses_the_weaker_direction_and_stays_symmetric() {
    let prior = prior(1);
    let params = params(&prior);
    let edges = vec![
        edge(0, 1, 2, 1, 100, 5),
        edge(0, 2, 1, 2, 100, 5),
        edge(0, 2, 3, 3, 101, 90), // strong forward
        edge(0, 3, 2, 4, 102, 3),  // weak reverse → min(90, 3) = 3 both ways
    ];
    let gated = mutualize(&build_flat_graph(&edges, &params));
    let pair: BTreeMap<_, _> = gated
        .edges
        .iter()
        .filter(|(s, t, _)| {
            (*s == account(2) && *t == account(3)) || (*s == account(3) && *t == account(2))
        })
        .map(|(s, t, w)| ((*s, *t), *w))
        .collect();
    assert_eq!(pair[&(account(2), account(3))], 3);
    assert_eq!(pair[&(account(3), account(2))], 3);
}

#[test]
fn mutual_gate_is_idempotent() {
    let prior = prior(1);
    let params = params(&prior);
    let edges = vec![
        edge(0, 1, 2, 1, 100, 5),
        edge(0, 2, 1, 2, 100, 5),
        edge(0, 2, 3, 3, 101, 9),
        edge(0, 3, 2, 4, 102, 4),
    ];
    let once = mutualize(&build_flat_graph(&edges, &params));
    let twice = mutualize(&once);
    assert_eq!(once.edges, twice.edges);
    assert_eq!(once.nodes, twice.nodes);
}

#[test]
fn revoking_one_direction_removes_the_pair() {
    let prior = prior(1);
    let params = params(&prior);
    let edges = vec![
        edge(0, 1, 2, 1, 100, 5),
        edge(0, 2, 1, 2, 100, 5),
        edge(0, 2, 3, 3, 101, 9),
        edge(0, 3, 2, 4, 102, 4),
        // 3 revokes its recognition of 2 → the whole pair leaves the graph.
        edge(1, 3, 2, 4, 103, 0),
    ];
    let gated = mutualize(&build_flat_graph(&edges, &params));
    assert!(!gated.edges.iter().any(|(s, t, _)| *s == account(3) || *t == account(3)));
    let result = calculate_flat(&gated, &prior, &params).unwrap();
    assert_eq!(result.scores.values().sum::<u64>(), SCALE);
}
