//! Experimental SP1 cycle benchmark for issue #34. This detached crate cannot rotate a shipped
//! program vkey.

#![no_main]
sp1_zkvm::entrypoint!(main);

use weighted_prior_research::{rank_digest, sparse_rank, BenchInput};

pub fn main() {
    let input: BenchInput = sp1_zkvm::io::read();
    let digest = rank_digest(&sparse_rank(&input));
    sp1_zkvm::io::commit_slice(digest.as_slice());
}
