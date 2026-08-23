//! Top-level canonical computation: folded edges + params → journal + artifacts.
//! This is the single function the SP1 guest, the host, and the browser all call.

use crate::{lane2, ComputeResult, GuestInput, Journal, RawEdge};
use alloy_primitives::{keccak256, Address, B256, U256};
use pagerank_core::{cid, distribute, encode, merkle, pagerank, reconcile};
use zk_core::anchor::skipped_digest;

/// Run the full pipeline. Deterministic and float-free.
pub fn compute(input: &GuestInput) -> ComputeResult {
    // 1. Reproduce the chain-pinned input commitment (lane 1).
    let (acc, leaf_count) = encode::accumulate(&input.edges);

    // 2. Reproduce the governance-pinned params commitment.
    let params_hash = encode::params_hash(&input.params);

    // 2b. Lane 2: strict envelope-0 verification. A configured hybrid lane must supply the
    //     complete witness (which may contain zero anchors); any invalid or missing node payload
    //     aborts the guest. An absent witness is valid only for a disabled lane-1-only profile.
    let lane2_result = match &input.lane2 {
        Some(w) => lane2::process(&input.params, w).unwrap_or_else(|error| {
            panic!("strict envelope-0 verification failed: {}", error.code())
        }),
        None => {
            assert!(
                input.params.envelope0_domain_separators.is_empty()
                    && input.params.lane2_max_head_age == 0,
                "configured envelope-0 lane requires a complete lane2 witness"
            );
            lane2::Lane2Result::default()
        }
    };

    // 3. Reconcile → graph → scores. Lane-2 edges append AFTER lane-1 in (anchor fold index,
    //    in-log position) order. Appending it makes reconciliation's `(timestamp, vec index)`
    //    sort realize `(timestamp, sourceLane, sourcePosition)`: lane 1 precedes lane 2 on ties.
    let mut all_edges: Vec<RawEdge> =
        Vec::with_capacity(input.edges.len() + lane2_result.edges.len());
    all_edges.extend_from_slice(&input.edges);
    all_edges.extend_from_slice(&lane2_result.edges);
    let graph = reconcile::build_graph(&all_edges, &input.params);
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

    // Journal v3: lane-2 fields come from the processed witness (the zero accumulator when
    // the lane is empty — empty-lane-as-zero; the guest, not the contract, decides what an
    // empty lane means). A valid Trustgraphs envelope-0 result has no skips, so skippedDigest is
    // zero. The journal-v3 field remains for other programs. The last two fields are pass-throughs
    // the contract re-derives and binds.
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
        recipient: input.binding.recipient,
        instance_domain: input.binding.instance_domain,
    };
    ComputeResult {
        journal,
        scores: assigned,
        blob,
        cid: cid_str,
        rank,
        signature_checks: lane2_result.signature_checks,
    }
}

/// The journal digest the on-chain verifier binds.
pub fn journal_digest(j: &Journal) -> B256 {
    encode::journal_digest(j)
}
