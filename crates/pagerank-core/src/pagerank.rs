//! Fixed-point Trust-Aware PageRank. A structural port of `graph_computer.rs::calculate_pagerank`
//! (scores scaled by S), with all `f64` replaced by integer `U256` arithmetic
//! (`research/ZK_ARCHITECTURE.md` §4.1).
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
    pub trust_share_fp: U256,
    pub trust_decay_fp: U256,
    pub scale: U256,
    /// Trust enabled iff nonempty (mirrors `Params::has_trust_enabled`).
    pub seeds: BTreeSet<K>,
}

fn is_seed<K: Ord>(seeds: &BTreeSet<K>, a: &K) -> bool {
    seeds.contains(a)
}

/// Initial scores (scaled by S). No trust ⇒ uniform `S/n`. With trust, seeds share
/// `trust_share` and only reachable non-seeds share the remainder. Unreachable nodes start and
/// remain at zero, so a disconnected component cannot acquire standing through teleportation.
fn initialize_scores<K: Ord + Copy>(
    nodes: &[K],
    cfg: &RankConfig<K>,
    reachable: Option<&BTreeMap<K, U256>>,
) -> BTreeMap<K, U256> {
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
    let regular_count = reachable
        .map(|nodes| nodes.keys().filter(|node| !is_seed(seeds, node)).count())
        .unwrap_or(0);
    let trusted_total = cfg.trust_share_fp;
    let regular_total =
        s.checked_sub(cfg.trust_share_fp).expect("rank: trust share exceeds precision scale");
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
        let v = if is_seed(seeds, node) {
            trusted_score
        } else if reachable.is_some_and(|reachable| reachable.contains_key(node)) {
            regular_score
        } else {
            U256::ZERO
        };
        out.insert(*node, v);
    }
    out
}

/// Multi-source BFS carrying each node's fixed-point decay from the trusted seeds. Seeds and
/// neighbours are processed in BTree order, so the first visit is the shortest path and
/// `decay[child] = fp_mul(decay[parent], base)` is exactly the old iterative `decay_pow(base,
/// distance)` without a second walk per node.
fn bfs_decays<K: Ord + Copy>(
    outgoing: &BTreeMap<K, BTreeMap<K, U256>>,
    seeds: &BTreeSet<K>,
    base_fp: U256,
    scale: U256,
) -> BTreeMap<K, U256> {
    let mut decays: BTreeMap<K, U256> = BTreeMap::new();
    let mut queue: VecDeque<K> = VecDeque::new();
    for seed in seeds {
        decays.insert(*seed, scale);
        queue.push_back(*seed);
    }
    while let Some(current) = queue.pop_front() {
        if let Some(edges) = outgoing.get(&current) {
            let mut child_decay = None;
            for neighbor in edges.keys() {
                if !decays.contains_key(neighbor) {
                    let value = *child_decay
                        .get_or_insert_with(|| fp_mul(decays[&current], base_fp, scale));
                    decays.insert(*neighbor, value);
                    queue.push_back(*neighbor);
                }
            }
        }
    }
    decays
}

fn assert_edge_closure<K: Ord + Copy>(nodes: &[K], outgoing: &BTreeMap<K, BTreeMap<K, U256>>) {
    let node_set: BTreeSet<K> = nodes.iter().copied().collect();
    for (source, row) in outgoing {
        assert!(node_set.contains(source), "rank: edge source missing from node set");
        for target in row.keys() {
            assert!(node_set.contains(target), "rank: edge target missing from node set");
        }
    }
}

/// Scores plus convergence telemetry used by the operator's prepared-input work profile.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RankResult<K> {
    pub scores: BTreeMap<K, U256>,
    pub iterations: u32,
    pub converged: bool,
    pub unique_nodes: u64,
    pub live_edges: u64,
    pub max_out_degree: u64,
}

impl<K> RankResult<K> {
    pub fn telemetry(&self, max_iterations: u32) -> crate::RankTelemetry {
        crate::RankTelemetry {
            unique_nodes: self.unique_nodes,
            live_edges: self.live_edges,
            max_out_degree: self.max_out_degree,
            max_iterations,
            iterations_run: self.iterations,
            converged: self.converged,
        }
    }
}

/// Compute normalized PageRank scores and convergence telemetry over any node key type.
pub fn calculate_generic_detailed<K: Ord + Copy>(
    nodes: &[K],
    outgoing: &BTreeMap<K, BTreeMap<K, U256>>,
    cfg: &RankConfig<K>,
) -> RankResult<K> {
    // A configured seed is part of the consensus universe even when it has no live edges. The
    // BTreeSet union makes every seed appear exactly once in canonical order.
    let rank_nodes: Vec<K> = nodes
        .iter()
        .copied()
        .chain(cfg.seeds.iter().copied())
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect();
    assert_edge_closure(&rank_nodes, outgoing);

    let nodes = rank_nodes.as_slice();
    let n = nodes.len();
    let unique_nodes = u64::try_from(n).unwrap_or(u64::MAX);
    let live_edges = outgoing.values().fold(0u64, |total, row| {
        total.saturating_add(u64::try_from(row.len()).unwrap_or(u64::MAX))
    });
    let max_out_degree = outgoing
        .values()
        .map(|row| u64::try_from(row.len()).unwrap_or(u64::MAX))
        .max()
        .unwrap_or(0);
    if n == 0 {
        return RankResult {
            scores: BTreeMap::new(),
            iterations: 0,
            converged: true,
            unique_nodes,
            live_edges,
            max_out_degree,
        };
    }
    let s = cfg.scale;
    let seeds = &cfg.seeds;

    let decays = if seeds.is_empty() {
        None
    } else {
        Some(bfs_decays(outgoing, seeds, cfg.trust_decay_fp, s))
    };
    let initial = initialize_scores(nodes, cfg, decays.as_ref());
    let mut current = initial.clone();

    // Match the pull kernel's zero-iteration boundary: no iterative arithmetic is evaluated.
    if cfg.max_iterations == 0 {
        normalize(&mut current, s, decays.as_ref());
        return RankResult {
            scores: current,
            iterations: 0,
            converged: false,
            unique_nodes,
            live_edges,
            max_out_degree,
        };
    }

    // Hoist the complete row normalization out of the iteration. Targets outside the trusted
    // reachable set are deliberately omitted: the pull kernel gives them teleport only and skips
    // them before evaluating an edge ratio.
    let mut ratios: BTreeMap<K, Vec<(K, U256)>> = BTreeMap::new();
    for attester in nodes {
        let Some(edges) = outgoing.get(attester) else { continue };
        let mut total_base = U256::ZERO;
        for (target, weight) in edges {
            if target == attester || weight.is_zero() {
                continue;
            }
            total_base = total_base
                .checked_add(*weight)
                .expect("rank: outgoing-weight sum overflowed 256 bits");
        }
        if total_base.is_zero() {
            continue;
        }

        let mut row = Vec::new();
        for (target, base_weight) in edges {
            if target == attester || base_weight.is_zero() {
                continue;
            }
            if decays.as_ref().is_some_and(|reachable| !reachable.contains_key(target)) {
                continue;
            }
            row.push((*target, fp_div(*base_weight, total_base, s)));
        }
        if !row.is_empty() {
            ratios.insert(*attester, row);
        }
    }

    let base_teleport = s - cfg.damping_fp; // (1 - d) * S
    let teleport: BTreeMap<K, U256> =
        nodes.iter().map(|node| (*node, fp_mul(base_teleport, initial[node], s))).collect();

    let mut iterations = 0;
    let mut converged = false;
    for iteration in 0..cfg.max_iterations {
        let mut new_scores = teleport.clone();

        // Sources stay in node order, preserving the pull kernel's per-recipient addition order.
        for attester in nodes {
            let Some(row) = ratios.get(attester) else { continue };
            let decay = decays
                .as_ref()
                .map_or(s, |values| values.get(attester).copied().unwrap_or(U256::ZERO));
            for (recipient, ratio) in row {
                let mut contribution = fp_mul(current[attester], *ratio, s);
                contribution = fp_mul(contribution, decay, s);
                let damped = fp_mul(cfg.damping_fp, contribution, s);
                let score = new_scores
                    .get_mut(recipient)
                    .expect("rank: edge target missing from node set after closure check");
                *score =
                    score.checked_add(damped).expect("rank: accumulated score overflowed 256 bits");
            }
        }

        // With row ratios summing to at most one, decay at most one, damping below one, and
        // teleport drawn from an initial total at most S, standing cannot grow above S. Keep the
        // invariant executable in the guest so accepted parameter bounds and arithmetic never
        // drift apart.
        let iteration_total = new_scores.values().copied().fold(U256::ZERO, |sum, score| {
            sum.checked_add(score).expect("rank: iteration score total overflowed 256 bits")
        });
        assert!(iteration_total <= s, "rank: total standing exceeded precision scale");

        let mut max_delta = U256::ZERO;
        for recipient in nodes {
            // Consensus-critical: unreachable nodes remain zero and do not affect convergence.
            if decays.as_ref().is_some_and(|reachable| !reachable.contains_key(recipient)) {
                continue;
            }
            let new_score = new_scores[recipient];
            let prev = current[recipient];
            let delta = if new_score > prev { new_score - prev } else { prev - new_score };
            if delta > max_delta {
                max_delta = delta;
            }
        }

        current = new_scores;
        iterations = iteration + 1;

        if max_delta < cfg.tolerance_fp {
            converged = true;
            break;
        }
    }

    normalize(&mut current, s, decays.as_ref());
    RankResult { scores: current, iterations, converged, unique_nodes, live_edges, max_out_degree }
}

fn normalize<K: Ord + Copy>(
    scores: &mut BTreeMap<K, U256>,
    scale: U256,
    reachable: Option<&BTreeMap<K, U256>>,
) {
    let total: U256 = scores
        .values()
        .copied()
        .fold(U256::ZERO, |a, b| a.checked_add(b).expect("rank: score total overflowed 256 bits"));
    if !total.is_zero() {
        for score in scores.values_mut() {
            *score = fp_div(*score, total, scale);
        }
    }

    if scores.is_empty() {
        return;
    }
    let normalized_total = scores.values().copied().fold(U256::ZERO, |sum, score| {
        sum.checked_add(score).expect("rank: normalized score total overflowed 256 bits")
    });
    let remainder = scale
        .checked_sub(normalized_total)
        .expect("rank: normalized score total exceeded precision scale");
    if remainder.is_zero() {
        return;
    }

    // Assign flooring dust canonically without ever endowing an unreachable component. Usually
    // the first normalized-positive node is enough; the reachable fallback also covers a
    // degenerate all-zero accepted input.
    let recipient = scores
        .iter()
        .find_map(|(node, score)| (!score.is_zero()).then_some(*node))
        .or_else(|| {
            reachable.and_then(|nodes| nodes.keys().find(|node| scores.contains_key(node)).copied())
        })
        .or_else(|| scores.keys().next().copied())
        .expect("rank: nonempty score map lost its first node");
    let score = scores.get_mut(&recipient).expect("rank: normalization recipient disappeared");
    *score = score.checked_add(remainder).expect("rank: normalization remainder overflowed");
}

/// Compute normalized PageRank scores over any node key type (scaled by S; sum ≈ S).
/// Empty graph ⇒ empty. Wrappers only adapt key types.
pub fn calculate_generic<K: Ord + Copy>(
    nodes: &[K],
    outgoing: &BTreeMap<K, BTreeMap<K, U256>>,
    cfg: &RankConfig<K>,
) -> BTreeMap<K, U256> {
    calculate_generic_detailed(nodes, outgoing, cfg).scores
}

/// The trust-graph program's entry: Address-keyed, `Params`-driven (public API unchanged).
pub fn calculate(graph: &Graph, p: &Params) -> BTreeMap<Address, U256> {
    let cfg = RankConfig {
        damping_fp: p.damping_fp,
        tolerance_fp: p.tolerance_fp,
        max_iterations: p.max_iterations,
        trust_share_fp: p.trust_share_fp,
        trust_decay_fp: p.trust_decay_fp,
        scale: p.precision_scale,
        seeds: p.trusted_seeds.iter().copied().collect(),
    };
    calculate_generic(&graph.nodes, &graph.outgoing, &cfg)
}
