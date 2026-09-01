//! Isolated SP1 guest for `trust-compose` params/manifest V2.

#![no_main]
sp1_zkvm::entrypoint!(main);

use composition_core_v2::{codec::journal_encoded, compute::compute, GuestInput};

pub fn main() {
    let input: GuestInput = sp1_zkvm::io::read();
    let result = compute(&input).expect("invalid trust-compose V2 witness");
    sp1_zkvm::io::commit_slice(&journal_encoded(&result.journal));
}
