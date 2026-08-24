//! SP1 guest: prove `journal == contributions_core::compute(trust edges, records, pinned params)`.
//!
//! The contributions program's analogue of `main.rs`/`hypercerts.rs`. The guest reads the full
//! contributions `GuestInput` (trust edges in TRUST-accumulator fold order, contribution records
//! in CONTRIBUTION-accumulator fold order, and the 21-word round params), re-folds both chain
//! commitments (journal slot A = trust, slot B = contributions), runs stage-1 reputation via the
//! canonical `pagerank-core` Trust-Aware PageRank, applies the stage-2 rep-weighted budgeted
//! valuation + carve-out, and commits the ABI-encoded journal-v2 tuple as `publicValues`. The
//! journal is the shared `pagerank_core::Journal`, so the same `SP1JournalVerifier` /
//! `MerkleSnapshot` bind it exactly as for every other program. All semantics live in
//! `contributions-core` (research/operations/contributions/interfaces.md).

#![no_main]
sp1_zkvm::entrypoint!(main);

use contributions_core::compute::{compute, GuestInput};
use pagerank_core::encode::journal_encoded;

pub fn main() {
    // Read the trust edges + contribution records + governance params (private witness).
    let input: GuestInput = sp1_zkvm::io::read();

    // Canonical, deterministic, float-free computation (journal v2, two-accumulator).
    let result = compute(&input);

    // Commit the journal tuple as public values (preimage of the journal digest).
    let public_values = journal_encoded(&result.journal);
    sp1_zkvm::io::commit_slice(&public_values);
}
