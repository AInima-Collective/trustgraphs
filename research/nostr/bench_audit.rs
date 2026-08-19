//! Buzz audit-prefix hashing benchmark over the exact source-derived preimage fields.
#![no_main]
sp1_zkvm::entrypoint!(main);

#[path = "bench_common.rs"]
mod common;

pub fn main() {
    let cases: Vec<common::AuditCase> = sp1_zkvm::io::read();
    let head = common::verify_audit(&cases);
    sp1_zkvm::io::commit_slice(&head);
}
