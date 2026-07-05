//! Exact byte encodings shared with Solidity. Every function here is golden-tested against
//! `abi.encode` / `keccak256` / `sha256` in `test/unit/GoldenVectors.t.sol` (PLAN.md §1, WP2).
//!
//! All tuples we encode are composed of STATIC ABI types (uintN, address, bytes32), so
//! `abi.encode` is simply the concatenation of 32-byte big-endian words. We hand-roll it (rather
//! than pull in a proc-macro ABI crate) for auditability and zkVM-friendliness.

use crate::{merkle, Journal, Params, SelectionParams, SignerJournal};
use alloy_primitives::{keccak256, Address, B256, U256};

/// A 32-byte ABI word from a `U256`.
#[inline]
pub fn word_u256(x: U256) -> [u8; 32] {
    x.to_be_bytes()
}

/// A 32-byte ABI word from a `u64` (left-padded).
#[inline]
pub fn word_u64(x: u64) -> [u8; 32] {
    let mut w = [0u8; 32];
    w[24..].copy_from_slice(&x.to_be_bytes());
    w
}

/// A 32-byte ABI word from a `u32` (left-padded).
#[inline]
pub fn word_u32(x: u32) -> [u8; 32] {
    let mut w = [0u8; 32];
    w[28..].copy_from_slice(&x.to_be_bytes());
    w
}

/// A 32-byte ABI word from a `u8` (right-most byte).
#[inline]
pub fn word_u8(x: u8) -> [u8; 32] {
    let mut w = [0u8; 32];
    w[31] = x;
    w
}

/// A 32-byte ABI word from an `address` (right-aligned 20 bytes).
#[inline]
pub fn word_addr(a: Address) -> [u8; 32] {
    let mut w = [0u8; 32];
    w[12..].copy_from_slice(a.as_slice());
    w
}

/// The accumulator edge leaf:
/// `keccak256(abi.encode(uint8 kind, address attester, address recipient, bytes32 uid,
///                       uint256 blockTimestamp, bytes32 dataHash))`.
pub fn edge_leaf(
    kind: u8,
    attester: Address,
    recipient: Address,
    uid: B256,
    block_timestamp: u64,
    data_hash: B256,
) -> B256 {
    let mut buf = Vec::with_capacity(32 * 6);
    buf.extend_from_slice(&word_u8(kind));
    buf.extend_from_slice(&word_addr(attester));
    buf.extend_from_slice(&word_addr(recipient));
    buf.extend_from_slice(uid.as_slice());
    buf.extend_from_slice(&word_u256(U256::from(block_timestamp)));
    buf.extend_from_slice(data_hash.as_slice());
    keccak256(&buf)
}

/// Fold a leaf into the running accumulator: `acc' = keccak256(abi.encode(bytes32 acc, bytes32 leaf))`.
pub fn fold(prev: B256, leaf: B256) -> B256 {
    let mut buf = [0u8; 64];
    buf[..32].copy_from_slice(prev.as_slice());
    buf[32..].copy_from_slice(leaf.as_slice());
    keccak256(&buf)
}

/// Recompute the running accumulator over the full edge set, returning `(acc, leafCount)`.
/// `acc_0 = bytes32(0)`.
pub fn accumulate(edges: &[crate::RawEdge]) -> (B256, u64) {
    let mut acc = B256::ZERO;
    for e in edges {
        let data_hash = keccak256(&e.data);
        let leaf = edge_leaf(e.kind, e.attester, e.recipient, e.uid, e.block_timestamp, data_hash);
        acc = fold(acc, leaf);
    }
    (acc, edges.len() as u64)
}

/// The ABI-encoded journal tuple — the exact bytes the SP1 guest commits as `publicValues`, and the
/// preimage of the journal digest:
/// `abi.encode(bytes32 acc, uint64 leafCount, bytes32 paramsHash, bytes32 outputRoot,
///             bytes32 ipfsHash, bytes32 cidDigest, uint256 totalValue)`.
pub fn journal_encoded(j: &Journal) -> Vec<u8> {
    let mut buf = Vec::with_capacity(32 * 7);
    buf.extend_from_slice(j.acc.as_slice());
    buf.extend_from_slice(&word_u64(j.leaf_count));
    buf.extend_from_slice(j.params_hash.as_slice());
    buf.extend_from_slice(j.output_root.as_slice());
    buf.extend_from_slice(j.ipfs_hash.as_slice());
    buf.extend_from_slice(j.cid_digest.as_slice());
    buf.extend_from_slice(&word_u256(j.total_value));
    buf
}

/// The journal digest = `keccak256(journal_encoded(j))`. This is what the on-chain verifier binds.
pub fn journal_digest(j: &Journal) -> B256 {
    keccak256(journal_encoded(j))
}

/// The governance-pinned `paramsHash` (PLAN.md §1.3). `seedSetRoot` is computed over the sorted
/// trusted-seed set. The guest computes this from its private `Params` witness and commits it as a
/// journal field; it is bound to the stored value because `MerkleSnapshot.submitProof` builds the
/// journal digest from `storage.paramsHash` — a proof whose params differ yields a different digest
/// and fails verification. (There is no in-guest assertion; the binding is the digest match.)
pub fn params_hash(p: &Params) -> B256 {
    let mut seeds = p.trusted_seeds.clone();
    seeds.sort();
    let seed_set_root = merkle::seed_set_root(&seeds);

    let mut buf = Vec::with_capacity(32 * 13);
    buf.extend_from_slice(&word_u256(p.damping_fp));
    buf.extend_from_slice(&word_u256(p.tolerance_fp));
    buf.extend_from_slice(&word_u32(p.max_iterations));
    buf.extend_from_slice(&word_u256(p.min_weight_fp));
    buf.extend_from_slice(&word_u256(p.max_weight_fp));
    buf.extend_from_slice(&word_u256(p.trust_multiplier_fp));
    buf.extend_from_slice(&word_u256(p.trust_share_fp));
    buf.extend_from_slice(&word_u256(p.trust_decay_fp));
    buf.extend_from_slice(seed_set_root.as_slice());
    buf.extend_from_slice(&word_u256(p.total_pool));
    buf.extend_from_slice(&word_u256(p.precision_scale));
    buf.extend_from_slice(p.schema_uid.as_slice());
    buf.extend_from_slice(&word_u32(p.weight_field_index));
    keccak256(&buf)
}

/// The governance-pinned `selectionParamsHash` for the Safe signer-sync proof:
/// `keccak256(abi.encode(uint32 topN, uint32 minThreshold, uint32 targetThresholdBps))`.
/// Bound the same way `paramsHash` is: `SignerSyncZkModule.submitSignerProof` builds the signer
/// journal digest from its stored `selectionParamsHash`, so a proof with different selection params
/// yields a different digest and fails verification.
pub fn selection_params_hash(sp: &SelectionParams) -> B256 {
    let mut buf = Vec::with_capacity(32 * 3);
    buf.extend_from_slice(&word_u32(sp.top_n));
    buf.extend_from_slice(&word_u32(sp.min_threshold));
    buf.extend_from_slice(&word_u32(sp.target_threshold_bps));
    keccak256(&buf)
}

/// The ABI-encoded signer journal tuple — the exact bytes the signer guest commits as `publicValues`:
/// `abi.encode(bytes32 acc, uint64 leafCount, bytes32 paramsHash, bytes32 selectionParamsHash,
///             bytes32 signerSetRoot, uint256 targetThreshold)`.
pub fn signer_journal_encoded(j: &SignerJournal) -> Vec<u8> {
    let mut buf = Vec::with_capacity(32 * 6);
    buf.extend_from_slice(j.acc.as_slice());
    buf.extend_from_slice(&word_u64(j.leaf_count));
    buf.extend_from_slice(j.params_hash.as_slice());
    buf.extend_from_slice(j.selection_params_hash.as_slice());
    buf.extend_from_slice(j.signer_set_root.as_slice());
    buf.extend_from_slice(&word_u256(j.target_threshold));
    buf
}

/// The signer journal digest = `keccak256(signer_journal_encoded(j))`.
pub fn signer_journal_digest(j: &SignerJournal) -> B256 {
    keccak256(signer_journal_encoded(j))
}

/// Decode the confidence (weight) uint256 from ABI-encoded attestation `data` at head slot `index`.
///
/// For the schema `(string comment, uint256 confidence)`, `confidence` is a static `uint256` whose
/// value sits inline in ABI head slot 1. Any field preceding a static uint occupies exactly one head
/// slot (a value inline, or a dynamic-type offset), so the value is the 32-byte word at `index*32`.
/// Returns `None` if the data is too short — mirroring the legacy "decode failed ⇒ weight 0".
pub fn decode_weight(data: &[u8], index: u32) -> Option<U256> {
    let start = (index as usize).checked_mul(32)?;
    let end = start.checked_add(32)?;
    if data.len() < end {
        return None;
    }
    let mut word = [0u8; 32];
    word.copy_from_slice(&data[start..end]);
    Some(U256::from_be_bytes(word))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accumulate_empty_is_zero() {
        let (acc, n) = accumulate(&[]);
        assert_eq!(acc, B256::ZERO);
        assert_eq!(n, 0);
    }

    #[test]
    fn decode_weight_reads_second_word() {
        // abi.encode(string, uint256): head[0] = offset, head[1] = confidence (95).
        let mut data = vec![0u8; 64];
        data[63] = 95;
        assert_eq!(decode_weight(&data, 1), Some(U256::from(95)));
        assert_eq!(decode_weight(&data, 2), None);
    }
}
