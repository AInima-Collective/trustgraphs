//! Attestation reconciliation → graph, in the canonical total order `(timestamp, fold_index)`.
//!
//! Reconciliation is an ordered state machine per `(attester, recipient)` pair:
//!  * an attest leaf replaces that pair's current edge;
//!  * a revoke leaf clears the pair only when it names the current edge's UID;
//!  * clearing a pair never falls back to an older attestation; and
//!  * a later attest leaf may explicitly reactivate the pair.
//!
//! The one global stable sort by `(timestamp, fold_index)` is consensus: `block.timestamp` is part
//! of every folded leaf and the input vector's index is the accumulator fold position.

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
    // Every event participates in the canonical order. Filtering revoked UIDs before resolving
    // duplicate pairs made `old(100) -> new(20) -> revoke(new)` resurrect `old(100)`.
    let mut indexed: Vec<(u64, &RawEdge)> =
        edges.iter().enumerate().map(|(i, e)| (i as u64, e)).collect();
    indexed.sort_by(|a, b| a.1.block_timestamp.cmp(&b.1.block_timestamp).then(a.0.cmp(&b.0)));

    // Keep the current UID alongside its weight so revoking an older, superseded attestation does
    // not clear a newer one for the same pair.
    let mut current: BTreeMap<Address, BTreeMap<Address, (B256, U256)>> = BTreeMap::new();
    for (_, e) in indexed {
        match e.kind {
            0 => {
                current
                    .entry(e.attester)
                    .or_default()
                    .insert(e.recipient, (e.uid, weight_fp(e, p)));
            }
            1 => {
                let Some(recipients) = current.get_mut(&e.attester) else {
                    continue;
                };
                if recipients.get(&e.recipient).is_some_and(|(uid, _)| *uid == e.uid) {
                    recipients.remove(&e.recipient);
                }
                if recipients.is_empty() {
                    current.remove(&e.attester);
                }
            }
            _ => {} // Other program-specific kinds are not trust edges.
        }
    }

    let mut outgoing: BTreeMap<Address, BTreeMap<Address, U256>> = BTreeMap::new();
    let mut node_set: BTreeSet<Address> = BTreeSet::new();
    for (attester, recipients) in current {
        let weights = recipients
            .into_iter()
            .map(|(recipient, (_, weight))| {
                node_set.insert(recipient);
                (recipient, weight)
            })
            .collect();
        node_set.insert(attester);
        outgoing.insert(attester, weights);
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
    fn revoking_latest_does_not_resurrect_older_pair_edge() {
        let p = default_params();
        let edges =
            vec![edge(0, 1, 2, 1, 100, 100), edge(0, 1, 2, 2, 200, 20), edge(1, 1, 2, 2, 300, 20)];
        let g = build_graph(&edges, &p);
        assert!(g.is_empty(), "revoking the current vouch must leave the pair absent");
    }

    #[test]
    fn revoking_superseded_uid_does_not_clear_current_pair_edge() {
        let p = default_params();
        let edges =
            vec![edge(0, 1, 2, 1, 100, 100), edge(0, 1, 2, 2, 200, 20), edge(1, 1, 2, 1, 300, 100)];
        let g = build_graph(&edges, &p);
        let w = g.outgoing[&Address::from([1; 20])][&Address::from([2; 20])];
        assert_eq!(w, U256::from(20) * p.precision_scale);
    }

    #[test]
    fn later_attestation_reactivates_cleared_pair() {
        let p = default_params();
        let edges =
            vec![edge(0, 1, 2, 1, 100, 100), edge(1, 1, 2, 1, 200, 100), edge(0, 1, 2, 2, 300, 30)];
        let g = build_graph(&edges, &p);
        let w = g.outgoing[&Address::from([1; 20])][&Address::from([2; 20])];
        assert_eq!(w, U256::from(30) * p.precision_scale);
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
