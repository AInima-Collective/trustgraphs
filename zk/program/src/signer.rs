//! SP1 guest: prove `signerJournal == compute_signers(pinned edges, pinned params, pinned selection)`.
//!
//! The signer-sync analogue of `main.rs`: the guest reads the full `SignerInput`, runs the canonical
//! `pagerank-core` selection pipeline (same PageRank as the root producer, then top-N selection), and
//! commits the ABI-encoded signer journal tuple as `publicValues`. The on-chain `SignerSyncZkModule`
//! binds `keccak256(publicValues)` to the checkpoint's `acc/leafCount`, the stored `paramsHash` and
//! `selectionParamsHash`, and the submitted `signerSetRoot/targetThreshold`.

#![no_main]
sp1_zkvm::entrypoint!(main);

use pagerank_core::{encode::signer_journal_encoded, signer::compute_signers, SignerInput};

pub fn main() {
    // Read the folded edges + governance params + selection params (private witness).
    let input: SignerInput = sp1_zkvm::io::read();

    // Canonical, deterministic, float-free selection.
    let result = compute_signers(&input);

    // Commit the signer journal tuple as public values (preimage of the signer journal digest).
    let public_values = signer_journal_encoded(&result.journal);
    sp1_zkvm::io::commit_slice(&public_values);
}
