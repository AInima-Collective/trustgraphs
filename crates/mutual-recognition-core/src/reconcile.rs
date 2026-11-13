//! Fold-order EAS reconciliation for the mutual program's lane-one graph, plus the mutual gate.
//!
//! `build_flat_graph` is the same fold the weighted program runs: directed pair state machines
//! keyed by attestation uid, weight read from the `weightFieldIndex` ABI word and clamped to
//! `[minWeight, maxWeight]`. `mutualize` then applies the program's distinguishing rule: an edge
//! a→b carries transition weight exactly when the b→a pair is also live, and both directions use
//! `min(w(a→b), w(b→a))` — the weaker direction bounds the stronger one, so asymmetric vouching
//! cannot inflate either side. Unreciprocated edges are removed from the transition graph (their
//! sources become dangling); node universe = surviving edge endpoints.

use std::collections::{BTreeMap, BTreeSet};

use alloy_primitives::{Address, B256, U256};

use crate::{Params, RawEdge};

#[derive(Clone, Debug, Default)]
pub struct Graph {
    pub nodes: Vec<Address>,
    /// Relative positive/zero integer edge weights. Self loops remain visible in the graph but are
    /// excluded from transition rows and therefore make a self-only source dangling.
    pub outgoing: BTreeMap<Address, BTreeMap<Address, u64>>,
}

#[derive(Clone, Debug, Default)]
pub struct FlatGraph {
    pub nodes: Vec<Address>,
    /// Final pair states, sorted by `(source, target)`.
    pub edges: Vec<(Address, Address, u64)>,
}

fn decode_weight(data: &[u8], index: u32) -> Option<U256> {
    let start = (index as usize).checked_mul(32)?;
    let end = start.checked_add(32)?;
    if data.len() < end {
        return None;
    }
    let mut word = [0u8; 32];
    word.copy_from_slice(&data[start..end]);
    Some(U256::from_be_bytes(word))
}

fn edge_weight(edge: &RawEdge, params: &Params) -> u64 {
    let decoded = decode_weight(&edge.data, params.weight_field_index).unwrap_or(U256::ZERO);
    if decoded > U256::from(params.max_weight) {
        params.max_weight
    } else {
        decoded.to::<u64>().clamp(params.min_weight, params.max_weight)
    }
}

pub fn build_graph(edges: &[RawEdge], params: &Params) -> Graph {
    let mut indexed = edges.iter().enumerate().collect::<Vec<_>>();
    indexed.sort_by(|left, right| {
        left.1.block_timestamp.cmp(&right.1.block_timestamp).then_with(|| left.0.cmp(&right.0))
    });

    let mut current: BTreeMap<Address, BTreeMap<Address, (B256, u64)>> = BTreeMap::new();
    for (_, edge) in indexed {
        match edge.kind {
            0 => {
                current
                    .entry(edge.attester)
                    .or_default()
                    .insert(edge.recipient, (edge.uid, edge_weight(edge, params)));
            }
            1 => {
                let Some(recipients) = current.get_mut(&edge.attester) else {
                    continue;
                };
                if recipients.get(&edge.recipient).is_some_and(|(uid, _)| *uid == edge.uid) {
                    recipients.remove(&edge.recipient);
                }
                if recipients.is_empty() {
                    current.remove(&edge.attester);
                }
            }
            _ => {}
        }
    }

    let mut nodes = BTreeSet::new();
    let mut outgoing = BTreeMap::new();
    for (source, recipients) in current {
        nodes.insert(source);
        let weights = recipients
            .into_iter()
            .map(|(recipient, (_, weight))| {
                nodes.insert(recipient);
                (recipient, weight)
            })
            .collect();
        outgoing.insert(source, weights);
    }
    Graph { nodes: nodes.into_iter().collect(), outgoing }
}

/// Allocation-lean reconciliation for the production guest. Pair state machines are independent,
/// so sorting by `(attester, recipient, timestamp, fold_index)` is byte-equivalent to globally
/// sorting time first and then storing pair state in nested trees.
pub fn build_flat_graph(edges: &[RawEdge], params: &Params) -> FlatGraph {
    let canonical_unique_attests = edges.iter().all(|edge| edge.kind == 0)
        && edges.windows(2).all(|pair| {
            (pair[0].attester, pair[0].recipient) < (pair[1].attester, pair[1].recipient)
        });
    if canonical_unique_attests {
        let mut nodes = Vec::with_capacity(edges.len().saturating_mul(2));
        let flat_edges = edges
            .iter()
            .map(|edge| {
                nodes.push(edge.attester);
                nodes.push(edge.recipient);
                (edge.attester, edge.recipient, edge_weight(edge, params))
            })
            .collect();
        nodes.sort();
        nodes.dedup();
        return FlatGraph { nodes, edges: flat_edges };
    }

    let mut ordered = edges.iter().enumerate().collect::<Vec<_>>();
    ordered.sort_by(|left, right| {
        left.1
            .attester
            .cmp(&right.1.attester)
            .then_with(|| left.1.recipient.cmp(&right.1.recipient))
            .then_with(|| left.1.block_timestamp.cmp(&right.1.block_timestamp))
            .then_with(|| left.0.cmp(&right.0))
    });

    let mut flat_edges = Vec::new();
    let mut nodes = Vec::new();
    let mut cursor = 0usize;
    while cursor < ordered.len() {
        let source = ordered[cursor].1.attester;
        let target = ordered[cursor].1.recipient;
        let mut current = None;
        while cursor < ordered.len()
            && ordered[cursor].1.attester == source
            && ordered[cursor].1.recipient == target
        {
            let edge = ordered[cursor].1;
            match edge.kind {
                0 => current = Some((edge.uid, edge_weight(edge, params))),
                1 if current.is_some_and(|(uid, _)| uid == edge.uid) => current = None,
                _ => {}
            }
            cursor += 1;
        }
        if let Some((_, weight)) = current {
            nodes.push(source);
            nodes.push(target);
            flat_edges.push((source, target, weight));
        }
    }
    nodes.sort();
    nodes.dedup();
    FlatGraph { nodes, edges: flat_edges }
}

/// The mutual gate — this program's distinguishing derivation over the reconciled directed
/// graph. For every unordered pair {a, b} with both directed edges live, emit symmetric edges
/// with weight `min(w(a→b), w(b→a))`. Pairs with only one direction live carry no transition
/// weight at all; nodes surviving only on one-way edges drop out of the node universe (prior
/// accounts re-enter through the teleport universe, everything else scores zero and is omitted).
/// Output remains sorted by `(source, target)` — the gate is order-free over the sorted input.
pub fn mutualize(directed: &FlatGraph) -> FlatGraph {
    let weight_of: BTreeMap<(Address, Address), u64> = directed
        .edges
        .iter()
        .map(|(source, target, weight)| ((*source, *target), *weight))
        .collect();
    let mut edges = Vec::with_capacity(directed.edges.len());
    for (source, target, forward) in &directed.edges {
        if source == target {
            continue;
        }
        if let Some(reverse) = weight_of.get(&(*target, *source)) {
            edges.push((*source, *target, (*forward).min(*reverse)));
        }
    }
    // The BTreeMap iteration order of `directed.edges` ((source, target) sorted) is preserved:
    // every retained edge appears once per direction, still sorted.
    let mut nodes: Vec<Address> = Vec::with_capacity(edges.len().saturating_mul(2));
    for (source, target, _) in &edges {
        nodes.push(*source);
        nodes.push(*target);
    }
    nodes.sort();
    nodes.dedup();
    FlatGraph { nodes, edges }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{manifest, Params, PriorEntry, PARAMS_VERSION, SCALE};

    fn params() -> Params {
        let entries = vec![PriorEntry { account: Address::from([9; 20]), weight: SCALE }];
        let bytes = manifest::canonical_manifest(10, &entries).unwrap();
        Params {
            version: PARAMS_VERSION,
            damping_fp: 850_000_000_000_000_000,
            tolerance_fp: 0,
            max_iterations: 10,
            min_weight: 0,
            max_weight: 100,
            prior_root: manifest::prior_root(&entries).unwrap(),
            prior_count: 1,
            manifest_sha256: manifest::manifest_digest(&bytes),
            schema_uid: B256::from([0xAA; 32]),
            weight_field_index: 1,
            accumulator: Address::from([0xAC; 20]),
            chain_id: 10,
        }
    }

    fn edge(kind: u8, from: u8, to: u8, uid: u8, timestamp: u64, weight: u64) -> RawEdge {
        let mut data = vec![0u8; 64];
        data[56..64].copy_from_slice(&weight.to_be_bytes());
        RawEdge {
            kind,
            attester: Address::from([from; 20]),
            recipient: Address::from([to; 20]),
            uid: B256::from([uid; 32]),
            block_timestamp: timestamp,
            data,
        }
    }

    #[test]
    fn replacement_revocation_never_resurrects_an_old_edge() {
        let graph = build_graph(
            &[edge(0, 1, 2, 1, 100, 90), edge(0, 1, 2, 2, 101, 20), edge(1, 1, 2, 2, 102, 20)],
            &params(),
        );
        assert!(graph.outgoing.is_empty());
    }

    #[test]
    fn flat_reconciliation_matches_the_audit_graph() {
        let edges = vec![
            edge(0, 2, 3, 1, 100, 90),
            edge(0, 1, 2, 1, 100, 90),
            edge(0, 1, 2, 2, 101, 20),
            edge(1, 1, 2, 2, 102, 20),
            edge(0, 3, 4, 3, 99, 10),
        ];
        let graph = build_graph(&edges, &params());
        let flat = build_flat_graph(&edges, &params());
        let expected = graph
            .outgoing
            .iter()
            .flat_map(|(source, row)| {
                row.iter().map(move |(target, weight)| (*source, *target, *weight))
            })
            .collect::<Vec<_>>();
        assert_eq!(flat.nodes, graph.nodes);
        assert_eq!(flat.edges, expected);
    }

    #[test]
    fn mutual_gate_keeps_only_reciprocated_pairs_at_min_weight() {
        let flat = build_flat_graph(
            &[
                edge(0, 1, 2, 1, 100, 90), // a→b 90
                edge(0, 2, 1, 2, 100, 40), // b→a 40 → mutual pair at min 40
                edge(0, 1, 3, 3, 101, 80), // a→c 80, one-way → dropped
                edge(0, 3, 4, 4, 102, 10), // c→d 10, one-way → dropped
            ],
            &params(),
        );
        let gated = mutualize(&flat);
        assert_eq!(
            gated.edges,
            vec![
                (Address::from([1; 20]), Address::from([2; 20]), 40),
                (Address::from([2; 20]), Address::from([1; 20]), 40),
            ]
        );
        assert_eq!(gated.nodes, vec![Address::from([1; 20]), Address::from([2; 20])]);
    }

    #[test]
    fn mutual_gate_is_symmetric_and_drops_self_loops() {
        let flat = build_flat_graph(
            &[
                edge(0, 1, 1, 1, 100, 99), // self loop — never mutual
                edge(0, 1, 2, 2, 100, 70),
                edge(0, 2, 1, 3, 100, 55),
            ],
            &params(),
        );
        let gated = mutualize(&flat);
        assert_eq!(gated.edges.len(), 2);
        assert!(gated.edges.iter().all(|(_, t, w)| *w == 55));
        assert!(!gated.edges.iter().any(|(s, t, _)| s == t));
    }

    #[test]
    fn mutual_gate_on_empty_graph_is_empty() {
        let gated = mutualize(&FlatGraph::default());
        assert!(gated.edges.is_empty());
        assert!(gated.nodes.is_empty());
    }
}
