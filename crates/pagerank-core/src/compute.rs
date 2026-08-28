//! Top-level canonical computation: folded edges + params → journal + artifacts.
//! This is the single function the SP1 guest, the host, and the browser all call.

use crate::{cid, distribute, encode, merkle, pagerank, reconcile};
use crate::{ComputeResult, GuestInput, Journal};
use alloy_primitives::{keccak256, Address, B256, U256};

/// Run the full lane-1 pipeline. Deterministic and float-free. The journal commits the empty
/// lane 2 (zero accumulator) — the strict two-lane statement lives in `trustgraph_core::compute`.
pub fn compute(input: &GuestInput) -> ComputeResult {
    // 1. Reproduce the chain-pinned input commitment (lane 1).
    let (acc, leaf_count) = encode::accumulate(&input.edges);

    // 2. Reproduce the governance-pinned params commitment.
    let params_hash = encode::params_hash(&input.params);

    // 3. Reconcile → graph → scores.
    let graph = reconcile::build_graph(&input.edges, &input.params);
    let rank_result = pagerank::calculate_generic_detailed(
        &graph.nodes,
        &graph.outgoing,
        &pagerank::RankConfig {
            damping_fp: input.params.damping_fp,
            tolerance_fp: input.params.tolerance_fp,
            max_iterations: input.params.max_iterations,
            trust_share_fp: input.params.trust_share_fp,
            trust_decay_fp: input.params.trust_decay_fp,
            scale: input.params.precision_scale,
            seeds: input.params.trusted_seeds.iter().copied().collect(),
        },
    );
    let rank = rank_result.telemetry(input.params.max_iterations);
    let scores_fp = rank_result.scores;
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

    // Journal v3: this statement commits the empty lane 2 as the zero accumulator
    // (empty-lane-as-zero; the guest, not the contract, decides what an empty lane means).
    // The last two fields are pass-throughs the contract re-derives and binds.
    let journal = Journal {
        acc,
        leaf_count,
        anchor_acc: B256::ZERO,
        anchor_count: 0,
        params_hash,
        output_root,
        ipfs_hash,
        cid_digest,
        total_value,
        skipped_digest: B256::ZERO,
        recipient: input.binding.recipient,
        instance_domain: input.binding.instance_domain,
    };
    ComputeResult { journal, scores: assigned, blob, cid: cid_str, rank, signature_checks: 0 }
}

/// The journal digest the on-chain verifier binds.
pub fn journal_digest(j: &Journal) -> B256 {
    encode::journal_digest(j)
}
