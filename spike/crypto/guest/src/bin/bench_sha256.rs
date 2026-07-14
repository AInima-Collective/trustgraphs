//! SHA-256 bench (sha2) — this is the MST-walk hash. Fills a `len`-byte buffer with the shared
//! deterministic loop (see memfill), hashes it once, commits the digest. Subtract bench-memfill at
//! the same size to isolate the hash cost.
#![no_main]
sp1_zkvm::entrypoint!(main);

use sha2::{Digest, Sha256};

pub fn main() {
    let len: u32 = sp1_zkvm::io::read();
    let mut buf = vec![0u8; len as usize];
    for i in 0..buf.len() {
        buf[i] = (i as u8).wrapping_mul(31).wrapping_add(7);
    }
    let out = Sha256::digest(&buf);
    sp1_zkvm::io::commit_slice(&out);
}
