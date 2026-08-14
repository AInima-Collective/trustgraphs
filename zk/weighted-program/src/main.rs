//! Isolated SP1 guest for `trust-graph-weighted` V1.

#![no_main]
sp1_zkvm::entrypoint!(main);

use weighted_prior_core::{compute::compute, encode::journal_encoded, GuestInput};

pub fn main() {
    let input: GuestInput = sp1_zkvm::io::read();
    let result = compute(&input).expect("invalid trust-graph-weighted V1 witness");
    sp1_zkvm::io::commit_slice(&journal_encoded(&result.journal));
}
