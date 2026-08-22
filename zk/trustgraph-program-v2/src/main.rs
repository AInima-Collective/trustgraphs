//! SP1 guest for the strict hybrid Trustgraphs root-producer statement.

#![no_main]
sp1_zkvm::entrypoint!(main);

use pagerank_core::encode::journal_encoded;
use trustgraph_core::{compute::compute, GuestInput};

pub fn main() {
    let input: GuestInput = sp1_zkvm::io::read();
    let result = compute(&input);
    sp1_zkvm::io::commit_slice(&journal_encoded(&result.journal));
}
