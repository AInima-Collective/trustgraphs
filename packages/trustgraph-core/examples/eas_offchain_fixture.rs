//! Emit the official-SDK envelope-0 corpus as a complete strict guest input.
//!
//! This keeps the checked-in binary payload authoritative while providing a reproducible input for
//! `trustgraph-prover trust-graph execute /dev/stdin` and other SP1 integration checks.

use alloy_primitives::{Address, B256, U256};
use serde_json::Value;
use std::path::PathBuf;
use trustgraph_core::{
    AnchorRecord, Envelope0AnchorAuthorization, Envelope0PayloadWitness, GuestInput, Lane2Witness,
    Params,
};

fn fixture_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../test/fixtures/eas-offchain/v1")
}

fn b256(value: &Value) -> B256 {
    value.as_str().expect("bytes32 string").parse().expect("valid bytes32")
}

fn u64_string(value: &Value) -> u64 {
    value.as_str().expect("decimal string").parse().expect("valid u64")
}

fn signature(value: &Value) -> Vec<u8> {
    alloy_primitives::hex::decode(
        value.as_str().expect("signature string").trim_start_matches("0x"),
    )
    .expect("valid signature")
}

fn main() {
    let fixture_dir = fixture_dir();
    let manifest: Value = serde_json::from_slice(
        &std::fs::read(fixture_dir.join("manifest.json")).expect("read fixture manifest"),
    )
    .expect("parse fixture manifest");
    let history = manifest["positive"]["anchorHistory"].as_array().expect("anchor history");

    let mut anchors = Vec::with_capacity(history.len());
    let mut authorizations = Vec::with_capacity(history.len());
    for (fold_index, record) in history.iter().enumerate() {
        let authorization = &record["authorization"];
        let message = &authorization["message"];
        anchors.push(AnchorRecord {
            node_id: b256(&message["nodeId"]),
            envelope_kind: message["envelopeKind"].as_u64().expect("envelope kind") as u8,
            head: b256(&message["head"]),
            count: u64_string(&message["count"]),
            data_commitment: b256(&message["dataCommitment"]),
            block_timestamp: u64_string(&record["blockTimestamp"]),
        });
        authorizations.push(Envelope0AnchorAuthorization {
            fold_index: fold_index as u64,
            head_signature: signature(&authorization["signature"]),
        });
    }

    let latest = history.last().expect("nonempty anchor history");
    let node_id = anchors.last().expect("latest anchor").node_id;
    let payload =
        std::fs::read(fixture_dir.join(latest["payloadFile"].as_str().expect("payload filename")))
            .expect("read payload");

    let scale = U256::from(10u64).pow(U256::from(18u64));
    let params = Params {
        damping_fp: scale * U256::from(85u64) / U256::from(100u64),
        tolerance_fp: scale / U256::from(1_000_000u64),
        max_iterations: 100,
        min_weight_fp: U256::ZERO,
        max_weight_fp: U256::from(100u64) * scale,
        trust_multiplier_fp: U256::from(2u64) * scale,
        trust_share_fp: U256::ZERO,
        trust_decay_fp: U256::ZERO,
        trusted_seeds: Vec::new(),
        total_pool: U256::from(1_000_000_000_000_000_000_000_000u128),
        precision_scale: scale,
        schema_uid: b256(&manifest["schemaUid"]),
        weight_field_index: 1,
        envelope0_domain_separators: vec![
            b256(&manifest["easDomain"]["separator"]),
            b256(&manifest["headDomain"]["separator"]),
        ],
        lane2_max_head_age: 0,
        accumulator: Address::ZERO,
        chain_id: u64_string(&manifest["headDomain"]["chainId"]),
    };

    let input = GuestInput {
        edges: Vec::new(),
        params,
        lane2: Some(Lane2Witness {
            anchors,
            authorizations,
            payloads: vec![Envelope0PayloadWitness { node_id, payload }],
        }),
        binding: Default::default(),
    };
    println!("{}", serde_json::to_string(&input).expect("serialize guest input"));
}
