//! SP1 guest: prove `journal == hypercerts_core::compute(anchored repos, pinned params)`.
//!
//! The lane-2-only analogue of `main.rs`. The guest reads the full hypercerts `GuestInput`
//! (anchor log + envelope-1 witnesses + params), re-folds the anchor log, verifies each
//! envelope-1 head in-circuit, derives the §3 edge graph, runs the canonical `pagerank-core`
//! Trust-Aware PageRank, and commits the ABI-encoded journal-v2 tuple as `publicValues`. The
//! journal is the shared `pagerank_core::Journal`, so the same `SP1JournalVerifier` /
//! `MerkleSnapshot` bind it exactly as for the trust-graph program. All semantics live in
//! `hypercerts-core`.

#![no_main]
sp1_zkvm::entrypoint!(main);

use hypercerts_core::compute::{compute, GuestInput};
use pagerank_core::encode::journal_encoded;

pub fn main() {
    // Read the anchor log + envelope-1 witnesses + governance params (private witness).
    let input: GuestInput = sp1_zkvm::io::read();

    // Canonical, deterministic, float-free computation (lane-2-only journal v2).
    let result = compute(&input);

    // Commit the journal tuple as public values (preimage of the journal digest).
    let public_values = journal_encoded(&result.journal);
    sp1_zkvm::io::commit_slice(&public_values);
}
