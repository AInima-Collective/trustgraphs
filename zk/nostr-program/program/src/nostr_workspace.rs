//! Production `nostr-workspace` guest. All consensus semantics live in
//! `nostr-workspace-core`; this binary only reads the private witness and commits journal v3.
#![no_main]
sp1_zkvm::entrypoint!(main);

use nostr_workspace_core::{compute, GuestInput};
use pagerank_core::encode::journal_encoded;

pub fn main() {
    let input: GuestInput = sp1_zkvm::io::read();
    let result = compute(&input).expect("nostr-workspace computation failed");
    sp1_zkvm::io::commit_slice(&journal_encoded(&result.journal));
}
