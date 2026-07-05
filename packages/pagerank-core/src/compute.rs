//! Top-level canonical computation: folded edges + params → journal + artifacts.
//! This is the single function the SP1 guest, the host, and the browser all call.

use crate::{cid, distribute, encode, merkle, pagerank, reconcile};
use crate::{ComputeResult, GuestInput, Journal};
use alloy_primitives::{keccak256, Address, B256, U256};

/// Run the full pipeline. Deterministic and float-free.
pub fn compute(input: &GuestInput) -> ComputeResult {
    // 1. Reproduce the chain-pinned input commitment.
    let (acc, leaf_count) = encode::accumulate(&input.edges);

    // 2. Reproduce the governance-pinned params commitment.
    let params_hash = encode::params_hash(&input.params);

    // 3. Reconcile → graph → scores.
    let graph = reconcile::build_graph(&input.edges, &input.params);
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

    let journal =
        Journal { acc, leaf_count, params_hash, output_root, ipfs_hash, cid_digest, total_value };
    ComputeResult { journal, scores: assigned, blob, cid: cid_str }
}

/// The journal digest the on-chain verifier binds.
pub fn journal_digest(j: &Journal) -> B256 {
    encode::journal_digest(j)
}
