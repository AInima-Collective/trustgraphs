use std::collections::BTreeMap;

use alloy_primitives::{Address, B256};
use weighted_prior_core::{
    manifest::{canonical_manifest, manifest_digest, prior_root},
    rank::{calculate, calculate_reference, initial_scores, next_iteration},
    reconcile::Graph,
    Params, PriorEntry, PARAMS_VERSION, SCALE,
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
            // Every fifth row is dangling, and every seventh row is a self-only row.
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
