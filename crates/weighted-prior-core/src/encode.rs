//! Frozen ABI-word encodings for the weighted-prior params and journal.

use alloy_primitives::{keccak256, B256};

use crate::Params;

pub use zk_core::fold::fold;
// The lane-1 accumulator encodings and the journal-v3 tuple are shared with the other
// root-producer programs and live in `zk-core`; re-exported so call sites are unchanged.
pub use zk_core::edge::{accumulate, edge_leaf};
pub use zk_core::journal::{journal_digest, journal_encoded};
pub use zk_core::words::{word_addr, word_u256, word_u32, word_u64, word_u8};

/// Frozen weighted V1 tuple:
/// `abi.encode(uint32 version, uint64 dampingFp, uint64 toleranceFp, uint32 maxIterations,
/// uint64 minWeight, uint64 maxWeight, bytes32 priorRoot, uint32 priorCount,
/// bytes32 manifestSha256, bytes32 schemaUid, uint32 weightFieldIndex, address accumulator,
/// uint64 chainId)`.
pub fn params_encoded(params: &Params) -> Vec<u8> {
    let mut encoded = Vec::with_capacity(32 * 13);
    encoded.extend_from_slice(&word_u32(params.version));
    encoded.extend_from_slice(&word_u64(params.damping_fp));
    encoded.extend_from_slice(&word_u64(params.tolerance_fp));
    encoded.extend_from_slice(&word_u32(params.max_iterations));
    encoded.extend_from_slice(&word_u64(params.min_weight));
    encoded.extend_from_slice(&word_u64(params.max_weight));
    encoded.extend_from_slice(params.prior_root.as_slice());
    encoded.extend_from_slice(&word_u32(params.prior_count));
    encoded.extend_from_slice(params.manifest_sha256.as_slice());
    encoded.extend_from_slice(params.schema_uid.as_slice());
    encoded.extend_from_slice(&word_u32(params.weight_field_index));
    encoded.extend_from_slice(&word_addr(params.accumulator));
    encoded.extend_from_slice(&word_u64(params.chain_id));
    encoded
}

pub fn params_hash(params: &Params) -> B256 {
    keccak256(params_encoded(params))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Journal;
    use alloy_primitives::{Address, U256};

    #[test]
    fn journal_is_exactly_twelve_words() {
        let journal = Journal {
            acc: B256::ZERO,
            leaf_count: 0,
            anchor_acc: B256::ZERO,
            anchor_count: 0,
            params_hash: B256::ZERO,
            output_root: B256::ZERO,
            ipfs_hash: B256::ZERO,
            cid_digest: B256::ZERO,
            total_value: U256::ZERO,
            skipped_digest: B256::ZERO,
            recipient: Address::ZERO,
            instance_domain: B256::ZERO,
        };
        assert_eq!(journal_encoded(&journal).len(), 32 * 12);
    }
}
