//! Buffer-generation baseline for the hash benches. Fills `len` bytes with the SAME deterministic
//! loop that bench-keccak / bench-sha256 use, then commits 32 bytes WITHOUT hashing. Subtracting
//! this from a hash bench at the same size isolates the pure hash cost (fill + alloc + boot cancel).
#![no_main]
sp1_zkvm::entrypoint!(main);

pub fn main() {
    let len: u32 = sp1_zkvm::io::read();
    let mut buf = vec![0u8; len as usize];
    for i in 0..buf.len() {
        buf[i] = (i as u8).wrapping_mul(31).wrapping_add(7);
    }
    let mut out = [0u8; 32];
    let n = core::cmp::min(32, buf.len());
    out[..n].copy_from_slice(&buf[..n]);
    sp1_zkvm::io::commit_slice(&out);
}
