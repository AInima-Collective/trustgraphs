//! Top-level canonical computation: folded edges + params → journal + artifacts.
//! This is the single function the SP1 guest, the host, and the browser all call.

use crate::{cid, distribute, encode, lane2, merkle, pagerank, reconcile};
use crate::{ComputeResult, GuestInput, Journal, RawEdge};
use alloy_primitives::{keccak256, Address, B256, U256};
use zk_core::anchor::skipped_digest;

/// Run the full pipeline. Deterministic and float-free.
pub fn compute(input: &GuestInput) -> ComputeResult {
    // 1. Reproduce the chain-pinned input commitment (lane 1).
    let (acc, leaf_count) = encode::accumulate(&input.edges);

    // 2. Reproduce the governance-pinned params commitment.
    let params_hash = encode::params_hash(&input.params);

    // 2b. Lane 2: re-fold the anchor log, verify envelopes, apply rule Φ. An absent witness
    //     is the empty lane (zero accumulator) — the guest asserts what "empty" means.
    let lane2_result = match &input.lane2 {
        Some(w) => lane2::process(&input.params, w),
        None => lane2::Lane2Result::default(),
    };

    // 3. Reconcile → graph → scores. Lane-2 edges append AFTER lane-1 in (anchor fold index,
    //    in-log position) order, so reconciliation's global `(timestamp, vec index)` sort
    //    realizes the cross-lane total order of OFFCHAIN §4.3.
    let mut all_edges: Vec<RawEdge> =
        Vec::with_capacity(input.edges.len() + lane2_result.edges.len());
    all_edges.extend_from_slice(&input.edges);
    all_edges.extend_from_slice(&lane2_result.edges);
    let graph = reconcile::build_graph(&all_edges, &input.params);
    let scores_fp = pagerank::calculate(&graph, &input.params);
    let filtered: Vec<(Address, U256)> =
        scores_fp.into_iter().filter(|(_, v)| !v.is_zero()).collect();

    // 4. Distribute points; sort ascending by address for the blob + tree determinism.
    let (mut assigned, total_value) = distribute::distribute_points(&filtered, &input.params);
    assigned.sort_by(|a, b| a.0.cmp(&b.0));

    // 5. Output merkle root (OZ standard tree; leaves match MerkleSnapshot.sol:129).
    let leaves: Vec<B256> = assigned.iter().map(|(a, v)| merkle::output_leaf(*a, *v)).collect();
    let output_root = merkle::merkle_root(leaves);

    // 6. Canonical IPFS blob + CIDv1(raw, sha2-256).
    let blob = cid::canonical_blob(&assigned);
    let digest = cid::sha256(&blob);
    let ipfs_hash = B256::from(digest);
    let cid_str = cid::cid_v1_raw(&digest);
    let cid_digest = keccak256(cid_str.as_bytes());

    // Journal v2: lane-2 fields come from the processed witness (the zero accumulator when
    // the lane is empty — empty-lane-as-zero; the guest, not the contract, decides what an
    // empty lane means). skippedDigest commits every rule-Φ deviation.
    let journal = Journal {
        acc,
        leaf_count,
        anchor_acc: lane2_result.anchor_acc,
        anchor_count: lane2_result.anchor_count,
        params_hash,
        output_root,
        ipfs_hash,
        cid_digest,
        total_value,
        skipped_digest: skipped_digest(&lane2_result.skips),
    };
    ComputeResult { journal, scores: assigned, blob, cid: cid_str }
}

/// The journal digest the on-chain verifier binds.
pub fn journal_digest(j: &Journal) -> B256 {
    encode::journal_digest(j)
}
