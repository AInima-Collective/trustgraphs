//! Reconstruct the exact ordered edge set a checkpoint froze, and prove the reconstruction is
//! correct by re-folding it against the checkpoint's committed `acc`.
//!
//! The chain gives us two things: the ordered fold *leaves* (from the accumulator's `EdgeFolded`
//! events) and a set of *candidate* edges (from EAS attestations/revocations). Each fold leaf is
//! `keccak256(abi.encode(kind, attester, recipient, uid, blockTimestamp, dataHash))`, so we match
//! candidates to leaves by recomputing the leaf, assemble them in fold order, and assert the
//! re-folded accumulator equals the checkpoint's `acc`. If anything is missing or wrong the leaf
//! won't match (or the final `acc` won't), and we refuse to emit — you never waste a proof on a bad
//! input set. This uses the SAME `pagerank_core::encode` the guest and contracts use.

pub mod rpc;

use alloy_primitives::{keccak256, B256};
use anyhow::{bail, Result};
use pagerank_core::{encode, RawEdge};
use std::collections::HashMap;

/// The fold leaf of an edge, exactly as the on-chain accumulator computes it.
pub fn edge_leaf_of(e: &RawEdge) -> B256 {
    encode::edge_leaf(e.kind, e.attester, e.recipient, e.uid, e.block_timestamp, keccak256(&e.data))
}

/// Assemble the checkpoint's edge set from ordered fold leaves + candidate edges, verifying the
/// result re-folds to the checkpoint's `(acc, leafCount)`.
///
/// - `ordered_leaves`: the `EdgeFolded` leaves in fold-index order (length must equal `cp_leaf_count`).
/// - `candidates`: every edge we could reconstruct from chain state (a superset; extras are ignored).
pub fn reconstruct(
    ordered_leaves: &[B256],
    candidates: &[RawEdge],
    cp_acc: B256,
    cp_leaf_count: u64,
) -> Result<Vec<RawEdge>> {
    if ordered_leaves.len() as u64 != cp_leaf_count {
        bail!(
            "expected {} folded leaves for the checkpoint, found {} EdgeFolded events",
            cp_leaf_count,
            ordered_leaves.len()
        );
    }

    let mut by_leaf: HashMap<B256, &RawEdge> = HashMap::with_capacity(candidates.len());
    for e in candidates {
        by_leaf.insert(edge_leaf_of(e), e);
    }

    let mut edges = Vec::with_capacity(ordered_leaves.len());
    for (i, leaf) in ordered_leaves.iter().enumerate() {
        match by_leaf.get(leaf) {
            Some(e) => edges.push((*e).clone()),
            None => bail!(
                "no reconstructed attestation reproduces folded leaf #{i} ({leaf:#x}): the input set \
                 is incomplete (a missing attestation/revocation) or a field (attester/recipient/uid/\
                 timestamp/data) is wrong. Check the schema filter and the from-block range."
            ),
        }
    }

    // The guarantee: re-folding the assembled edges must reproduce the chain-pinned commitment.
    let (acc, n) = encode::accumulate(&edges);
    if acc != cp_acc || n != cp_leaf_count {
        bail!(
            "reconstruction self-check FAILED: re-folded acc {acc:#x} (n={n}) != checkpoint acc \
             {cp_acc:#x} (leafCount={cp_leaf_count}). The fold order or an edge field is wrong."
        );
    }

    Ok(edges)
}

#[cfg(test)]
mod tests {
    use super::*;
    use alloy_primitives::{Address, U256};

    fn edge(kind: u8, from: u8, to: u8, uid: u8, ts: u64, w: u64) -> RawEdge {
        let mut data = vec![0u8; 64];
        data[32..64].copy_from_slice(&U256::from(w).to_be_bytes::<32>());
        RawEdge {
            kind,
            attester: Address::from([from; 20]),
            recipient: Address::from([to; 20]),
            uid: B256::from([uid; 32]),
            block_timestamp: ts,
            data,
        }
    }

    /// Build a golden fold sequence + its acc from an ordered edge set.
    fn fold(edges: &[RawEdge]) -> (Vec<B256>, B256, u64) {
        let leaves: Vec<B256> = edges.iter().map(edge_leaf_of).collect();
        let (acc, n) = encode::accumulate(edges);
        (leaves, acc, n)
    }

    #[test]
    fn reconstructs_in_fold_order_from_shuffled_candidates() {
        let edges =
            vec![edge(0, 1, 2, 1, 100, 50), edge(0, 2, 3, 2, 101, 75), edge(1, 2, 3, 2, 103, 75)];
        let (leaves, acc, n) = fold(&edges);

        // Candidates arrive unordered and with an unrelated extra edge mixed in.
        let candidates =
            vec![edges[2].clone(), edge(0, 9, 9, 9, 1, 1), edges[0].clone(), edges[1].clone()];

        let got = reconstruct(&leaves, &candidates, acc, n).unwrap();
        assert_eq!(got, edges, "must recover the exact fold-ordered edge set");
    }

    #[test]
    fn errors_on_missing_candidate() {
        let edges = vec![edge(0, 1, 2, 1, 100, 50), edge(0, 2, 3, 2, 101, 75)];
        let (leaves, acc, n) = fold(&edges);
        // Drop the second edge from the candidate pool.
        let err = reconstruct(&leaves, &edges[..1], acc, n).unwrap_err();
        assert!(err.to_string().contains("no reconstructed attestation reproduces folded leaf #1"));
    }

    #[test]
    fn errors_on_wrong_leaf_count() {
        let edges = vec![edge(0, 1, 2, 1, 100, 50)];
        let (leaves, acc, _) = fold(&edges);
        let err = reconstruct(&leaves, &edges, acc, 5).unwrap_err();
        assert!(err.to_string().contains("expected 5 folded leaves"));
    }

    #[test]
    fn errors_on_tampered_acc() {
        // Same leaves + candidates but a corrupted checkpoint acc must fail the self-check. Force a
        // leaf/candidate set that assembles but whose acc is wrong by passing a bogus cp_acc that
        // still has the right count.
        let edges = vec![edge(0, 1, 2, 1, 100, 50), edge(0, 2, 3, 2, 101, 75)];
        let (leaves, _acc, n) = fold(&edges);
        let bogus = B256::from([0xEE; 32]);
        let err = reconstruct(&leaves, &edges, bogus, n).unwrap_err();
        assert!(err.to_string().contains("self-check FAILED"));
    }

    #[test]
    fn weighted_lane_one_uses_the_identical_fold_leaf_bytes() {
        let binary = edge(0, 1, 2, 3, 123, 77);
        let weighted = weighted_prior_core::RawEdge {
            kind: binary.kind,
            attester: binary.attester,
            recipient: binary.recipient,
            uid: binary.uid,
            block_timestamp: binary.block_timestamp,
            data: binary.data.clone(),
        };
        assert_eq!(
            edge_leaf_of(&binary),
            weighted_prior_core::encode::edge_leaf(&weighted),
            "operator reconstruction must be byte-identical to the isolated weighted guest"
        );
    }
}
