//! Top-level weighted-prior computation shared byte-for-byte by native hosts and the SP1 guest.

use alloy_primitives::{keccak256, B256, U256};

use crate::{
    encode, manifest, rank, reconcile, ComputeResult, GuestInput, Journal, WeightedError, SCALE,
};

pub fn compute(input: &GuestInput) -> Result<ComputeResult, WeightedError> {
    input.params.validate()?;
    let parsed = manifest::validate_manifest(&input.manifest, &input.params)?;
    let (acc, leaf_count) = encode::accumulate(&input.edges);
    let params_hash = encode::params_hash(&input.params);
    let graph = reconcile::build_flat_graph(&input.edges, &input.params);
    let ranked = rank::calculate_flat(&graph, &parsed.entries, &input.params)?;

    let scores = ranked
        .scores
        .into_iter()
        .filter(|(_, value)| *value > 0)
        .map(|(account, value)| (account, U256::from(value)))
        .collect::<Vec<_>>();
    let leaves = scores
        .iter()
        .map(|(account, value)| zk_core::merkle::output_leaf(*account, *value))
        .collect();
    let output_root = zk_core::merkle::merkle_root(leaves);
    let blob = zk_core::cid::canonical_blob(&scores);
    let sha256 = zk_core::cid::sha256(&blob);
    let ipfs_hash = B256::from(sha256);
    let cid = zk_core::cid::cid_v1_raw(&sha256);
    let cid_digest = keccak256(cid.as_bytes());
    let journal = Journal {
        acc,
        leaf_count,
        anchor_acc: B256::ZERO,
        anchor_count: 0,
        params_hash,
        output_root,
        ipfs_hash,
        cid_digest,
        total_value: U256::from(SCALE),
        skipped_digest: B256::ZERO,
        recipient: input.binding.recipient,
        instance_domain: input.binding.instance_domain,
    };
    Ok(ComputeResult { journal, scores, blob, cid, iterations: ranked.iterations })
}

pub fn journal_digest(journal: &Journal) -> B256 {
    encode::journal_digest(journal)
}
