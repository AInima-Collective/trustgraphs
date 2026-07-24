//! Emit the TWO-REPO fixture `GuestInput` as JSON for the e2e harness (test/e2e/run.sh):
//! both seeded repos (alice + bob) as anchored envelope-1 witnesses. The anchor records'
//! heads/timestamps here are placeholders — the harness REPLACES the anchors with the ones
//! reconstructed from the chain (HeadAnchored events) so the guest re-fold matches the
//! checkpointed anchorAcc; only the witnesses/params matter from this file.
//!
//! Run: cargo run -p hypercerts-core --example emit_fixture_input [--] [out.json]

use alloy_primitives::{B256, U256};
use envelopes::atproto::{carset::Car, plc::PlcOpWitness, AtprotoWitness};
use hypercerts_core::compute::{GuestInput, Params, ENVELOPE_ATPROTO};
use hypercerts_core::semantics::did_node_id;
use ipld_core::ipld::Ipld;
use sha2::Digest;
use std::collections::BTreeMap;

fn s() -> U256 {
    U256::from(1_000_000_000_000_000_000u64)
}
fn fp(n: u64, d: u64) -> U256 {
    s() * U256::from(n) / U256::from(d)
}

fn json_to_ipld(v: &serde_json::Value) -> Ipld {
    match v {
        serde_json::Value::Null => Ipld::Null,
        serde_json::Value::Bool(b) => Ipld::Bool(*b),
        serde_json::Value::Number(n) => Ipld::Integer(n.as_i64().unwrap() as i128),
        serde_json::Value::String(x) => Ipld::String(x.clone()),
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

fn load_repo(root: &str, car_name: &str, plc_name: &str) -> (String, B256, AtprotoWitness) {
    let car =
        std::fs::read(format!("{root}/test/fixtures/atproto/hypercerts/fixtures/{car_name}")).unwrap();
    let plc_json: serde_json::Value = serde_json::from_str(
        &std::fs::read_to_string(format!("{root}/test/fixtures/atproto/hypercerts/fixtures/{plc_name}"))
            .unwrap(),
    )
    .unwrap();
    let mut did = String::new();
    let mut plc_ops = Vec::new();
    for entry in plc_json.as_array().unwrap() {
        did = entry["did"].as_str().unwrap().to_string();
        plc_ops.push(PlcOpWitness {
            op_bytes: serde_ipld_dagcbor::to_vec(&json_to_ipld(&entry["operation"])).unwrap(),
            created_at: 0,
            nullified: entry["nullified"].as_bool().unwrap_or(false),
        });
    }
    let parsed = Car::parse(&car).unwrap();
    let commit = parsed.get(&parsed.roots[0]).unwrap();
    let head = B256::from(<[u8; 32]>::from(sha2::Sha256::digest(commit)));
    (did.clone(), head, AtprotoWitness { did, car, plc_ops })
}

fn main() {
    let root = concat!(env!("CARGO_MANIFEST_DIR"), "/../..");
    let (alice, alice_head, wa) = load_repo(root, "hypercerts.car", "hypercerts.plc.json");
    let (_bob, bob_head, wb) = load_repo(root, "bob.car", "bob.plc.json");

    let params = Params {
        damping_fp: fp(85, 100),
        tolerance_fp: s() / U256::from(1_000_000u64),
        max_iterations: 100,
        trust_multiplier_fp: U256::from(2) * s(),
        trust_share_fp: fp(15, 100),
        trust_decay_fp: fp(80, 100),
        precision_scale: s(),
        total_pool: U256::from(1_000_000_000_000_000_000_000_000u128),
        trusted_seed_dids: vec![alice.clone()],
        w_follow_fp: fp(2, 10),
        w_badge_fp: fp(5, 10),
        w_eval_fp: s(),
        w_attrib_fp: fp(8, 10),
        ack_boost_fp: U256::from(2) * s(),
        unacked_attrib_fp: fp(5, 10),
        pds_attested_weight_fp: fp(5, 10),
        lane2_max_head_age: 1_000_000_000,
    };

    let input = GuestInput {
        params,
        anchors: vec![
            pagerank_core::AnchorRecord {
                node_id: did_node_id(&wa.did),
                envelope_kind: ENVELOPE_ATPROTO,
                head: alice_head,
                data_commitment: B256::ZERO,
                block_timestamp: 1_000,
            },
            pagerank_core::AnchorRecord {
                node_id: did_node_id(&wb.did),
                envelope_kind: ENVELOPE_ATPROTO,
                head: bob_head,
                data_commitment: B256::ZERO,
                block_timestamp: 1_001,
            },
        ],
        witnesses: vec![wa, wb],
        strongref_targets: BTreeMap::new(),
    };

    let out = std::env::args().nth(1).unwrap_or_else(|| "hypercerts_input.json".to_string());
    std::fs::write(&out, serde_json::to_string(&input).unwrap()).unwrap();
    // Print what the harness needs to register/anchor on-chain.
    eprintln!("wrote {out}");
    for (w, h) in [(&input.witnesses[0], alice_head), (&input.witnesses[1], bob_head)] {
        println!(
            "did={} nodeId=0x{} head=0x{}",
            w.did,
            alloy_primitives::hex::encode(did_node_id(&w.did)),
            alloy_primitives::hex::encode(h)
        );
    }
}
