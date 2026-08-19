//! Whole-live-fixture TGNW Option-A round trip: strict bounded decode, data commitment, complete
//! audit-prefix fold, audited-event coverage, NIP-01 id/signature checks, and all NIP-OA checks.
#![no_main]
sp1_zkvm::entrypoint!(main);

#[path = "bench_common.rs"]
mod common;

pub fn main() {
    let (bundle, expected_commitment): (Vec<u8>, Vec<u8>) = sp1_zkvm::io::read();
    let output = common::verify_tgnw_option_a(&bundle, &expected_commitment);
    sp1_zkvm::io::commit_slice(&output);
}
