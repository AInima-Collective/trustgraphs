//! AUDIT PoC (pre-testnet review, agent 2 — cross-language encoding parity).
//!
//! The hypercerts and nostr-workspace output trees mix TWO leaf families in ONE untagged tree:
//!   * `compute::node_output_leaf(nodeId, value)`   — keccak(keccak(bytes32 ‖ uint256))
//!   * `zk_core::merkle::output_leaf(account, v)`   — keccak(keccak(address-word ‖ uint256))
//!
//! They are the same function of a 32-byte key. Nothing in the encoding distinguishes them, so
//! the only separation is that `nodeId = keccak(did)` is unlikely to have 12 leading zero bytes.
//!
//! Run: cargo test -p hypercerts-core --test audit_poc_leaf_domain -- --nocapture

use alloy_primitives::{Address, B256, U256};

/// PASSES — that is the finding.
#[test]
fn address_leaf_is_a_node_leaf_with_a_zero_padded_id() {
    let addr = Address::from([0xBE; 20]);
    let value = U256::from(1_234_567u64);

    let address_leaf = zk_core::merkle::output_leaf(addr, value);

    let mut id = [0u8; 32];
    id[12..].copy_from_slice(addr.as_slice());
    let node_leaf = hypercerts_core::compute::node_output_leaf(B256::from(id), value);

    assert_eq!(
        address_leaf, node_leaf,
        "a nodeId with 12 leading zero bytes IS an address leaf: both families share one \
         untagged tree; only the ~2^96 cost of grinding keccak(did) into that shape separates them"
    );
}

/// The OZ double hash DOES separate leaves from internal nodes (leaf preimage = 32 bytes,
/// internal preimage = 64 bytes), so the classic node-replayed-as-leaf attack is closed.
#[test]
fn internal_node_preimage_length_differs_from_leaf_preimage_length() {
    let a = B256::from([0x01; 32]);
    let b = B256::from([0x02; 32]);
    // internal node: keccak over 64 bytes
    let mut buf = [0u8; 64];
    buf[..32].copy_from_slice(a.as_slice());
    buf[32..].copy_from_slice(b.as_slice());
    let internal = alloy_primitives::keccak256(buf);
    // leaf: keccak over the 32-byte inner hash
    let leaf = hypercerts_core::compute::node_output_leaf(a, U256::from(1));
    assert_ne!(internal, leaf);
}
