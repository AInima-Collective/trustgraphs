//! The journal discipline: every program's journal is a hand-rolled STATIC-ABI tuple —
//! a concatenation of 32-byte words in a FROZEN field order — and the on-chain verifier
//! binds `keccak256` of those exact bytes.
//!
//! Program crates own their journal shapes (field structs + `*_encoded` functions built
//! from [`crate::words`]); this module holds the shape-independent pieces so a new
//! program cannot invent a second digest convention.

use crate::words::{word_addr, word_u256};
use alloy_primitives::{keccak256, Address, B256, U256};

/// Concatenate 32-byte ABI words into the encoded static tuple (`abi.encode` of a tuple
/// whose members are all static types).
pub fn encode_words(words: &[[u8; 32]]) -> Vec<u8> {
    let mut buf = Vec::with_capacity(32 * words.len());
    for w in words {
        buf.extend_from_slice(w);
    }
    buf
}

/// The journal digest the on-chain verifier binds: `keccak256(encoded)`.
pub fn digest(encoded: &[u8]) -> B256 {
    keccak256(encoded)
}

/// Universal domain separation: `keccak256(abi.encode(address snapshot, uint256 chainId))`.
///
/// Every program's journal commits this value, and `MerkleSnapshot.submitProof` REBUILDS it from
/// `address(this)` and `block.chainid` rather than accepting it as an argument. Two consequences,
/// both deliberate:
///
/// 1. A submitter cannot lie about which instance a proof is for — a proof carrying instance A's
///    domain produces a digest that instance B's `submitProof` never computes.
/// 2. No program's params codec has to remember to include an instance-unique field. This is the
///    universal form of the fix `INSTANCE_FACTORY.md` §6.1 made per-program in the trust-graph
///    params schema, and it is what closes the hypercerts hole (its params carry no
///    instance-unique field at all, so two identically-configured hypercerts instances accepted
///    each other's proofs — issue #9).
///
/// `chain_id` is encoded as a `uint256` because that is the Solidity type of `block.chainid`.
pub fn instance_domain(snapshot: Address, chain_id: u64) -> B256 {
    keccak256(encode_words(&[word_addr(snapshot), word_u256(U256::from(chain_id))]))
}
