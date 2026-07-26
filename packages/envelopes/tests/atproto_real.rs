//! Envelope-1 integration tests against REAL fixtures (test/fixtures/atproto/{repos,hypercerts}):
//! full pipeline — CAR content-addressing, commit decode + signature, PLC chain (incl. the
//! genesis-hash == DID check, which pins the JSON→dag-cbor conversion), MST range walks —
//! plus fail-closed tamper cases.

use alloy_primitives::B256;
use envelopes::atproto::{self, plc::PlcOpWitness, AtprotoWitness};
use ipld_core::ipld::Ipld;
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::path::PathBuf;

fn fixture(rel: &str) -> PathBuf {
    // packages/envelopes -> repo root
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..").join(rel)
}

/// JSON → Ipld for PLC ops (strings/lists/maps/null only — sig is base64 text, prev is a
/// CID *string*). This is the same conversion the host witness assembly performs; its
/// correctness is pinned by the genesis-hash == DID check inside verify_chain.
fn json_to_ipld(v: &serde_json::Value) -> Ipld {
    match v {
        serde_json::Value::Null => Ipld::Null,
        serde_json::Value::Bool(b) => Ipld::Bool(*b),
        serde_json::Value::Number(n) => Ipld::Integer(n.as_i64().unwrap() as i128),
        serde_json::Value::String(s) => Ipld::String(s.clone()),
        serde_json::Value::Array(a) => Ipld::List(a.iter().map(json_to_ipld).collect()),
        serde_json::Value::Object(o) => {
            let mut m = BTreeMap::new();
            for (k, val) in o {
                m.insert(k.clone(), json_to_ipld(val));
            }
            Ipld::Map(m)
        }
    }
}

fn load_witness(car_rel: &str, plc_rel: &str) -> (String, B256, AtprotoWitness) {
    let car = std::fs::read(fixture(car_rel)).expect("car fixture");
    let plc_json: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(fixture(plc_rel)).expect("plc fixture"))
            .expect("plc json");

    let mut did = String::new();
    let mut plc_ops = Vec::new();
    for entry in plc_json.as_array().expect("audit log array") {
        did = entry["did"].as_str().expect("did").to_string();
        let op_ipld = json_to_ipld(&entry["operation"]);
        let op_bytes = serde_ipld_dagcbor::to_vec(&op_ipld).expect("op to dag-cbor");
        // createdAt is RFC3339; second-resolution unix time is enough for the window rules.
        let created_at = {
            let s = entry["createdAt"].as_str().unwrap_or("1970-01-01T00:00:00Z");
            // crude parse: year only matters for ordering in these fixtures
            let y: u64 = s[..4].parse().unwrap_or(1970);
            (y - 1970) * 31_536_000
        };
        plc_ops.push(PlcOpWitness {
            op_bytes,
            created_at,
            nullified: entry["nullified"].as_bool().unwrap_or(false),
        });
    }

    // The anchored head = sha256 of the commit block (= CAR root block).
    let parsed = envelopes::atproto::carset::Car::parse(&car).expect("car parse");
    let root = parsed.roots[0];
    let commit_bytes = parsed.get(&root).expect("root block");
    let head = B256::from(<[u8; 32]>::from(Sha256::digest(commit_bytes)));

    (did.clone(), head, AtprotoWitness { did, car, plc_ops })
}

#[test]
fn real_bluesky_repo_full_pipeline() {
    let (did, head, w) = load_witness(
        "test/fixtures/atproto/repos/atproto.car",
        "test/fixtures/atproto/repos/atproto.plc.json",
    );
    let node_id = atproto::did_node_id(&did);
    let records = atproto::verify(node_id, head, 2_000_000_000, &["app.bsky.graph.follow"], &w)
        .expect("envelope 1 verify");
    // Spike ground truth: 21 follows in this repo.
    assert_eq!(records.len(), 21, "follow record count");
    for r in &records {
        assert!(r.key.starts_with(b"app.bsky.graph.follow/"));
        assert!(!r.record_bytes.is_empty());
    }
}

#[test]
fn legacy_create_genesis_chain_verifies() {
    // jay.bsky.team's log starts with a legacy "create" op and has later rotations.
    let (did, head, w) = load_witness(
        "test/fixtures/atproto/repos/jay.car",
        "test/fixtures/atproto/repos/jay.plc.json",
    );
    let records = atproto::verify(
        atproto::did_node_id(&did),
        head,
        2_000_000_000,
        &["app.bsky.actor.profile"],
        &w,
    )
    .expect("envelope 1 verify (legacy genesis)");
    assert!(!records.is_empty());
}

#[test]
fn hypercerts_seeded_repo_verifies_all_collections() {
    let (did, head, w) = load_witness(
        "test/fixtures/atproto/hypercerts/fixtures/hypercerts.car",
        "test/fixtures/atproto/hypercerts/fixtures/hypercerts.plc.json",
    );
    let collections = [
        "app.certified.graph.follow",
        "app.certified.badge.award",
        "app.certified.badge.response",
        "org.hypercerts.context.evaluation",
        "org.hypercerts.claim.activity",
        "org.hypercerts.context.acknowledgement",
        "app.certified.link.evm",
    ];
    let records =
        atproto::verify(atproto::did_node_id(&did), head, 2_000_000_000, &collections, &w)
            .expect("hypercerts fixture verify");
    // Alice's two-sided repo (GOAL M4): follow, badge.award, activity, TWO evaluations
    // (cross-repo + self), link.evm. badge.response + acknowledgement now live in bob.car.
    assert_eq!(records.len(), 6, "alice's §2 records");
}

#[test]
fn tampered_block_fails_closed() {
    let (did, head, mut w) = load_witness(
        "test/fixtures/atproto/repos/atproto.car",
        "test/fixtures/atproto/repos/atproto.plc.json",
    );
    // Flip one byte deep in the CAR body (past the header + root block region).
    let mid = w.car.len() / 2;
    w.car[mid] ^= 0x01;
    let r = atproto::verify(
        atproto::did_node_id(&did),
        head,
        2_000_000_000,
        &["app.bsky.graph.follow"],
        &w,
    );
    assert!(r.is_err(), "tampered CAR must fail closed");
}

#[test]
fn wrong_head_rejected() {
    let (did, _head, w) = load_witness(
        "test/fixtures/atproto/repos/atproto.car",
        "test/fixtures/atproto/repos/atproto.plc.json",
    );
    let r = atproto::verify(
        atproto::did_node_id(&did),
        B256::from([0x99; 32]),
        2_000_000_000,
        &["app.bsky.graph.follow"],
        &w,
    );
    assert_eq!(r, Err(envelopes::EnvelopeError::HeadMismatch));
}

#[test]
fn foreign_did_rejected() {
    let (_did, head, w) = load_witness(
        "test/fixtures/atproto/repos/atproto.car",
        "test/fixtures/atproto/repos/atproto.plc.json",
    );
    let r = atproto::verify(
        atproto::did_node_id("did:plc:someoneelse000000000000"),
        head,
        2_000_000_000,
        &["app.bsky.graph.follow"],
        &w,
    );
    assert_eq!(r, Err(envelopes::EnvelopeError::Malformed));
}
