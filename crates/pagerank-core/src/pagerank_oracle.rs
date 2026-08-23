//! Test-only fixed-point pull oracle for the production push kernel.
//!
//! Keep this implementation structurally independent of the production push kernel. Its purpose
//! is to police every integer operation, truncation boundary, overflow, and the unusual
//! convergence rule for nodes outside the trusted-seed reachable set.

use crate::fixed::{fp_div, fp_mul};
use crate::pagerank::RankConfig;
use alloy_primitives::U256;
use std::collections::{BTreeMap, BTreeSet, VecDeque};

fn is_seed<K: Ord>(seeds: &BTreeSet<K>, node: &K) -> bool {
    seeds.contains(node)
}

fn initialize_scores<K: Ord + Copy>(
    nodes: &[K],
    cfg: &RankConfig<K>,
    distances: Option<&BTreeMap<K, usize>>,
) -> BTreeMap<K, U256> {
    let n = nodes.len();
    let scale = cfg.scale;
    let mut scores = BTreeMap::new();
    if n == 0 {
        return scores;
    }
    if cfg.seeds.is_empty() {
        let initial = scale / U256::from(n as u64);
        for node in nodes {
            scores.insert(*node, initial);
        }
        return scores;
    }

    let trusted_count = cfg.seeds.len();
    let regular_count = distances
        .map(|nodes| nodes.keys().filter(|node| !is_seed(&cfg.seeds, node)).count())
        .unwrap_or(0);
    let trusted_score = if trusted_count > 0 {
        cfg.trust_share_fp / U256::from(trusted_count as u64)
    } else {
        U256::ZERO
    };
    let regular_score = if regular_count > 0 {
        scale.checked_sub(cfg.trust_share_fp).expect("rank: trust share exceeds precision scale")
            / U256::from(regular_count as u64)
    } else {
        U256::ZERO
    };
    for node in nodes {
        let score = if is_seed(&cfg.seeds, node) {
            trusted_score
        } else if distances.is_some_and(|distances| distances.contains_key(node)) {
            regular_score
        } else {
            U256::ZERO
        };
        scores.insert(*node, score);
    }
    scores
}

fn bfs_distances<K: Ord + Copy>(
    outgoing: &BTreeMap<K, BTreeMap<K, U256>>,
    seeds: &BTreeSet<K>,
) -> BTreeMap<K, usize> {
    let mut distances = BTreeMap::new();
    let mut queue = VecDeque::new();
    for seed in seeds {
        distances.insert(*seed, 0);
        queue.push_back(*seed);
    }
    while let Some(current) = queue.pop_front() {
        let distance = distances[&current];
        if let Some(edges) = outgoing.get(&current) {
            for neighbor in edges.keys() {
                if !distances.contains_key(neighbor) {
                    distances.insert(*neighbor, distance + 1);
                    queue.push_back(*neighbor);
                }
            }
        }
    }
    distances
}

fn decay_pow(base_fp: U256, distance: usize, scale: U256) -> U256 {
    let mut decay = scale;
    for _ in 0..distance {
        decay = fp_mul(decay, base_fp, scale);
    }
    decay
}

/// The exact pull implementation that shipped before M1.
pub(crate) fn calculate<K: Ord + Copy>(
    nodes: &[K],
    outgoing: &BTreeMap<K, BTreeMap<K, U256>>,
    cfg: &RankConfig<K>,
) -> BTreeMap<K, U256> {
    let rank_nodes: Vec<K> = nodes
        .iter()
        .copied()
        .chain(cfg.seeds.iter().copied())
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect();
    let nodes = rank_nodes.as_slice();
    let n = nodes.len();
    if n == 0 {
        return BTreeMap::new();
    }
    let scale = cfg.scale;
    let distances =
        if cfg.seeds.is_empty() { None } else { Some(bfs_distances(outgoing, &cfg.seeds)) };
    let initial = initialize_scores(nodes, cfg, distances.as_ref());
    let mut current = initial.clone();
    let base_teleport = scale - cfg.damping_fp;

    for _iteration in 0..cfg.max_iterations {
        let mut new_scores = BTreeMap::new();
        let mut max_delta = U256::ZERO;

        for recipient in nodes {
            let mut new_score = fp_mul(base_teleport, initial[recipient], scale);

            // Consensus-critical: unreachable nodes do not participate in convergence.
            if let Some(distances) = &distances {
                if !distances.contains_key(recipient) {
                    new_scores.insert(*recipient, new_score);
                    continue;
                }
            }

            for attester in nodes {
                if attester == recipient {
                    continue;
                }
                let Some(edges) = outgoing.get(attester) else { continue };

                let mut total_base = U256::ZERO;
                let mut to_recipient = None;
                for (target, weight) in edges {
                    if target == attester || weight.is_zero() {
                        continue;
                    }
                    total_base = total_base
                        .checked_add(*weight)
                        .expect("rank: outgoing-weight sum overflowed 256 bits");
                    if target == recipient {
                        to_recipient = Some(*weight);
                    }
                }
                if total_base.is_zero() {
                    continue;
                }
                let Some(base_weight) = to_recipient else { continue };

                let decay = match distances.as_ref().map(|d| d.get(attester).copied()) {
                    Some(Some(distance)) => decay_pow(cfg.trust_decay_fp, distance, scale),
                    Some(None) => U256::ZERO,
                    None => scale,
                };
                let ratio = fp_div(base_weight, total_base, scale);
                let mut contribution = fp_mul(current[attester], ratio, scale);
                contribution = fp_mul(contribution, decay, scale);
                new_score = new_score
                    .checked_add(fp_mul(cfg.damping_fp, contribution, scale))
                    .expect("rank: accumulated score overflowed 256 bits");
            }

            let previous = current[recipient];
            let delta =
                if new_score > previous { new_score - previous } else { previous - new_score };
            if delta > max_delta {
                max_delta = delta;
            }
            new_scores.insert(*recipient, new_score);
        }

        let iteration_total = new_scores.values().copied().fold(U256::ZERO, |sum, score| {
            sum.checked_add(score).expect("rank: iteration score total overflowed 256 bits")
        });
        assert!(iteration_total <= scale, "rank: total standing exceeded precision scale");

        current = new_scores;
        if max_delta < cfg.tolerance_fp {
            break;
        }
    }

    let total = current.values().copied().fold(U256::ZERO, |sum, score| {
        sum.checked_add(score).expect("rank: score total overflowed 256 bits")
    });
    if !total.is_zero() {
        for score in current.values_mut() {
            *score = fp_div(*score, total, scale);
        }
    }
    if !current.is_empty() {
        let normalized_total = current.values().copied().fold(U256::ZERO, |sum, score| {
            sum.checked_add(score).expect("rank: normalized score total overflowed 256 bits")
        });
        let remainder = scale
            .checked_sub(normalized_total)
            .expect("rank: normalized score total exceeded precision scale");
        if !remainder.is_zero() {
            let recipient = current
                .iter()
                .find_map(|(node, score)| (!score.is_zero()).then_some(*node))
                .or_else(|| {
                    distances.as_ref().and_then(|nodes| {
                        nodes.keys().find(|node| current.contains_key(node)).copied()
                    })
                })
                .or_else(|| current.keys().next().copied())
                .expect("rank: nonempty score map lost its first node");
            let score =
                current.get_mut(&recipient).expect("rank: normalization recipient disappeared");
            *score =
                score.checked_add(remainder).expect("rank: normalization remainder overflowed");
        }
    }
    current
}
