//! Emit the hypercerts program's canonical golden-vector family (`test/golden/hypercerts.json`),
//! independently reproduced in Solidity (`test/unit/golden/HypercertsGoldenVectors.t.sol`) and TS
//! (`frontend/lib/hypercerts/golden.test.ts`) so the four-way byte parity stays enforced.
//!
//! Run: `cargo run -p hypercerts-core --example export_golden > test/golden/hypercerts.json`
//!
//! The seed DID is read from the fixture's PLC log (so the vectors track whatever repo the
//! `test/fixtures/atproto/hypercerts` generator currently pins); every hash-formula vector (nodeIds,
//! output leaf, E1–E4 edge weights) is synthetic and fixture-independent.
//!
//! The vector family:
//!   - params      — all 17 §6.1 fields + seedSetRoot + paramsHash (the 17-word tuple)
//!   - nodeIds     — didNodeId for two sample DIDs + one artifactNodeId
//!   - outputLeaf  — one `node_output_leaf(nodeId, value)` sample
//!   - edges       — E1–E4 edge-weight vectors (§6.1 params, exact expected weights)
//!   - journal     — the FULL fixture compute journal (all 10 fields + encoded + digest)
//!   - skipped     — the fixture's skippedDigest preimage (nodeId/reason/epochObserved list),
//!                   independently reconstructed (verify → derive) and self-checked

use alloy_primitives::{hex, keccak256, B256, U256};
use envelopes::atproto::{self, carset::Car, plc::PlcOpWitness, AtprotoWitness};
use hypercerts_core::compute::{
    compute, node_output_leaf, params_hash, GuestInput, Params, COLLECTIONS, ENVELOPE_ATPROTO,
};
use hypercerts_core::semantics::{self, artifact_node_id, did_node_id, EdgeParams, RepoRecords};
use ipld_core::ipld::Ipld;
use pagerank_core::{encode, AnchorRecord};
use serde_json::json;
use sha2::Digest;
use std::collections::BTreeMap;
use zk_core::anchor::{skip_leaf, skipped_digest, SkipEntry};

// Fixed sample DIDs for the fixture-independent hash-formula vectors.
const SAMPLE_A: &str = "did:plc:sampleaaaaaaaaaaaaaaaaaaa";
const SAMPLE_B: &str = "did:plc:samplebbbbbbbbbbbbbbbbbbb";

// Synthetic DIDs for the standalone E1–E4 edge-weight vectors (mirror tests/semantics.rs).
const SA: &str = "did:plc:alice000000000000000000";
const SB: &str = "did:plc:bob00000000000000000000";

fn hx(b: &[u8]) -> String {
    format!("0x{}", hex::encode(b))
}

fn s() -> U256 {
    U256::from(1_000_000_000_000_000_000u64)
}
fn fp(n: u64, d: u64) -> U256 {
    s() * U256::from(n) / U256::from(d)
}

fn params(seed_did: &str) -> Params {
    Params {
        damping_fp: fp(85, 100),
        tolerance_fp: s() / U256::from(1_000_000u64),
        max_iterations: 100,
        trust_multiplier_fp: U256::from(2) * s(),
        trust_share_fp: fp(15, 100),
        trust_decay_fp: fp(80, 100),
        precision_scale: s(),
        total_pool: U256::from(1_000_000_000_000_000_000_000_000u128),
        trusted_seed_dids: vec![seed_did.to_string()],
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

fn edge_params() -> EdgeParams {
    params(SA).edge_params()
}

// ---- fixture load (identical to tests/compute_fixture.rs, seed DID read from the PLC log) -----

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

/// Returns `(input, head, seed_did)` for the seeded fixture. The seed DID is the PLC log's
/// subject (the fixture repo owner), so the vectors track whatever the generator currently pins.
fn fixture_input() -> (GuestInput, B256, String) {
    let root = concat!(env!("CARGO_MANIFEST_DIR"), "/../..");
    let car =
        std::fs::read(format!("{root}/test/fixtures/atproto/hypercerts/fixtures/hypercerts.car")).unwrap();
    let plc_json: serde_json::Value = serde_json::from_str(
        &std::fs::read_to_string(format!(
            "{root}/test/fixtures/atproto/hypercerts/fixtures/hypercerts.plc.json"
        ))
        .unwrap(),
    )
    .unwrap();
    let entries = plc_json.as_array().unwrap();
    let seed_did = entries[0]["did"].as_str().expect("plc entry did").to_string();
    let mut plc_ops = Vec::new();
    for entry in entries {
        plc_ops.push(PlcOpWitness {
            op_bytes: serde_ipld_dagcbor::to_vec(&json_to_ipld(&entry["operation"])).unwrap(),
            created_at: 0,
            nullified: entry["nullified"].as_bool().unwrap_or(false),
        });
    }
    let parsed = Car::parse(&car).unwrap();
    let commit = parsed.get(&parsed.roots[0]).unwrap();
    let head = B256::from(<[u8; 32]>::from(sha2::Sha256::digest(commit)));

    let input = GuestInput {
        params: params(&seed_did),
        anchors: vec![AnchorRecord {
            node_id: did_node_id(&seed_did),
            envelope_kind: ENVELOPE_ATPROTO,
            head,
            data_commitment: B256::ZERO,
            block_timestamp: 1_000,
        }],
        witnesses: vec![AtprotoWitness { did: seed_did.clone(), car, plc_ops }],
        strongref_targets: BTreeMap::new(),
    };
    (input, head, seed_did)
}

/// Independently reconstruct the fixture's derived graph (verify → derive), matching the exact
/// `repos` the guest `compute` folds. The fixture is a single fresh anchor, so rule Φ contributes
/// no skip; the graph's skip list is exactly the record-level skips, canonically sorted. This is
/// the *envelope-verified edge set* the indexer serves to the browser (OFFCHAIN §6 reduced tier):
/// the browser re-derives PageRank + root + journal from it (`frontend/lib/hypercerts/recompute.ts`).
fn reconstruct_graph(input: &GuestInput) -> semantics::DerivedGraph {
    let now = input.anchors.iter().map(|a| a.block_timestamp).max().unwrap_or(0);
    let cols: Vec<&str> = COLLECTIONS.to_vec();
    let mut repos: Vec<RepoRecords> = Vec::new();
    for (fold_idx, a) in input.anchors.iter().enumerate() {
        let Some(w) = input.witnesses.iter().find(|w| did_node_id(&w.did) == a.node_id) else {
            continue;
        };
        if let Ok(records) = atproto::verify(a.node_id, a.head, now, &cols, w) {
            repos.push(RepoRecords {
                did: w.did.clone(),
                anchor_fold_index: fold_idx as u64,
                records: records
                    .into_iter()
                    .map(|r| (String::from_utf8_lossy(&r.key).into_owned(), r.record_bytes))
                    .collect(),
            });
        }
    }
    semantics::derive(&repos, &input.strongref_targets, &input.params.edge_params())
}

/// The fixture's canonical skip set (verify → derive), matching the steps `compute` folds into
/// `skippedDigest`.
fn reconstruct_skips(input: &GuestInput) -> Vec<SkipEntry> {
    let mut skips = reconstruct_graph(input).skips;
    skips.sort();
    skips
}

// ---- synthetic record builders for the E1–E4 edge-weight vectors ----------------------------

fn m(pairs: Vec<(&str, Ipld)>) -> Ipld {
    let mut map = BTreeMap::new();
    for (k, v) in pairs {
        map.insert(k.to_string(), v);
    }
    Ipld::Map(map)
}
fn st(v: &str) -> Ipld {
    Ipld::String(v.to_string())
}
fn enc(v: &Ipld) -> Vec<u8> {
    serde_ipld_dagcbor::to_vec(v).unwrap()
}
fn repo(did: &str, idx: u64, records: Vec<(&str, Vec<u8>)>) -> RepoRecords {
    RepoRecords {
        did: did.to_string(),
        anchor_fold_index: idx,
        records: records.into_iter().map(|(k, b)| (k.to_string(), b)).collect(),
    }
}
fn follow(subject: &str, t: &str) -> Vec<u8> {
    enc(&m(vec![
        ("$type", st("app.certified.graph.follow")),
        ("subject", st(subject)),
        ("createdAt", st(t)),
    ]))
}
fn award(subject_did: &str, badge_cid: &str) -> Vec<u8> {
    enc(&m(vec![
        ("$type", st("app.certified.badge.award")),
        ("createdAt", st("2026-01-01T00:00:00Z")),
        (
            "badge",
            m(vec![("cid", st(badge_cid)), ("uri", st("at://x/app.certified.badge.definition/d"))]),
        ),
        ("subject", m(vec![("did", st(subject_did))])),
    ]))
}
fn response(award_uri: &str, resp: &str, weight: Option<&str>) -> Vec<u8> {
    let mut fields = vec![
        ("$type", st("app.certified.badge.response")),
        ("createdAt", st("2026-01-02T00:00:00Z")),
        ("badgeAward", m(vec![("cid", st("bafyfake")), ("uri", st(award_uri))])),
        ("response", st(resp)),
    ];
    if let Some(w) = weight {
        fields.push(("weight", st(w)));
    }
    enc(&m(fields))
}
fn evaluation(subject_uri: &str, min: &str, max: &str, value: &str) -> Vec<u8> {
    enc(&m(vec![
        ("$type", st("org.hypercerts.context.evaluation")),
        ("createdAt", st("2026-01-02T00:00:00Z")),
        ("subject", m(vec![("cid", st("bafyfake")), ("uri", st(subject_uri))])),
        ("score", m(vec![("min", st(min)), ("max", st(max)), ("value", st(value))])),
        ("evaluators", Ipld::List(vec![])),
    ]))
}
fn activity(contributors: Vec<(&str, &str)>) -> Vec<u8> {
    let list = contributors
        .into_iter()
        .map(|(did, w)| {
            m(vec![
                ("contributorIdentity", m(vec![("identity", st(did))])),
                ("contributionWeight", st(w)),
            ])
        })
        .collect();
    enc(&m(vec![
        ("$type", st("org.hypercerts.claim.activity")),
        ("createdAt", st("2026-01-01T00:00:00Z")),
        ("contributors", Ipld::List(list)),
    ]))
}

/// E1: a satellite follow — `1.0 × wFollow(0.2) × pdsAttested(0.5) = 0.1`.
fn edge_e1() -> serde_json::Value {
    let g = semantics::derive(
        &[repo(SA, 0, vec![("app.certified.graph.follow/1", follow(SB, "t1"))])],
        &BTreeMap::new(),
        &edge_params(),
    );
    let w = g.outgoing[&did_node_id(SA)][&did_node_id(SB)];
    json!({
        "case": "E1 follow (satellite discount)",
        "source": hx(did_node_id(SA).as_slice()),
        "target": hx(did_node_id(SB).as_slice()),
        "weightFp": w.to_string(),
    })
}

/// E2: an accepted badge (weight 0.85, ackBoost) from a satellite —
/// `0.85 × wBadge(0.5) × boost(2.0) × pdsAttested(0.5) = 0.425`.
fn edge_e2() -> serde_json::Value {
    let award_uri = format!("at://{SA}/app.certified.badge.award/aw");
    let g = semantics::derive(
        &[
            repo(SA, 0, vec![("app.certified.badge.award/aw", award(SB, "bafydef"))]),
            repo(
                SB,
                1,
                vec![(
                    "app.certified.badge.response/r",
                    response(&award_uri, "accepted", Some("0.85")),
                )],
            ),
        ],
        &BTreeMap::new(),
        &edge_params(),
    );
    let w = g.outgoing[&did_node_id(SA)][&did_node_id(SB)];
    json!({
        "case": "E2 badge (accepted 0.85, ackBoost, satellite)",
        "source": hx(did_node_id(SA).as_slice()),
        "target": hx(did_node_id(SB).as_slice()),
        "weightFp": w.to_string(),
    })
}

/// E3: an evaluation 87.5/100 from a satellite — `0.875 × wEval(1.0) × pdsAttested(0.5) = 0.4375`.
fn edge_e3() -> serde_json::Value {
    let uri = format!("at://{SB}/org.hypercerts.claim.activity/x");
    let g = semantics::derive(
        &[repo(
            SA,
            0,
            vec![("org.hypercerts.context.evaluation/e", evaluation(&uri, "0", "100", "87.5"))],
        )],
        &BTreeMap::new(),
        &edge_params(),
    );
    let art = artifact_node_id(SB, "org.hypercerts.claim.activity", "x");
    let w = g.outgoing[&did_node_id(SA)][&art];
    json!({
        "case": "E3 evaluation (87.5/100, satellite)",
        "source": hx(did_node_id(SA).as_slice()),
        "target": hx(art.as_slice()),
        "weightFp": w.to_string(),
    })
}

/// E4: an attribution (single contributor, unacked) from a satellite —
/// `share(1.0) × wAttrib(0.8) × unacked(0.5) × pdsAttested(0.5) = 0.2`.
fn edge_e4() -> serde_json::Value {
    let g = semantics::derive(
        &[repo(SA, 0, vec![("org.hypercerts.claim.activity/a", activity(vec![(SB, "1")]))])],
        &BTreeMap::new(),
        &edge_params(),
    );
    let art = artifact_node_id(SA, "org.hypercerts.claim.activity", "a");
    let w = g.outgoing[&art][&did_node_id(SB)];
    json!({
        "case": "E4 attribution (share 1.0, unacked, satellite)",
        "source": hx(art.as_slice()),
        "target": hx(did_node_id(SB).as_slice()),
        "weightFp": w.to_string(),
    })
}

fn main() {
    let (input, _head, seed_did) = fixture_input();
    let p = &input.params;
    let ph = params_hash(p);

    // seedSetRoot: OZ tree over sorted seed nodeIds, leaf = keccak256(nodeId).
    let mut seed_ids: Vec<B256> = p.trusted_seed_dids.iter().map(|d| did_node_id(d)).collect();
    seed_ids.sort();
    let seed_leaves: Vec<B256> = seed_ids.iter().map(|id| keccak256(id.as_slice())).collect();
    let seed_set_root = pagerank_core::merkle::merkle_root(seed_leaves);

    // node_output_leaf sample (fixed nodeId + value; fixture-independent).
    let sample_node = did_node_id(SAMPLE_B);
    let sample_value = U256::from(123_456_789_000_000_000_000u128);
    let sample_leaf = node_output_leaf(sample_node, sample_value);

    // artifactNodeId sample (fixed; fixture-independent).
    let art_did = SAMPLE_A;
    let art_coll = "org.hypercerts.claim.activity";
    let art_rkey = "act1";
    let artifact = artifact_node_id(art_did, art_coll, art_rkey);

    // The full fixture compute journal + the independently reconstructed skip preimage.
    let r = compute(&input);
    let j = &r.journal;
    let skips = reconstruct_skips(&input);

    // The reduced-tier reproduction inputs: the envelope-verified derived edge set + bindings +
    // skips (what the indexer serves the browser) + the chain-state accumulators the journal binds.
    // `frontend/lib/hypercerts/recompute.ts` re-derives rank → distribute → output_root → blob/cid →
    // journal digest from ONLY these keys and must reproduce the journal above byte-for-byte.
    let graph = reconstruct_graph(&input);
    let recompute_edges: Vec<serde_json::Value> = graph
        .outgoing
        .iter()
        .flat_map(|(source, targets)| {
            targets.iter().map(move |(target, w)| {
                json!({
                    "source": hx(source.as_slice()),
                    "target": hx(target.as_slice()),
                    "weightFp": w.to_string(),
                })
            })
        })
        .collect();
    let recompute_bindings: Vec<serde_json::Value> = graph
        .bindings
        .iter()
        .map(|(node_id, addr)| {
            json!({ "nodeId": hx(node_id.as_slice()), "address": hx(addr.as_slice()) })
        })
        .collect();
    let recompute_skips: Vec<serde_json::Value> = skips
        .iter()
        .map(|sk| {
            json!({
                "nodeId": hx(sk.node_id.as_slice()),
                "reason": sk.reason,
                "epochObserved": sk.epoch_observed,
            })
        })
        .collect();
    assert_eq!(
        skipped_digest(&skips),
        j.skipped_digest,
        "reconstructed skip preimage must fold to the journal's skippedDigest"
    );
    let skip_preimage: Vec<serde_json::Value> = skips
        .iter()
        .map(|sk| {
            json!({
                "nodeId": hx(sk.node_id.as_slice()),
                "reason": sk.reason,
                "epochObserved": sk.epoch_observed,
                "skipLeaf": hx(skip_leaf(sk).as_slice()),
            })
        })
        .collect();

    let out = json!({
        "note": "generated from test/fixtures/atproto/hypercerts; seed DID read from the PLC log",
        "seedDid": seed_did,
        "params": {
            "dampingFp": p.damping_fp.to_string(),
            "toleranceFp": p.tolerance_fp.to_string(),
            "maxIterations": p.max_iterations,
            "trustMultiplierFp": p.trust_multiplier_fp.to_string(),
            "trustShareFp": p.trust_share_fp.to_string(),
            "trustDecayFp": p.trust_decay_fp.to_string(),
            "precisionScale": p.precision_scale.to_string(),
            "totalPool": p.total_pool.to_string(),
            "trustedSeedDids": p.trusted_seed_dids,
            "sortedSeedNodeIds": seed_ids.iter().map(|id| hx(id.as_slice())).collect::<Vec<_>>(),
            "seedSetRoot": hx(seed_set_root.as_slice()),
            "wFollowFp": p.w_follow_fp.to_string(),
            "wBadgeFp": p.w_badge_fp.to_string(),
            "wEvalFp": p.w_eval_fp.to_string(),
            "wAttribFp": p.w_attrib_fp.to_string(),
            "ackBoostFp": p.ack_boost_fp.to_string(),
            "unackedAttribFp": p.unacked_attrib_fp.to_string(),
            "pdsAttestedWeightFp": p.pds_attested_weight_fp.to_string(),
            "lane2MaxHeadAge": p.lane2_max_head_age,
            "paramsHash": hx(ph.as_slice())
        },
        "paramsHash": hx(ph.as_slice()),
        "nodeIds": {
            "a": { "did": SAMPLE_A, "didNodeId": hx(did_node_id(SAMPLE_A).as_slice()) },
            "b": { "did": SAMPLE_B, "didNodeId": hx(did_node_id(SAMPLE_B).as_slice()) },
            "artifact": {
                "authorDid": art_did,
                "collection": art_coll,
                "rkey": art_rkey,
                "uri": format!("at://{art_did}/{art_coll}/{art_rkey}"),
                "artifactNodeId": hx(artifact.as_slice())
            }
        },
        "outputLeaf": {
            "nodeId": hx(sample_node.as_slice()),
            "value": sample_value.to_string(),
            "leaf": hx(sample_leaf.as_slice())
        },
        "edges": [edge_e1(), edge_e2(), edge_e3(), edge_e4()],
        "journal": {
            "acc": hx(j.acc.as_slice()),
            "leafCount": j.leaf_count,
            "anchorAcc": hx(j.anchor_acc.as_slice()),
            "anchorCount": j.anchor_count,
            "paramsHash": hx(j.params_hash.as_slice()),
            "outputRoot": hx(j.output_root.as_slice()),
            "ipfsHash": hx(j.ipfs_hash.as_slice()),
            "cidDigest": hx(j.cid_digest.as_slice()),
            "totalValue": j.total_value.to_string(),
            "skippedDigest": hx(j.skipped_digest.as_slice()),
            "encoded": hx(&encode::journal_encoded(j)),
            "digest": hx(encode::journal_digest(j).as_slice())
        },
        "cid": {
            "blob": String::from_utf8(r.blob.clone()).unwrap(),
            "blobHex": hx(&r.blob),
            "ipfsHash": hx(j.ipfs_hash.as_slice()),
            "cid": r.cid,
            "cidDigest": hx(j.cid_digest.as_slice())
        },
        "skipped": {
            "count": skip_preimage.len(),
            "entries": skip_preimage,
            "skippedDigest": hx(j.skipped_digest.as_slice())
        },
        "recompute": {
            "note": "reduced-tier browser reproduction inputs — the envelope-verified derived edge set (indexer offchainEdge table), bindings, skips, and the chain-state accumulators the journal binds. envelope-1 verification / CAR walk stay in-guest; this is only the rank→distribute→root→journal reproduction (frontend/lib/hypercerts/recompute.ts).",
            "edges": recompute_edges,
            "bindings": recompute_bindings,
            "skips": recompute_skips,
            "acc": hx(j.acc.as_slice()),
            "leafCount": j.leaf_count,
            "anchorAcc": hx(j.anchor_acc.as_slice()),
            "anchorCount": j.anchor_count
        }
    });

    print!("{}", serde_json::to_string_pretty(&out).unwrap());
}
