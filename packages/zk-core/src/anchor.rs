//! Lane-2 anchor-log encodings (OFFCHAIN_ATTESTATIONS_ZK §4.1) and the rule-Φ skip
//! commitment. Shared by every program that consumes an `AnchorRegistry` feed; the
//! per-envelope semantics live in the `envelopes` crate.

use crate::fold::fold;
use crate::words::{word_u256, word_u8};
use alloy_primitives::{keccak256, B256, U256};

/// The anchor-log leaf, exactly as `AnchorRegistry.anchor` folds it on-chain:
/// `keccak256(abi.encode(bytes32 nodeId, uint8 envelopeKind, bytes32 head,
///                       bytes32 dataCommitment, uint256 blockTimestamp))`.
pub fn anchor_leaf(
    node_id: B256,
    envelope_kind: u8,
    head: B256,
    data_commitment: B256,
    block_timestamp: u64,
) -> B256 {
    let mut buf = Vec::with_capacity(32 * 5);
    buf.extend_from_slice(node_id.as_slice());
    buf.extend_from_slice(&word_u8(envelope_kind));
    buf.extend_from_slice(head.as_slice());
    buf.extend_from_slice(data_commitment.as_slice());
    buf.extend_from_slice(&word_u256(U256::from(block_timestamp)));
    keccak256(&buf)
}

/// One rule-Φ / deterministic-skip record: this node's lane-2 data was skipped or
/// carried forward, with a closed-enum reason (per-program; see the program crate).
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub struct SkipEntry {
    pub node_id: B256,
    pub reason: u8,
    /// The epoch at which the condition was observed (staleness bookkeeping).
    pub epoch_observed: u64,
}

/// The skip-entry leaf: `keccak256(abi.encode(bytes32 nodeId, uint8 reason, uint64 epochObserved))`.
pub fn skip_leaf(e: &SkipEntry) -> B256 {
    let mut buf = Vec::with_capacity(32 * 3);
    buf.extend_from_slice(e.node_id.as_slice());
    buf.extend_from_slice(&word_u8(e.reason));
    buf.extend_from_slice(&crate::words::word_u64(e.epoch_observed));
    keccak256(&buf)
}

/// The journal's `skippedDigest`: the chained fold (acc_0 = 0) over skip-entry leaves in
/// canonical order — entries MUST be sorted ascending by (nodeId, reason, epochObserved)
/// before folding (use a BTree collection). The empty set is `bytes32(0)`, which is what a
/// lane-1-only guest asserts (empty-lane-as-zero, MULTI_PROGRAM_PLATFORM §4).
pub fn skipped_digest(sorted_entries: &[SkipEntry]) -> B256 {
    debug_assert!(sorted_entries.windows(2).all(|w| w[0] <= w[1]), "entries not sorted");
    let mut acc = B256::ZERO;
    for e in sorted_entries {
        acc = fold(acc, skip_leaf(e));
    }
    acc
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_skip_set_is_zero() {
        assert_eq!(skipped_digest(&[]), B256::ZERO);
    }

    #[test]
    fn skip_fold_matches_manual() {
        let e = SkipEntry { node_id: B256::from([0x11; 32]), reason: 1, epoch_observed: 7 };
        assert_eq!(skipped_digest(&[e]), fold(B256::ZERO, skip_leaf(&e)));
    }
}
