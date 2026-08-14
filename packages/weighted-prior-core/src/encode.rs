//! Frozen ABI-word encodings for the weighted-prior params and journal.

use alloy_primitives::{keccak256, B256, U256};

use crate::{Journal, Params, RawEdge};

pub use zk_core::fold::fold;
pub use zk_core::words::{word_addr, word_u256, word_u32, word_u64, word_u8};

/// `keccak256(abi.encode(uint8 kind, address attester, address recipient, bytes32 uid,
/// uint256 blockTimestamp, bytes32 dataHash))`.
pub fn edge_leaf(edge: &RawEdge) -> B256 {
    let mut encoded = [0u8; 32 * 6];
    encoded[..32].copy_from_slice(&word_u8(edge.kind));
    encoded[32..64].copy_from_slice(&word_addr(edge.attester));
    encoded[64..96].copy_from_slice(&word_addr(edge.recipient));
    encoded[96..128].copy_from_slice(edge.uid.as_slice());
    encoded[128..160].copy_from_slice(&word_u256(U256::from(edge.block_timestamp)));
    encoded[160..].copy_from_slice(keccak256(&edge.data).as_slice());
    keccak256(encoded)
}

pub fn accumulate(edges: &[RawEdge]) -> (B256, u64) {
    let mut acc = B256::ZERO;
    for edge in edges {
        acc = fold(acc, edge_leaf(edge));
    }
    (acc, edges.len() as u64)
}

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

/// Common 12-word root-producer journal v3. Weighted V1 sets the two lane-two words and
/// `skippedDigest` to zero, but retains their slots for verifier compatibility.
pub fn journal_encoded(journal: &Journal) -> Vec<u8> {
    let mut encoded = Vec::with_capacity(32 * 12);
    encoded.extend_from_slice(journal.acc.as_slice());
    encoded.extend_from_slice(&word_u64(journal.leaf_count));
    encoded.extend_from_slice(journal.anchor_acc.as_slice());
    encoded.extend_from_slice(&word_u64(journal.anchor_count));
    encoded.extend_from_slice(journal.params_hash.as_slice());
    encoded.extend_from_slice(journal.output_root.as_slice());
    encoded.extend_from_slice(journal.ipfs_hash.as_slice());
    encoded.extend_from_slice(journal.cid_digest.as_slice());
    encoded.extend_from_slice(&word_u256(journal.total_value));
    encoded.extend_from_slice(journal.skipped_digest.as_slice());
    encoded.extend_from_slice(&word_addr(journal.recipient));
    encoded.extend_from_slice(journal.instance_domain.as_slice());
    encoded
}

pub fn journal_digest(journal: &Journal) -> B256 {
    keccak256(journal_encoded(journal))
}

#[cfg(test)]
mod tests {
    use super::*;
    use alloy_primitives::Address;

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
