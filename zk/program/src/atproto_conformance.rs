//! SP1 guest: envelope-1 (atproto) conformance — prove that a repo head's complete record
//! set was verified in-circuit (M3 exit: "the guest proves a real Bluesky repo and a seeded
//! Hypercerts repo end-to-end").
//!
//! Reads `(node_id, head, now, collections, AtprotoWitness)`, runs the full envelope-1
//! pipeline (CAR content-addressing, commit signature via the PLC-verified key, MST
//! multi-range walks, fail-closed), and commits
//! `abi.encode(bytes32 nodeId, bytes32 head, uint64 recordCount, bytes32 recordsDigest)`
//! where `recordsDigest` folds `keccak(key ‖ record_bytes)` per record in walk order.
//! A verification failure PANICS — this bin proves success only (rule-Φ handling lives in
//! the production programs).

#![no_main]
sp1_zkvm::entrypoint!(main);

use alloy_primitives::{keccak256, B256};
use envelopes::atproto::{self, AtprotoWitness};
use zk_core::fold::fold;
use zk_core::words::word_u64;

pub fn main() {
    let node_id: B256 = sp1_zkvm::io::read();
    let head: B256 = sp1_zkvm::io::read();
    let now: u64 = sp1_zkvm::io::read();
    let collections: Vec<String> = sp1_zkvm::io::read();
    let witness: AtprotoWitness = sp1_zkvm::io::read();

    let cols: Vec<&str> = collections.iter().map(|s| s.as_str()).collect();
    let records = atproto::verify(node_id, head, now, &cols, &witness)
        .expect("envelope-1 verification failed");

    let mut records_digest = B256::ZERO;
    for r in &records {
        let mut buf = Vec::with_capacity(r.key.len() + r.record_bytes.len());
        buf.extend_from_slice(&r.key);
        buf.extend_from_slice(&r.record_bytes);
        records_digest = fold(records_digest, keccak256(&buf));
    }

    let mut public_values = Vec::with_capacity(32 * 4);
    public_values.extend_from_slice(node_id.as_slice());
    public_values.extend_from_slice(head.as_slice());
    public_values.extend_from_slice(&word_u64(records.len() as u64));
    public_values.extend_from_slice(records_digest.as_slice());
    sp1_zkvm::io::commit_slice(&public_values);
}
