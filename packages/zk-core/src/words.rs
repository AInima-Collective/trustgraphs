//! 32-byte ABI words — the atoms of every static-tuple encoding we share with Solidity.
//!
//! All tuples we encode are composed of STATIC ABI types (uintN, address, bytes32), so
//! `abi.encode` is simply the concatenation of 32-byte big-endian words. We hand-roll it
//! (rather than pull in a proc-macro ABI crate) for auditability and zkVM-friendliness.

use alloy_primitives::{Address, U256};

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
