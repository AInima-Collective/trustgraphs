//! The chained-hash accumulator fold — the input-commitment primitive for every lane.
//!
//! Lane 1 (`AttestationAccumulator`) folds attestation edge leaves on-chain; lane 2
//! (`AnchorRegistry`) folds anchor leaves the same way. Guests re-fold their witnessed
//! leaf sequence with this exact function to reproduce the checkpointed accumulator.

use alloy_primitives::{keccak256, B256};

/// Fold a leaf into the running accumulator: `acc' = keccak256(abi.encode(bytes32 acc, bytes32 leaf))`.
/// `acc_0 = bytes32(0)`.
pub fn fold(prev: B256, leaf: B256) -> B256 {
    let mut buf = [0u8; 64];
    buf[..32].copy_from_slice(prev.as_slice());
    buf[32..].copy_from_slice(leaf.as_slice());
    keccak256(&buf)
}
