//! Exact byte encodings shared with Solidity. Every function here is golden-tested against
//! `abi.encode` / `keccak256` / `sha256` in
//! `contracts/test/unit/golden/TrustgraphsGoldenVectors.t.sol`
//! (`research/ZK_ARCHITECTURE.md` §4.1).
//!
//! All tuples we encode are composed of STATIC ABI types (uintN, address, bytes32), so
//! `abi.encode` is simply the concatenation of 32-byte big-endian words. We hand-roll it (rather
//! than pull in a proc-macro ABI crate) for auditability and zkVM-friendliness.

use crate::{merkle, Params, SelectionParams, SignerJournal, PARAMS_SCHEMA_VERSION};
use alloy_primitives::{keccak256, B256, U256};

// The word encoders and the accumulator fold are program-agnostic and live in `zk-core`;
// re-exported so every existing `encode::word_*` / `encode::fold` call site is unchanged.
pub use zk_core::fold::fold;
// Journal-v3 domain separation is universal, so it lives in `zk-core` and every program crate
// re-exports it from the same place its journal encoder lives.
pub use zk_core::journal::instance_domain;
// The lane-1 accumulator encodings and the journal-v3 tuple are shared with the other
// root-producer programs and live in `zk-core`; re-exported so call sites are unchanged.
pub use zk_core::edge::{accumulate, edge_leaf};
pub use zk_core::journal::{journal_digest, journal_encoded};
pub use zk_core::words::{word_addr, word_u256, word_u32, word_u64, word_u8};

/// The lane-2 domain-set word: zero for disabled/empty, otherwise keccak of the ordered separators.
pub fn domain_set_hash(separators: &[B256]) -> B256 {
    if separators.is_empty() {
        return B256::ZERO;
    }

    let mut encoded = Vec::with_capacity(32 * separators.len());
    for separator in separators {
        encoded.extend_from_slice(separator.as_slice());
    }
    keccak256(encoded)
}

/// The governance-pinned `paramsHash` (`research/ZK_ARCHITECTURE.md` §4.1). `seedSetRoot` is
/// computed over the sorted trusted-seed set. The guest computes this from its private `Params`
/// witness and commits it as a journal field; it is bound to the stored value because
/// `MerkleSnapshot.submitProof` builds the journal digest from `storage.paramsHash` — a proof whose
/// params differ yields a different digest and fails verification. (There is no in-guest assertion;
/// the binding is the digest match.)
pub fn params_hash(p: &Params) -> B256 {
    let mut seeds = p.trusted_seeds.clone();
    seeds.sort();
    let seed_set_root = merkle::seed_set_root(&seeds);

    // Lane-2 domain set: keccak over the concatenated separators; 0 = lane 2 disabled.
    let domain_set_hash = domain_set_hash(&p.envelope0_domain_separators);

    let mut buf = Vec::with_capacity(32 * 17);
    buf.extend_from_slice(&word_u32(PARAMS_SCHEMA_VERSION));
    buf.extend_from_slice(&word_u256(p.damping_fp));
    buf.extend_from_slice(&word_u256(p.tolerance_fp));
    buf.extend_from_slice(&word_u32(p.max_iterations));
    buf.extend_from_slice(&word_u256(p.min_weight_fp));
    buf.extend_from_slice(&word_u256(p.max_weight_fp));
    buf.extend_from_slice(&word_u256(p.trust_share_fp));
    buf.extend_from_slice(&word_u256(p.trust_decay_fp));
    buf.extend_from_slice(seed_set_root.as_slice());
    buf.extend_from_slice(&word_u256(p.total_pool));
    buf.extend_from_slice(&word_u256(p.precision_scale));
    buf.extend_from_slice(p.schema_uid.as_slice());
    buf.extend_from_slice(&word_u32(p.weight_field_index));
    buf.extend_from_slice(domain_set_hash.as_slice());
    buf.extend_from_slice(&word_u64(p.lane2_max_head_age));
    // Domain separation (INSTANCE_FACTORY §6.1), retained as preimage words 16-17 after the
    // schema-v3 version word was prepended. The journal shape is untouched.
    buf.extend_from_slice(&word_addr(p.accumulator));
    buf.extend_from_slice(&word_u64(p.chain_id));
    keccak256(&buf)
}

/// The governance-pinned `selectionParamsHash` for the Safe signer-sync proof:
/// `keccak256(abi.encode(uint32 topN, uint32 minThreshold, uint32 targetThresholdBps,
///                       uint64 maxInactiveBlocks, uint32 minActivityWitnesses))`.
/// Bound the same way `paramsHash` is: `SignerSyncZkModule.submitSignerProof` builds the signer
/// journal digest from its stored `selectionParamsHash`, so a proof with different selection params
/// yields a different digest and fails verification.
pub fn selection_params_hash(sp: &SelectionParams) -> B256 {
    let mut buf = Vec::with_capacity(32 * 5);
    buf.extend_from_slice(&word_u32(sp.top_n));
    buf.extend_from_slice(&word_u32(sp.min_threshold));
    buf.extend_from_slice(&word_u32(sp.target_threshold_bps));
    buf.extend_from_slice(&word_u64(sp.max_inactive_blocks));
    buf.extend_from_slice(&word_u32(sp.min_activity_witnesses));
    keccak256(&buf)
}

/// The ABI-encoded signer journal tuple — the exact bytes the signer guest commits as `publicValues`:
/// `abi.encode(bytes32 acc, uint64 leafCount, bytes32 paramsHash, bytes32 selectionParamsHash,
///             bytes32 activityAcc, uint64 activityCount, uint64 activityBlock,
///             bool wasInitialized, bytes32 currentSignerSetRoot, uint256 currentThreshold,
///             bytes32 signerSetRoot, uint256 targetThreshold, bytes32 instanceDomain)`.
///
/// `instanceDomain` is a pass-through the guest copies from its witness, made binding by
/// `SignerSyncZkModule.submitSignerProof`, which rebuilds the digest with a domain derived from
/// `address(this)` + `block.chainid` (audit M-3).
pub fn signer_journal_encoded(j: &SignerJournal) -> Vec<u8> {
    let mut buf = Vec::with_capacity(32 * 13);
    buf.extend_from_slice(j.acc.as_slice());
    buf.extend_from_slice(&word_u64(j.leaf_count));
    buf.extend_from_slice(j.params_hash.as_slice());
    buf.extend_from_slice(j.selection_params_hash.as_slice());
    buf.extend_from_slice(j.activity_acc.as_slice());
    buf.extend_from_slice(&word_u64(j.activity_count));
    buf.extend_from_slice(&word_u64(j.activity_block));
    buf.extend_from_slice(&word_u32(u32::from(j.was_initialized)));
    buf.extend_from_slice(j.current_signer_set_root.as_slice());
    buf.extend_from_slice(&word_u256(j.current_threshold));
    buf.extend_from_slice(j.signer_set_root.as_slice());
    buf.extend_from_slice(&word_u256(j.target_threshold));
    buf.extend_from_slice(j.instance_domain.as_slice());
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
