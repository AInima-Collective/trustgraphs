//! Fixed-point Trust-Aware PageRank. A structural port of `graph_computer.rs::calculate_pagerank`
//! (scores scaled by S), with all `f64` replaced by integer `U256` arithmetic (PLAN.md §2).
//!
//! The algorithm core is GENERIC over the node key (`K: Ord + Copy`) so other programs
//! (hypercerts: `B256` node ids for DIDs/artifacts/bound addresses) reuse the exact same
//! semantics. The Address-keyed `calculate(Graph, Params)` wrapper keeps the trust-graph
//! program's public API and byte behavior unchanged — proven by the untouched golden vectors.

use crate::fixed::{fp_div, fp_mul};
use crate::reconcile::Graph;
use crate::Params;
use alloy_primitives::{Address, U256};
use std::collections::{BTreeMap, BTreeSet, VecDeque};

/// The subset of `Params` the rank core consumes, key-generic.
#[derive(Clone, Debug)]
pub struct RankConfig<K> {
    pub damping_fp: U256,
    pub tolerance_fp: U256,
    pub max_iterations: u32,
    pub trust_multiplier_fp: U256,
    pub trust_share_fp: U256,
    pub trust_decay_fp: U256,
    pub scale: U256,
    /// Trust enabled iff nonempty (mirrors `Params::has_trust_enabled`).
    pub seeds: BTreeSet<K>,
}

fn is_seed<K: Ord>(seeds: &BTreeSet<K>, a: &K) -> bool {
    seeds.contains(a)
}

/// Initial scores (scaled by S). No trust ⇒ uniform `S/n`. Trust ⇒ seeds share `trust_share`,
/// regulars share `1 - trust_share`. Counts follow the legacy convention exactly
/// (`trusted_count = |seeds|`, `regular_count = n - trusted_count`).
fn initialize_scores<K: Ord + Copy>(nodes: &[K], cfg: &RankConfig<K>) -> BTreeMap<K, U256> {
    let n = nodes.len();
    let s = cfg.scale;
    let seeds = &cfg.seeds;
    let mut out = BTreeMap::new();
    if n == 0 {
        return out;
    }
    if seeds.is_empty() {
        let init = s / U256::from(n as u64);
        for node in nodes {
            out.insert(*node, init);
        }
        return out;
    }
    let trusted_count = seeds.len();
    let regular_count = n.saturating_sub(trusted_count);
    let trusted_total = cfg.trust_share_fp;
    let regular_total = s - cfg.trust_share_fp;
    let trusted_score = if trusted_count > 0 {
        trusted_total / U256::from(trusted_count as u64)
    } else {
        U256::ZERO
    };
    let regular_score = if regular_count > 0 {
        regular_total / U256::from(regular_count as u64)
    } else {
        U256::ZERO
    };
    for node in nodes {
        let v = if is_seed(seeds, node) { trusted_score } else { regular_score };
        out.insert(*node, v);
    }
    out
}

/// Multi-source BFS shortest distances from the trusted seeds (deterministic: seeds processed in
/// sorted order, neighbours in address order via the BTree). Mirrors `calculate_trust_distances`.
fn bfs_distances<K: Ord + Copy>(
    outgoing: &BTreeMap<K, BTreeMap<K, U256>>,
    seeds: &BTreeSet<K>,
) -> BTreeMap<K, usize> {
    let mut distances: BTreeMap<K, usize> = BTreeMap::new();
    let mut queue: VecDeque<K> = VecDeque::new();
    for seed in seeds {
        distances.insert(*seed, 0);
        queue.push_back(*seed);
    }
    while let Some(current) = queue.pop_front() {
        let d = distances[&current];
        if let Some(edges) = outgoing.get(&current) {
            for neighbor in edges.keys() {
                if !distances.contains_key(neighbor) {
                    distances.insert(*neighbor, d + 1);
                    queue.push_back(*neighbor);
                }
            }
        }
    }
    distances
}

/// `base_fp ^ dist` in fixed point (iterative). `dist == 0 ⇒ S` (1.0), matching `powi(0)`.
fn decay_pow(base_fp: U256, dist: usize, s: U256) -> U256 {
    let mut r = s;
    for _ in 0..dist {
        r = fp_mul(r, base_fp, s);
    }
    r
}

/// Compute normalized PageRank scores over any node key type (scaled by S; sum ≈ S).
/// Empty graph ⇒ empty. This IS the algorithm; wrappers only adapt key types.
pub fn calculate_generic<K: Ord + Copy>(
    nodes: &[K],
    outgoing: &BTreeMap<K, BTreeMap<K, U256>>,
    cfg: &RankConfig<K>,
) -> BTreeMap<K, U256> {
    let n = nodes.len();
    if n == 0 {
        return BTreeMap::new();
    }
    let s = cfg.scale;
    let seeds = &cfg.seeds;

    let initial = initialize_scores(nodes, cfg);
    let mut current = initial.clone();

    let distances = if !seeds.is_empty() { Some(bfs_distances(outgoing, seeds)) } else { None };

    let base_teleport = s - cfg.damping_fp; // (1 - d) * S

    for _iteration in 0..cfg.max_iterations {
        let mut new_scores: BTreeMap<K, U256> = BTreeMap::new();
        let mut max_delta = U256::ZERO;

        for recipient in nodes {
            // teleportation base: (1 - d) * initial[recipient]
            let mut new_score = fp_mul(base_teleport, initial[recipient], s);

            // isolated (unreachable) nodes get only the base score.
            if let Some(dist) = &distances {
                if !dist.contains_key(recipient) {
                    new_scores.insert(*recipient, new_score);
                    continue;
                }
            }

            for attester in nodes {
                if attester == recipient {
                    continue;
                }
                let Some(edges) = outgoing.get(attester) else { continue };

                // Filter out self-loops and zero-weight edges for the outgoing-weight normalization.
                let mut total_base = U256::ZERO;
                let mut to_recipient: Option<U256> = None;
                for (target, w) in edges {
                    if target == attester || w.is_zero() {
                        continue;
                    }
                    total_base = total_base
                        .checked_add(*w)
                        .expect("rank: outgoing-weight sum overflowed 256 bits");
                    if target == recipient {
                        to_recipient = Some(*w);
                    }
                }
                if total_base.is_zero() {
                    continue;
                }
                let Some(base_w) = to_recipient else { continue };

                // effective weight (trust multiplier for trusted attesters)
                let eff = if is_seed(seeds, attester) {
                    fp_mul(base_w, cfg.trust_multiplier_fp, s)
                } else {
                    base_w
                };

                // trust decay by distance-from-seed of the attester
                let decay = match distances.as_ref().map(|d| d.get(attester).copied()) {
                    Some(Some(distance)) => decay_pow(cfg.trust_decay_fp, distance, s),
                    Some(None) => U256::ZERO,
                    None => s, // trust disabled ⇒ 1.0
                };

                // contribution = current[attester] * (eff / total_base) * decay
                let ratio = fp_div(eff, total_base, s);
                let mut contribution = fp_mul(current[attester], ratio, s);
                contribution = fp_mul(contribution, decay, s);
                new_score = new_score
                    .checked_add(fp_mul(cfg.damping_fp, contribution, s))
                    .expect("rank: accumulated score overflowed 256 bits");
            }

            let prev = current[recipient];
            let delta = if new_score > prev { new_score - prev } else { prev - new_score };
            if delta > max_delta {
                max_delta = delta;
            }
            new_scores.insert(*recipient, new_score);
        }

        current = new_scores;

        if max_delta < cfg.tolerance_fp {
            break;
        }
    }

    // Normalize to sum S.
    // Checked, like every other accumulation here: alloy's `+` wraps silently in release, so an
    // unchecked fold would turn an out-of-range instance into a wrong-but-provable answer.
    let total: U256 = current
        .values()
        .copied()
        .fold(U256::ZERO, |a, b| a.checked_add(b).expect("rank: score total overflowed 256 bits"));
    if !total.is_zero() {
        for v in current.values_mut() {
            *v = fp_div(*v, total, s);
        }
    }
    current
}

/// The trust-graph program's entry: Address-keyed, `Params`-driven (public API unchanged).
pub fn calculate(graph: &Graph, p: &Params) -> BTreeMap<Address, U256> {
    let cfg = RankConfig {
        damping_fp: p.damping_fp,
        tolerance_fp: p.tolerance_fp,
        max_iterations: p.max_iterations,
        trust_multiplier_fp: p.trust_multiplier_fp,
        trust_share_fp: p.trust_share_fp,
        trust_decay_fp: p.trust_decay_fp,
        scale: p.precision_scale,
        seeds: p.trusted_seeds.iter().copied().collect(),
    };
    calculate_generic(&graph.nodes, &graph.outgoing, &cfg)
}
