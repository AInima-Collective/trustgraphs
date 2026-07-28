//! Two-sided (multi-repo) pipeline over the REAL seeded-PDS fixture (GOAL M4 exit).
//!
//! Loads BOTH alice.car (`hypercerts.car`) and bob.car with an anchor + envelope-1 witness
//! each, and asserts the cross-repo semantics that a single repo can't reach:
//!   - bob's ACCEPTED badge.response (in HIS repo) boosts alice→bob's badge edge;
//!   - bob's ACKNOWLEDGEMENT (in HIS repo) boosts his E4 share from alice's activity vs
//!     carol's unacked share;
//!   - alice's evaluation of BOB's activity produces a clean cross-repo E3 edge into bob's
//!     artifact;
//!   - alice's self-evaluation of her OWN activity stays inert (SELF_EDGE);
//!   - both repos' actor nodes score; the journal is deterministic.
//!
//! The counterparty facts live in the COUNTERPARTY's own signed repo — which is exactly the
//! two-sided rule (§3/§5): an ack/response counts only because it appears in the walked repo
//! of the DID that authored it.

use alloy_primitives::{B256, U256};
use envelopes::atproto::{self, carset::Car, plc::PlcOpWitness, AtprotoWitness};
use hypercerts_core::compute::{compute, GuestInput, Params, COLLECTIONS, ENVELOPE_ATPROTO};
use hypercerts_core::semantics::{self, artifact_node_id, did_node_id, skip_reason, RepoRecords};
use ipld_core::ipld::Ipld;
use pagerank_core::AnchorRecord;
use sha2::Digest;
use std::collections::BTreeMap;

// The three DIDs of the regenerated two-sided fixture (test/fixtures/atproto/hypercerts/fixtures/meta.json).
const ALICE: &str = "did:plc:ss2ib2f37vegrihrkrfkrw55";
const BOB: &str = "did:plc:uz24xnaizz6bbw6lvrtvebja";
const CAROL: &str = "did:plc:carol0000000000000000000";
const ALICE_ACTIVITY_RKEY: &str = "reforestation-amazon-2024";
const BOB_ACTIVITY_RKEY: &str = "bob-mangrove-2024";
const ACTIVITY: &str = "org.hypercerts.claim.activity";

fn s() -> U256 {
    U256::from(1_000_000_000_000_000_000u64)
}
fn fp(n: u64, d: u64) -> U256 {
    s() * U256::from(n) / U256::from(d)
}

fn params() -> Params {
    Params {
        damping_fp: fp(85, 100),
        tolerance_fp: s() / U256::from(1_000_000u64),
        max_iterations: 100,
        trust_multiplier_fp: U256::from(2) * s(),
        trust_share_fp: fp(15, 100),
        trust_decay_fp: fp(80, 100),
        precision_scale: s(),
        total_pool: U256::from(1_000_000_000_000_000_000_000_000u128),
        trusted_seed_dids: vec![ALICE.to_string()],
        w_follow_fp: fp(2, 10),
        w_badge_fp: fp(5, 10),
        w_eval_fp: s(),
        w_attrib_fp: fp(8, 10),
        ack_boost_fp: U256::from(2) * s(),
        unacked_attrib_fp: fp(5, 10),
        pds_attested_weight_fp: fp(5, 10),
        lane2_max_head_age: 1_000_000,
    }
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

/// Load one repo's (did, head, witness) from a CAR + PLC audit log, mirroring the host's
/// witness assembly (same shape as compute_fixture.rs / atproto_real.rs).
fn load(did: &str, car_rel: &str, plc_rel: &str) -> (B256, AtprotoWitness) {
    let root = concat!(env!("CARGO_MANIFEST_DIR"), "/../..");
    let car = std::fs::read(format!("{root}/test/fixtures/atproto/hypercerts/fixtures/{car_rel}"))
        .unwrap();
    let plc_json: serde_json::Value = serde_json::from_str(
        &std::fs::read_to_string(format!(
            "{root}/test/fixtures/atproto/hypercerts/fixtures/{plc_rel}"
        ))
        .unwrap(),
    )
    .unwrap();
    let mut plc_ops = Vec::new();
    for entry in plc_json.as_array().unwrap() {
        plc_ops.push(PlcOpWitness {
            op_bytes: serde_ipld_dagcbor::to_vec(&json_to_ipld(&entry["operation"])).unwrap(),
            created_at: 0,
            nullified: entry["nullified"].as_bool().unwrap_or(false),
        });
    }
    let parsed = Car::parse(&car).unwrap();
    let commit = parsed.get(&parsed.roots[0]).unwrap();
    let head = B256::from(<[u8; 32]>::from(sha2::Sha256::digest(commit)));
    (head, AtprotoWitness { did: did.to_string(), car, plc_ops })
}

/// A two-anchor GuestInput over both repos (alice fold index 0, bob fold index 1).
fn two_repo_input() -> GuestInput {
    let (alice_head, alice_w) = load(ALICE, "hypercerts.car", "hypercerts.plc.json");
    let (bob_head, bob_w) = load(BOB, "bob.car", "bob.plc.json");
    GuestInput {
        params: params(),
        anchors: vec![
            AnchorRecord {
                node_id: did_node_id(ALICE),
                envelope_kind: ENVELOPE_ATPROTO,
                head: alice_head,
                data_commitment: B256::ZERO,
                block_timestamp: 1_000,
            },
            AnchorRecord {
                node_id: did_node_id(BOB),
                envelope_kind: ENVELOPE_ATPROTO,
                head: bob_head,
                data_commitment: B256::ZERO,
                block_timestamp: 1_000,
            },
        ],
        witnesses: vec![alice_w, bob_w],
        strongref_targets: BTreeMap::new(),
        binding: Default::default(),
    }
}

/// Verify a witness through envelope 1 and pack it into a `RepoRecords` (the same records
/// the guest's compute step derives over), so edge-level facts can be inspected directly.
fn repo_records(did: &str, head: B256, w: &AtprotoWitness, fold_idx: u64) -> RepoRecords {
    let cols: Vec<&str> = COLLECTIONS.to_vec();
    let recs = atproto::verify(did_node_id(did), head, 2_000_000_000, &cols, w).expect("verify");
    RepoRecords {
        did: did.to_string(),
        anchor_fold_index: fold_idx,
        records: recs
            .into_iter()
            .map(|r| (String::from_utf8_lossy(&r.key).into_owned(), r.record_bytes))
            .collect(),
    }
}

/// Derive the graph over both repos (edge-level view), plus alice-only (single-sided view).
fn derived() -> (semantics::DerivedGraph, semantics::DerivedGraph) {
    let (alice_head, alice_w) = load(ALICE, "hypercerts.car", "hypercerts.plc.json");
    let (bob_head, bob_w) = load(BOB, "bob.car", "bob.plc.json");
    let alice_repo = repo_records(ALICE, alice_head, &alice_w, 0);
    let bob_repo = repo_records(BOB, bob_head, &bob_w, 1);
    let ep = params().edge_params();
    let both = semantics::derive(&[alice_repo.clone(), bob_repo], &BTreeMap::new(), &ep);
    let alice_only = semantics::derive(&[alice_repo], &BTreeMap::new(), &ep);
    (both, alice_only)
}

#[test]
fn accepted_response_boosts_alice_bob_badge_edge() {
    let (both, alice_only) = derived();
    let a = did_node_id(ALICE);
    let b = did_node_id(BOB);

    // alice→bob is the SUM of two edge types: follow + badge (§3.3 types sum into the edge).
    //   follow: 1.0 × wFollow(0.2) × auth(alice bound = 1.0) = 0.2 (same both ways).
    //   badge two-sided: bob's accepted response (0.85, in HIS repo) × wBadge(0.5) ×
    //                    ackBoost(2.0) × auth(1.0) = 0.85  → edge 0.2 + 0.85 = 1.05.
    let two_sided = both.outgoing[&a][&b];
    assert_eq!(two_sided, fp(105, 100), "accepted response weight+boost applied (+ follow)");

    // Single-sided (bob's repo withheld): badge base 1.0, no boost → 1.0 × 0.5 = 0.5;
    //   edge 0.2 + 0.5 = 0.7. The 0.35 delta is exactly the counterparty accept boost.
    let one_sided = alice_only.outgoing[&a][&b];
    assert_eq!(one_sided, fp(7, 10));
    assert!(two_sided > one_sided, "the counterparty accept must strictly boost the edge");
    assert_eq!(two_sided - one_sided, fp(35, 100), "boost delta = 0.85 (boosted) − 0.5 (base)");
}

#[test]
fn ack_boosts_bobs_e4_share_over_carols() {
    let (both, _) = derived();
    let art = artifact_node_id(ALICE, ACTIVITY, ALICE_ACTIVITY_RKEY);
    let wb = both.outgoing[&art][&did_node_id(BOB)];
    let wc = both.outgoing[&art][&did_node_id(CAROL)];

    // bob: share 0.6 × wAttrib(0.8) × ackBoost(2.0) × auth(alice bound 1.0) = 0.96 (acked).
    assert_eq!(wb, fp(96, 100), "bob's acked E4 share");
    // carol: share 0.4 × wAttrib(0.8) × unacked(0.5) × auth(1.0) = 0.16 (no repo, no ack).
    assert_eq!(wc, fp(16, 100), "carol's unacked E4 share");
    // 1.5× (share) × 4× (gate) = 6× — the two-sided ack is the difference.
    assert_eq!(wb, wc * U256::from(6));
}

#[test]
fn alice_eval_of_bobs_activity_is_a_cross_repo_e3() {
    let (both, _) = derived();
    let a = did_node_id(ALICE);
    let bob_art = artifact_node_id(BOB, ACTIVITY, BOB_ACTIVITY_RKEY);
    // alice → bob's artifact: (87.5-0)/(100-0)=0.875 × wEval(1.0) × auth(1.0) = 0.875.
    assert_eq!(both.outgoing[&a][&bob_art], fp(875, 1000), "cross-repo E3 into bob's artifact");
}

#[test]
fn alice_self_evaluation_stays_inert() {
    let (both, _) = derived();
    let a = did_node_id(ALICE);
    let alice_art = artifact_node_id(ALICE, ACTIVITY, ALICE_ACTIVITY_RKEY);
    // No alice → own-activity evaluation edge.
    assert!(
        both.outgoing.get(&a).map_or(true, |o| !o.contains_key(&alice_art)),
        "alice's self-evaluation must NOT mint an edge into her own artifact"
    );
    // …but it IS recorded as a SELF_EDGE skip.
    assert!(both.skips.iter().any(|sk| sk.reason == skip_reason::SELF_EDGE));
}

#[test]
fn both_repos_nodes_score_and_journal_is_deterministic() {
    let input = two_repo_input();
    let r = compute(&input);

    // Two anchors folded; lane-2-only journal shape.
    assert_eq!(r.journal.anchor_count, 2);
    assert_eq!(r.journal.acc, B256::ZERO);
    assert_eq!(r.journal.leaf_count, 0);
    assert_ne!(r.journal.output_root, B256::ZERO);
    assert_ne!(r.journal.skipped_digest, B256::ZERO, "self-edge is committed");

    // Alice's REAL link.evm binding verified in-guest (bound actor).
    let a = did_node_id(ALICE);
    assert_eq!(
        r.bindings.get(&a).map(|x| format!("{x:#x}")),
        Some("0xd030e52949a1d6bc7d00a2040268410ee3afd65a".to_string())
    );

    // Both actors score (alice: seed + E4 in-edge from bob's activity; bob: follow/badge/E4).
    assert!(r.scores.iter().any(|(id, v)| *id == a && !v.is_zero()), "alice scored");
    assert!(r.scores.iter().any(|(id, v)| *id == did_node_id(BOB) && !v.is_zero()), "bob scored");

    // Deterministic: recompute reproduces the journal + blob byte-for-byte.
    let r2 = compute(&input);
    assert_eq!(r.journal, r2.journal);
    assert_eq!(r.blob, r2.blob);
}
