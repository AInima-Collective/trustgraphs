//! keccak256 bench (tiny-keccak). Fills a `len`-byte buffer with the shared deterministic loop
//! (see memfill), hashes it once, commits the digest. Subtract bench-memfill at the same size to
//! isolate the hash cost.
#![no_main]
sp1_zkvm::entrypoint!(main);

use tiny_keccak::{Hasher, Keccak};

pub fn main() {
    let len: u32 = sp1_zkvm::io::read();
    let mut buf = vec![0u8; len as usize];
    for i in 0..buf.len() {
        buf[i] = (i as u8).wrapping_mul(31).wrapping_add(7);
    }
    let mut hasher = Keccak::v256();
    hasher.update(&buf);
    let mut out = [0u8; 32];
    hasher.finalize(&mut out);
    sp1_zkvm::io::commit_slice(&out);
}
