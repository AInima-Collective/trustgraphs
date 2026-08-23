//! AUDIT PoC (pre-testnet review, agent 2 — cross-language encoding parity).
//!
//! Two jobs:
//!  1. Independently emit the boundary encodings promoted into the canonical trust-graph golden
//!     vector, so the Solidity PoC and TypeScript port can still compare them byte-for-byte.
//!  2. Demonstrate the untagged mixed-leaf output tree used by the hypercerts and
//!     nostr-workspace programs: `node_output_leaf(id, v)` and `merkle::output_leaf(a, v)`
//!     are the SAME function of a 32-byte key, so a nodeId whose top 12 bytes are zero IS
//!     an address leaf. Nothing in the encoding separates the two families.
//!
//! Run: cargo test -p pagerank-core --test audit_poc_encoding -- --nocapture

use alloy_primitives::{Address, B256, U256};
use envelopes::eas_offchain::head_payload;
use pagerank_core::{encode, Params};
use zk_core::anchor::{anchor_leaf, skip_leaf, skipped_digest, SkipEntry};

fn s() -> U256 {
    U256::from(1_000_000_000_000_000_000u64)
}

/// Params identical to the canonical trust-graph golden fixture, including all non-default
/// lane-2 fields.
fn boundary_params() -> Params {
    Params {
        damping_fp: s() * U256::from(85) / U256::from(100),
        tolerance_fp: s() / U256::from(1_000_000u64),
        max_iterations: 100,
        min_weight_fp: s() / U256::from(4),
        max_weight_fp: s() * U256::from(100),
        trust_share_fp: s(),
        trust_decay_fp: s() * U256::from(80) / U256::from(100),
        trusted_seeds: vec![Address::from([0x01; 20]), Address::from([0x03; 20])],
        total_pool: U256::from(10).pow(U256::from(24)),
        precision_scale: s(),
        schema_uid: B256::from([0xAB; 32]),
        weight_field_index: 1,
        envelope0_domain_separators: vec![B256::from([0xD1; 32]), B256::from([0xD2; 32])],
        lane2_max_head_age: 86_400,
        accumulator: Address::from([0xAC; 20]),
        chain_id: 31337,
    }
}

#[test]
fn emit_boundary_encoding_vectors() {
    let p = boundary_params();

    // (a) the non-empty `domainSetHash` branch.
    let mut d = Vec::new();
    for sep in &p.envelope0_domain_separators {
        d.extend_from_slice(sep.as_slice());
    }
    let domain_set_hash = alloy_primitives::keccak256(&d);

    // (b) full paramsHash with min_weight_fp / separators / lane2MaxHeadAge all non-default.
    let params_hash = encode::params_hash(&p);

    // (c) typed anchor struct and unchanged leaf with envelopeKind = 1.
    let anchor_struct_hash =
        head_payload(B256::from([0x11; 32]), 1, B256::from([0x22; 32]), 5, B256::from([0x33; 32]));
    let anchor = anchor_leaf(
        B256::from([0x11; 32]),
        1,
        B256::from([0x22; 32]),
        5,
        B256::from([0x33; 32]),
        1234,
    );

    // (d) a multi-entry skippedDigest.
    let e0 = SkipEntry { node_id: B256::from([0x44; 32]), reason: 1, epoch_observed: 7 };
    let e1 = SkipEntry { node_id: B256::from([0x55; 32]), reason: 2, epoch_observed: 9 };
    let skipped = skipped_digest(&[e0, e1]);

    let json = format!(
        concat!(
            "{{\n",
            "  \"domainSetHash\": \"{:#x}\",\n",
            "  \"paramsHash\": \"{:#x}\",\n",
            "  \"seedSetRoot\": \"{:#x}\",\n",
            "  \"anchorStructHashKind1\": \"{:#x}\",\n",
            "  \"anchorLeafKind1\": \"{:#x}\",\n",
            "  \"skipLeaf0\": \"{:#x}\",\n",
            "  \"skipLeaf1\": \"{:#x}\",\n",
            "  \"skippedDigest2\": \"{:#x}\"\n",
            "}}\n"
        ),
        domain_set_hash,
        params_hash,
        {
            let mut seeds = p.trusted_seeds.clone();
            seeds.sort();
            zk_core::merkle::seed_set_root(&seeds)
        },
        anchor_struct_hash,
        anchor,
        skip_leaf(&e0),
        skip_leaf(&e1),
        skipped,
    );
    // Printing is the contract; the Solidity side pins these values as literals.
    // Writing the tracked artifact is opt-in, because an unconditional write makes
    // every concurrent `cargo test -p pagerank-core` dirty the working tree.
    if std::env::var_os("AUDIT_WRITE_VECTORS").is_some() {
        let out = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../contracts/test/audit-poc/audit-vectors.json"
        );
        std::fs::write(out, &json).expect("write audit vectors");
    }
    println!("{json}");
}
