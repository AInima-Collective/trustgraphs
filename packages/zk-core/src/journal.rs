//! The journal discipline: every program's journal is a hand-rolled STATIC-ABI tuple —
//! a concatenation of 32-byte words in a FROZEN field order — and the on-chain verifier
//! binds `keccak256` of those exact bytes.
//!
//! Program crates own their journal shapes (field structs + `*_encoded` functions built
//! from [`crate::words`]); this module holds the shape-independent pieces so a new
//! program cannot invent a second digest convention.

use alloy_primitives::{keccak256, B256};

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
