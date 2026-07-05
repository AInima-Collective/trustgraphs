//! Fixed-point Trust-Aware PageRank. A structural port of `graph_computer.rs::calculate_pagerank`
//! (scores scaled by S), with all `f64` replaced by integer `U256` arithmetic (PLAN.md §2).

use crate::fixed::{fp_div, fp_mul};
use crate::reconcile::Graph;
use crate::Params;
use alloy_primitives::{Address, U256};
use std::collections::{BTreeMap, BTreeSet, VecDeque};

fn is_seed(seeds: &BTreeSet<Address>, a: &Address) -> bool {
    seeds.contains(a)
}

/// Initial scores (scaled by S). No trust ⇒ uniform `S/n`. Trust ⇒ seeds share `trust_share`,
/// regulars share `1 - trust_share`. Counts follow the legacy convention exactly
/// (`trusted_count = |seeds|`, `regular_count = n - trusted_count`).
fn initialize_scores(graph: &Graph, p: &Params, seeds: &BTreeSet<Address>) -> BTreeMap<Address, U256> {
    let n = graph.nodes.len();
    let s = p.precision_scale;
    let mut out = BTreeMap::new();
    if n == 0 {
        return out;
    }
    if !p.has_trust_enabled() {
        let init = s / U256::from(n as u64);
        for node in &graph.nodes {
            out.insert(*node, init);
        }
        return out;
    }
    let trusted_count = p.trusted_seeds.len();
    let regular_count = n.saturating_sub(trusted_count);
    let trusted_total = p.trust_share_fp;
    let regular_total = s - p.trust_share_fp;
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
    for node in &graph.nodes {
        let v = if is_seed(seeds, node) { trusted_score } else { regular_score };
        out.insert(*node, v);
    }
    out
}

/// Multi-source BFS shortest distances from the trusted seeds (deterministic: seeds processed in
/// sorted order, neighbours in address order via the BTree). Mirrors `calculate_trust_distances`.
fn bfs_distances(graph: &Graph, seeds: &BTreeSet<Address>) -> BTreeMap<Address, usize> {
    let mut distances: BTreeMap<Address, usize> = BTreeMap::new();
    let mut queue: VecDeque<Address> = VecDeque::new();
    for seed in seeds {
        distances.insert(*seed, 0);
        queue.push_back(*seed);
    }
    while let Some(current) = queue.pop_front() {
        let d = distances[&current];
        if let Some(edges) = graph.outgoing.get(&current) {
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

/// Compute normalized PageRank scores (scaled by S; sum ≈ S). Empty graph ⇒ empty.
pub fn calculate(graph: &Graph, p: &Params) -> BTreeMap<Address, U256> {
    let n = graph.nodes.len();
    if n == 0 {
        return BTreeMap::new();
    }
    let s = p.precision_scale;
    let seeds: BTreeSet<Address> = p.trusted_seeds.iter().copied().collect();

    let initial = initialize_scores(graph, p, &seeds);
    let mut current = initial.clone();

    let distances = if p.has_trust_enabled() { Some(bfs_distances(graph, &seeds)) } else { None };

    let base_teleport = s - p.damping_fp; // (1 - d) * S

    for _iteration in 0..p.max_iterations {
        let mut new_scores: BTreeMap<Address, U256> = BTreeMap::new();
        let mut max_delta = U256::ZERO;

        for recipient in &graph.nodes {
            // teleportation base: (1 - d) * initial[recipient]
            let mut new_score = fp_mul(base_teleport, initial[recipient], s);

            // isolated (unreachable) nodes get only the base score.
            if let Some(dist) = &distances {
                if !dist.contains_key(recipient) {
                    new_scores.insert(*recipient, new_score);
                    continue;
                }
            }

            for attester in &graph.nodes {
                if attester == recipient {
                    continue;
                }
                let Some(edges) = graph.outgoing.get(attester) else { continue };

                // Filter out self-loops and zero-weight edges for the outgoing-weight normalization.
                let mut total_base = U256::ZERO;
                let mut to_recipient: Option<U256> = None;
                for (target, w) in edges {
                    if target == attester || w.is_zero() {
                        continue;
                    }
                    total_base += *w;
                    if target == recipient {
                        to_recipient = Some(*w);
                    }
                }
                if total_base.is_zero() {
                    continue;
                }
                let Some(base_w) = to_recipient else { continue };

                // effective weight (trust multiplier for trusted attesters)
                let eff = if is_seed(&seeds, attester) {
                    fp_mul(base_w, p.trust_multiplier_fp, s)
                } else {
                    base_w
                };

                // trust decay by distance-from-seed of the attester
                let decay = match distances.as_ref().map(|d| d.get(attester).copied()) {
                    Some(Some(distance)) => decay_pow(p.trust_decay_fp, distance, s),
                    Some(None) => U256::ZERO,
                    None => s, // trust disabled ⇒ 1.0
                };

                // contribution = current[attester] * (eff / total_base) * decay
                let ratio = fp_div(eff, total_base, s);
                let mut contribution = fp_mul(current[attester], ratio, s);
                contribution = fp_mul(contribution, decay, s);
                new_score += fp_mul(p.damping_fp, contribution, s);
            }

            let prev = current[recipient];
            let delta = if new_score > prev { new_score - prev } else { prev - new_score };
            if delta > max_delta {
                max_delta = delta;
            }
            new_scores.insert(*recipient, new_score);
        }

        current = new_scores;

        if max_delta < p.tolerance_fp {
            break;
        }
    }

    // Normalize to sum S.
    let total: U256 = current.values().copied().fold(U256::ZERO, |a, b| a + b);
    if !total.is_zero() {
        for v in current.values_mut() {
            *v = fp_div(*v, total, s);
        }
    }
    current
}
