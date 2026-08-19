//! Buzz NIP-OA exact-preimage and owner BIP-340 prehash verification benchmark.
#![no_main]
sp1_zkvm::entrypoint!(main);

#[path = "bench_common.rs"]
mod common;

pub fn main() {
    let cases: Vec<common::OaCase> = sp1_zkvm::io::read();
    let mut accumulator = [0u8; 32];
    for case in &cases {
        let digest = common::verify_oa(case);
        for index in 0..32 {
            accumulator[index] ^= digest[index];
        }
    }
    sp1_zkvm::io::commit_slice(&accumulator);
}
