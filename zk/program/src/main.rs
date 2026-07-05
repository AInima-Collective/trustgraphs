//! SP1 guest: prove `journal == compute(pinned edges, pinned params)`.
//!
//! The guest reads the full `GuestInput`, runs the canonical `pagerank-core` pipeline, and commits
//! the ABI-encoded journal tuple as `publicValues`. The on-chain `SP1TrustGraphVerifier` then binds
//! `keccak256(publicValues)` to the checkpoint's `acc/leafCount`, the stored `paramsHash`, and the
//! submitted `outputRoot/ipfsHash/cid/totalValue`. All semantics live in `pagerank-core`.

#![no_main]
sp1_zkvm::entrypoint!(main);

use pagerank_core::{compute::compute, encode::journal_encoded, GuestInput};

pub fn main() {
    // Read the folded edges + governance params (private witness supplied by the prover).
    let input: GuestInput = sp1_zkvm::io::read();

    // Canonical, deterministic, float-free computation.
    let result = compute(&input);

    // Commit the journal tuple as public values (preimage of the journal digest).
    let public_values = journal_encoded(&result.journal);
    sp1_zkvm::io::commit_slice(&public_values);
}
