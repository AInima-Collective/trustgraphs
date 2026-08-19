//! Off-chain diff harness (WP11 acceptance): the canonical fixed-point port vs. the legacy `f64`
//! implementation over pseudo-random graphs. The fixed-point guest REDEFINES the canonical scores,
//! so exact equality is not expected — this reports the distribution of per-account deltas to show
//! the port stays bounded-close to the old behaviour (a large delta would signal a port bug).
//!
//! Run: `cargo run -p pagerank-core --example diff_harness`

use alloy_primitives::{Address, B256, U256};
use pagerank::{PageRankConfig, PageRankGraphComputer, TrustConfig};
use pagerank_core::compute::compute;
use pagerank_core::{GuestInput, Params, RawEdge};
use std::collections::HashMap;

fn scale() -> U256 {
    U256::from(10u64).pow(U256::from(18u64))
}
fn fp(n: u64, d: u64) -> U256 {
    scale() * U256::from(n) / U256::from(d)
}
fn addr(i: u64) -> Address {
    let mut b = [0u8; 20];
    b[12..].copy_from_slice(&i.to_be_bytes());
    Address::from(b)
}

/// Tiny deterministic LCG so runs are reproducible without an rng dependency.
struct Lcg(u64);
impl Lcg {
    fn next(&mut self, bound: u64) -> u64 {
        self.0 = self.0.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
        (self.0 >> 33) % bound
    }
}

struct Graph {
    edges: Vec<(u64, u64, u64)>, // (from, to, weight)
    seeds: Vec<u64>,
}

fn gen_graph(seed: u64, n: u64, m: u64) -> Graph {
    let mut lcg = Lcg(seed.wrapping_add(0x9E3779B97F4A7C15));
    let mut edges = Vec::new();
    for _ in 0..m {
        let from = lcg.next(n) + 1;
        let to = lcg.next(n) + 1;
        let weight = lcg.next(100) + 1; // 1..=100
        edges.push((from, to, weight));
    }
    Graph { edges, seeds: vec![1, 2] }
}

fn legacy_points(g: &Graph) -> HashMap<Address, U256> {
    let mut graph = PageRankGraphComputer::new().with_allow_duplicates(false);
    for &(f, t, w) in &g.edges {
        graph.add_edge(addr(f), addr(t), w as f64);
    }
    graph.sort();
    let trust = TrustConfig::new(g.seeds.iter().map(|&s| addr(s)).collect())
        .with_trust_multiplier(2.0)
        .with_trust_share(0.15)
        .with_trust_decay(0.8);
    let config = PageRankConfig::default().with_trust_config(trust);
    let scores: HashMap<Address, f64> =
        graph.calculate_pagerank(&config).into_iter().filter(|(_, s)| *s > 0.0).collect();
    let total_pool = U256::from(1_000_000_000_000_000_000_000_000u128);
    graph.distribute_points(&scores, total_pool).0
}

fn fixed_points(g: &Graph) -> HashMap<Address, U256> {
    let s = scale();
    let params = Params {
        damping_fp: fp(85, 100),
        tolerance_fp: s / U256::from(1_000_000u64),
        max_iterations: 100,
        min_weight_fp: U256::ZERO,
        max_weight_fp: U256::from(100u64) * s,
        trust_multiplier_fp: U256::from(2u64) * s,
        trust_share_fp: fp(15, 100),
        trust_decay_fp: fp(80, 100),
        trusted_seeds: g.seeds.iter().map(|&x| addr(x)).collect(),
        total_pool: U256::from(1_000_000_000_000_000_000_000_000u128),
        precision_scale: s,
        schema_uid: B256::ZERO,
        weight_field_index: 1,
        envelope0_domain_separators: vec![],
        lane2_max_head_age: 0,
        // Float-vs-fixed-point comparison only; this harness never hashes params.
        accumulator: Address::ZERO,
        chain_id: 0,
    };
    let mut edges = Vec::new();
    for (i, &(f, t, w)) in g.edges.iter().enumerate() {
        let mut data = vec![0u8; 64];
        data[32..64].copy_from_slice(&U256::from(w).to_be_bytes::<32>());
        edges.push(RawEdge {
            kind: 0,
            attester: addr(f),
            recipient: addr(t),
            uid: B256::from(U256::from(i as u64 + 1)),
            block_timestamp: 1000 + i as u64,
            data,
        });
    }
    compute(&GuestInput { edges, params, lane2: None, binding: Default::default() })
        .scores
        .into_iter()
        .collect()
}

fn main() {
    let pool = 1_000_000_000_000_000_000_000_000u128 as f64;
    let mut worst_rel = 0.0f64;
    let mut worst_case = String::new();
    let mut total_rel = 0.0f64;
    let mut count = 0u64;

    for seed in 0..8u64 {
        let g = gen_graph(seed, 12, 30);
        let legacy = legacy_points(&g);
        let fixed = fixed_points(&g);

        // union of accounts
        let mut accts: Vec<Address> = legacy.keys().chain(fixed.keys()).copied().collect();
        accts.sort();
        accts.dedup();

        let mut case_worst = 0.0f64;
        for a in &accts {
            let l = legacy.get(a).copied().unwrap_or(U256::ZERO);
            let f = fixed.get(a).copied().unwrap_or(U256::ZERO);
            let lf = u256_to_f64(l);
            let ff = u256_to_f64(f);
            let rel = (lf - ff).abs() / pool; // delta as fraction of total pool
            total_rel += rel;
            count += 1;
            if rel > case_worst {
                case_worst = rel;
            }
        }
        if case_worst > worst_rel {
            worst_rel = case_worst;
            worst_case = format!("seed {seed}: {} accts", accts.len());
        }
        println!(
            "seed {seed}: {:>2} accts, legacy={:>2} fixed={:>2}, worst per-acct delta = {:.4}% of pool",
            accts.len(),
            legacy.len(),
            fixed.len(),
            case_worst * 100.0
        );
    }

    println!("\n=== SUMMARY ===");
    println!("mean per-account delta: {:.5}% of pool", (total_rel / count as f64) * 100.0);
    println!("worst per-account delta: {:.4}% of pool  ({worst_case})", worst_rel * 100.0);
    let bound = 0.05; // 5% of pool per account
    if worst_rel > bound {
        println!(
            "WARNING: worst delta exceeds {:.0}% of pool — investigate the port.",
            bound * 100.0
        );
    } else {
        println!(
            "OK: fixed-point port is within {:.0}% of pool of legacy f64 on all cases.",
            bound * 100.0
        );
    }
}

fn u256_to_f64(x: U256) -> f64 {
    // pool fits well within f64 range; good enough for a delta metric.
    let s = x.to_string();
    s.parse::<f64>().unwrap_or(0.0)
}
