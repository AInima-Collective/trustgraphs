//! JSON stdin/stdout bridge used by the TypeScript differential fuzz test.

use alloy_primitives::U256;
use pagerank_core::pagerank::{calculate_generic_detailed, RankConfig};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use std::io::Read;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WireConfig {
    damping_fp: String,
    tolerance_fp: String,
    max_iterations: u32,
    trust_share_fp: String,
    trust_decay_fp: String,
    scale: String,
    seeds: Vec<u32>,
}

#[derive(Deserialize)]
struct WireEdge {
    source: u32,
    target: u32,
    weight: String,
}

#[derive(Deserialize)]
struct WireCase {
    nodes: Vec<u32>,
    edges: Vec<WireEdge>,
    config: WireConfig,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct WireResult {
    scores: Vec<(u32, String)>,
    iterations: u32,
    converged: bool,
}

fn uint(value: &str) -> U256 {
    value.parse().expect("decimal U256")
}

fn main() {
    let mut input = String::new();
    std::io::stdin().read_to_string(&mut input).expect("read stdin");
    let cases: Vec<WireCase> = serde_json::from_str(&input).expect("parse cases");
    let results: Vec<_> = cases
        .into_iter()
        .map(|case| {
            let mut outgoing = BTreeMap::<u32, BTreeMap<u32, U256>>::new();
            for edge in case.edges {
                outgoing.entry(edge.source).or_default().insert(edge.target, uint(&edge.weight));
            }
            let config = RankConfig {
                damping_fp: uint(&case.config.damping_fp),
                tolerance_fp: uint(&case.config.tolerance_fp),
                max_iterations: case.config.max_iterations,
                trust_share_fp: uint(&case.config.trust_share_fp),
                trust_decay_fp: uint(&case.config.trust_decay_fp),
                scale: uint(&case.config.scale),
                seeds: BTreeSet::from_iter(case.config.seeds),
            };
            let result = calculate_generic_detailed(&case.nodes, &outgoing, &config);
            WireResult {
                scores: result
                    .scores
                    .into_iter()
                    .map(|(node, score)| (node, score.to_string()))
                    .collect(),
                iterations: result.iterations,
                converged: result.converged,
            }
        })
        .collect();
    println!("{}", serde_json::to_string(&results).expect("serialize results"));
}
