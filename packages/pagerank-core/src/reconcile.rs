//! Attestation reconciliation → graph, in the canonical total order `(timestamp, fold_index)`.
//!
//! Mirrors `components/trust-graph/src/eas_pagerank.rs` + `graph_computer.rs::add_edge`
//! (`allow_duplicates = false`), with two deliberate canonicalizations (PLAN.md §2):
//!  * ordering is a single GLOBAL stable sort by `(timestamp, fold_index)` (the legacy per-100-batch
//!    sort is a quirk we do not reproduce);
//!  * `revoke` (kind=1) leaves exclude their `uid`'s attestation from the graph (the legacy
//!    "deleted" skip), regardless of position.

use crate::encode::decode_weight;
use crate::{Params, RawEdge};
use alloy_primitives::{Address, B256, U256};
use std::collections::{BTreeMap, BTreeSet};

/// A reconciled directed graph. Iteration order is deterministic (BTree-keyed by address).
#[derive(Clone, Debug, Default)]
pub struct Graph {
    /// Every node (attester or recipient of an included edge), ascending by address.
    pub nodes: Vec<Address>,
    /// `attester -> { recipient -> weight_fp }`. Missing key ⇒ node has no outgoing edges.
    pub outgoing: BTreeMap<Address, BTreeMap<Address, U256>>,
}

impl Graph {
    pub fn is_empty(&self) -> bool {
        self.nodes.is_empty()
    }
}

/// Clamp a decoded confidence to `[min_weight, max_weight]` in fixed point.
/// `confidence` is an integer; `confidence * S` is guarded against overflow by the cap check.
fn weight_fp(edge: &RawEdge, p: &Params) -> U256 {
    let confidence = decode_weight(&edge.data, p.weight_field_index).unwrap_or(U256::ZERO);
    let s = p.precision_scale;
    let cap_raw = p.max_weight_fp / s; // integer part of the max weight
    if confidence > cap_raw {
        p.max_weight_fp
    } else {
        let c = confidence * s; // safe: confidence <= cap_raw ⇒ c <= max_weight_fp
        c.clamp(p.min_weight_fp, p.max_weight_fp)
    }
}

/// Build the reconciled graph from folded edges.
pub fn build_graph(edges: &[RawEdge], p: &Params) -> Graph {
    // uids that were ever revoked are excluded entirely.
    let revoked: BTreeSet<B256> =
        edges.iter().filter(|e| e.kind == 1).map(|e| e.uid).collect();

    // Attest edges in canonical (timestamp, fold_index) order.
    let mut indexed: Vec<(u64, &RawEdge)> = edges
        .iter()
        .enumerate()
        .filter(|(_, e)| e.kind == 0 && !revoked.contains(&e.uid))
        .map(|(i, e)| (i as u64, e))
        .collect();
    indexed.sort_by(|a, b| a.1.block_timestamp.cmp(&b.1.block_timestamp).then(a.0.cmp(&b.0)));

    let mut outgoing: BTreeMap<Address, BTreeMap<Address, U256>> = BTreeMap::new();
    let mut node_set: BTreeSet<Address> = BTreeSet::new();

    for (_, e) in &indexed {
        let w = weight_fp(e, p);
        node_set.insert(e.attester);
        node_set.insert(e.recipient);
        // last-write-wins: a later edge for the same (attester, recipient) overrides the weight.
        outgoing.entry(e.attester).or_default().insert(e.recipient, w);
    }

    Graph { nodes: node_set.into_iter().collect(), outgoing }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tests::default_params;

    fn edge(kind: u8, from: u8, to: u8, uid: u8, ts: u64, weight: u64) -> RawEdge {
        // data = abi.encode(string, uint256) with confidence in head slot 1.
        let mut data = vec![0u8; 64];
        data[32..64].copy_from_slice(&U256::from(weight).to_be_bytes::<32>());
        RawEdge {
            kind,
            attester: Address::from([from; 20]),
            recipient: Address::from([to; 20]),
            uid: B256::from([uid; 32]),
            block_timestamp: ts,
            data,
        }
    }

    #[test]
    fn last_write_wins_by_timestamp_then_fold() {
        let p = default_params();
        // Two edges 1->2, earlier weight 10, later weight 40. Later (higher ts) wins.
        let edges = vec![edge(0, 1, 2, 1, 100, 10), edge(0, 1, 2, 2, 200, 40)];
        let g = build_graph(&edges, &p);
        let w = g.outgoing[&Address::from([1; 20])][&Address::from([2; 20])];
        assert_eq!(w, U256::from(40) * p.precision_scale);
    }

    #[test]
    fn revoked_uid_excluded() {
        let p = default_params();
        let edges = vec![edge(0, 1, 2, 7, 100, 10), edge(1, 1, 2, 7, 150, 0)];
        let g = build_graph(&edges, &p);
        assert!(g.is_empty(), "revoked edge should leave an empty graph");
    }

    #[test]
    fn weight_capped_at_max() {
        let p = default_params();
        let edges = vec![edge(0, 1, 2, 1, 100, 10_000)];
        let g = build_graph(&edges, &p);
        let w = g.outgoing[&Address::from([1; 20])][&Address::from([2; 20])];
        assert_eq!(w, p.max_weight_fp); // capped to 100 * S
    }
}
