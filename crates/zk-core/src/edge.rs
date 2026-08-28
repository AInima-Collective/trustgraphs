//! The lane-1 attestation accumulator: the folded edge stream every root-producer program
//! reconstructs and re-commits (`AttestationAccumulator` on-chain). Shared verbatim so the
//! trust-graph and weighted-prior guests stay byte-identical on the same feed.

use crate::fold::fold;
use crate::words::{word_addr, word_u256, word_u8};
use alloy_primitives::{keccak256, Address, B256, U256};
use serde::{Deserialize, Serialize};

/// One folded attestation edge, exactly as the accumulator ingested it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct RawEdge {
    /// 0 = attest, 1 = revoke. Programs ignore kinds they do not consume.
    pub kind: u8,
    pub attester: Address,
    pub recipient: Address,
    pub uid: B256,
    /// The `block.timestamp` folded on-chain (drives the reconciliation order).
    pub block_timestamp: u64,
    /// Raw attestation data (ABI-encoded per the instance's schema).
    #[serde(with = "crate::serde_hex")]
    pub data: Vec<u8>,
}

impl RawEdge {
    /// This edge's accumulator leaf.
    pub fn leaf(&self) -> B256 {
        edge_leaf(
            self.kind,
            self.attester,
            self.recipient,
            self.uid,
            self.block_timestamp,
            keccak256(&self.data),
        )
    }
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

/// Recompute the running accumulator over the full edge set, returning `(acc, leafCount)`.
/// `acc_0 = bytes32(0)`.
pub fn accumulate(edges: &[RawEdge]) -> (B256, u64) {
    let mut acc = B256::ZERO;
    for e in edges {
        acc = fold(acc, e.leaf());
    }
    (acc, edges.len() as u64)
}
