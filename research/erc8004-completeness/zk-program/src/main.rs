//! Detached issue-60 cycle benchmark. It cannot rotate a shipped program vkey.

#![no_main]
sp1_zkvm::entrypoint!(main);

use erc8004_completeness_research::{replay, CanonicalEvent};

pub fn main() {
    let events: Vec<CanonicalEvent> = sp1_zkvm::io::read();
    let (head, preimage_head) = replay(&events);
    sp1_zkvm::io::commit_slice(head.as_slice());
    sp1_zkvm::io::commit_slice(preimage_head.as_slice());
}
