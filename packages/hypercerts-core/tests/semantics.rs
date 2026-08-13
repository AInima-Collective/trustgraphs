//! Edge-semantics + anti-gaming battery (HYPERCERTS_ATPROTO_PLAN §3, GOAL M4 exit):
//! synthetic records through `semantics::derive` — self-evaluation inert, padded
//! contributor lists dilute, non-allowlisted issuers skip, satellite discount applies,
//! ack gating is two-sided, duplicates collapse last-write-wins.

use alloy_primitives::U256;
use hypercerts_core::semantics::{
    self, artifact_node_id, did_node_id, skip_reason, DerivedGraph, EdgeParams, RepoRecords,
};
use ipld_core::ipld::Ipld;
use std::collections::BTreeMap;

const ALICE: &str = "did:plc:alice000000000000000000";
const BOB: &str = "did:plc:bob00000000000000000000";
const CAROL: &str = "did:plc:carol0000000000000000000";

fn s() -> U256 {
    U256::from(1_000_000_000_000_000_000u64)
}
fn fp(n: u64, d: u64) -> U256 {
    s() * U256::from(n) / U256::from(d)
}

/// §6.1 launch values.
fn params() -> EdgeParams {
    EdgeParams {
        w_follow_fp: fp(2, 10),
        w_badge_fp: fp(5, 10),
        w_eval_fp: s(),
        w_attrib_fp: fp(8, 10),
        ack_boost_fp: U256::from(2) * s(),
        unacked_attrib_fp: fp(5, 10),
        pds_attested_weight_fp: fp(5, 10),
    }
}

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

fn follow(subject: &str, t: &str) -> Vec<u8> {
    enc(&m(vec![
        ("$type", st("app.certified.graph.follow")),
        ("subject", st(subject)),
        ("createdAt", st(t)),
    ]))
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

fn acknowledgement(subject_uri: &str, acked: bool) -> Vec<u8> {
    enc(&m(vec![
        ("$type", st("org.hypercerts.context.acknowledgement")),
        ("createdAt", st("2026-01-03T00:00:00Z")),
        ("acknowledged", Ipld::Bool(acked)),
        ("subject", m(vec![("cid", st("bafyfake")), ("uri", st(subject_uri))])),
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

fn repo(did: &str, idx: u64, records: Vec<(&str, Vec<u8>)>) -> RepoRecords {
    RepoRecords {
        did: did.to_string(),
        anchor_fold_index: idx,
        records: records.into_iter().map(|(k, b)| (k.to_string(), b)).collect(),
    }
}

fn derive(repos: &[RepoRecords]) -> DerivedGraph {
    semantics::derive(repos, &BTreeMap::new(), &params())
}

#[test]
fn follow_edge_satellite_discount() {
    let g = derive(&[repo(ALICE, 0, vec![("app.certified.graph.follow/1", follow(BOB, "t1"))])]);
    let w = g.outgoing[&did_node_id(ALICE)][&did_node_id(BOB)];
    // 1.0 × wFollow(0.2) × satellite(0.5) = 0.1
    assert_eq!(w, fp(1, 10));
}

#[test]
fn self_evaluation_is_inert_and_recorded() {
    // Alice evaluates HER OWN activity — no edge, one SELF_EDGE skip.
    let uri = format!("at://{ALICE}/org.hypercerts.claim.activity/act1");
    let g = derive(&[repo(
        ALICE,
        0,
        vec![
            ("org.hypercerts.claim.activity/act1", activity(vec![(BOB, "1")])),
            ("org.hypercerts.context.evaluation/e1", evaluation(&uri, "0", "100", "90")),
        ],
    )]);
    let artifact = artifact_node_id(ALICE, "org.hypercerts.claim.activity", "act1");
    // The self-eval produced no alice -> artifact edge.
    assert!(g.outgoing.get(&did_node_id(ALICE)).map_or(true, |o| !o.contains_key(&artifact)));
    assert!(g.skips.iter().any(|sk| sk.reason == skip_reason::SELF_EDGE));
}

#[test]
fn padded_contributor_list_dilutes_not_mints() {
    // Two activities: one with a single 1.0 contributor, one padded with two extra
    // contributors. The padded activity's per-contributor share shrinks (Σ = 1 always).
    let g1 = derive(&[repo(
        ALICE,
        0,
        vec![("org.hypercerts.claim.activity/a", activity(vec![(BOB, "1")]))],
    )]);
    let g2 = derive(&[repo(
        ALICE,
        0,
        vec![(
            "org.hypercerts.claim.activity/a",
            activity(vec![(BOB, "1"), (CAROL, "1"), ("did:plc:pad0000000000000000000000", "2")]),
        )],
    )]);
    let art = artifact_node_id(ALICE, "org.hypercerts.claim.activity", "a");
    let w1 = g1.outgoing[&art][&did_node_id(BOB)];
    let w2 = g2.outgoing[&art][&did_node_id(BOB)];
    assert_eq!(w2, w1 / U256::from(4), "padding dilutes proportionally (1 -> 1/4 share)");
    // total out-weight equal in both cases (Σ normalized): padding cannot mint.
    let sum1: U256 = g1.outgoing[&art].values().copied().fold(U256::ZERO, |a, b| a + b);
    let sum2: U256 = g2.outgoing[&art].values().copied().fold(U256::ZERO, |a, b| a + b);
    assert_eq!(sum1, sum2);
}

#[test]
fn ack_gating_is_two_sided() {
    let uri = format!("at://{ALICE}/org.hypercerts.claim.activity/a");
    // Bob acknowledges in HIS OWN repo -> ackBoost; Carol does not -> unackedAttrib.
    let g = derive(&[
        repo(
            ALICE,
            0,
            vec![("org.hypercerts.claim.activity/a", activity(vec![(BOB, "1"), (CAROL, "1")]))],
        ),
        repo(
            BOB,
            1,
            vec![("org.hypercerts.context.acknowledgement/k", acknowledgement(&uri, true))],
        ),
    ]);
    let art = artifact_node_id(ALICE, "org.hypercerts.claim.activity", "a");
    let wb = g.outgoing[&art][&did_node_id(BOB)];
    let wc = g.outgoing[&art][&did_node_id(CAROL)];
    // share 0.5 × wAttrib × gate × satellite: bob gate 2.0, carol gate 0.5 -> 4× ratio
    assert_eq!(wb, wc * U256::from(4));
    // An ack forged into ALICE's repo for CAROL must NOT boost (two-sided rule): ack keys
    // on the acknowledging repo's own DID, and alice ≠ carol.
    let g_forged = derive(&[repo(
        ALICE,
        0,
        vec![
            ("org.hypercerts.claim.activity/a", activity(vec![(BOB, "1"), (CAROL, "1")])),
            ("org.hypercerts.context.acknowledgement/f", acknowledgement(&uri, true)),
        ],
    )]);
    let wc_forged = g_forged.outgoing[&art][&did_node_id(CAROL)];
    assert_eq!(wc_forged, wc, "an ack in the wrong repo is inert");
}

#[test]
fn badge_accept_reject_and_allowlist() {
    let award_uri = format!("at://{ALICE}/app.certified.badge.award/aw");
    // Accepted with weight 0.85 (bob's own repo) -> base 0.85 × ackBoost.
    let g = derive(&[
        repo(ALICE, 0, vec![("app.certified.badge.award/aw", award(BOB, "bafydef"))]),
        repo(
            BOB,
            1,
            vec![(
                "app.certified.badge.response/r",
                response(&award_uri, "accepted", Some("0.85")),
            )],
        ),
    ]);
    let w = g.outgoing[&did_node_id(ALICE)][&did_node_id(BOB)];
    // 0.85 × wBadge(0.5) × boost(2.0) × satellite(0.5) = 0.425
    assert_eq!(w, fp(425, 1000));

    // Rejected zeroes the award.
    let g2 = derive(&[
        repo(ALICE, 0, vec![("app.certified.badge.award/aw", award(BOB, "bafydef"))]),
        repo(
            BOB,
            1,
            vec![("app.certified.badge.response/r", response(&award_uri, "rejected", None))],
        ),
    ]);
    assert!(g2
        .outgoing
        .get(&did_node_id(ALICE))
        .map_or(true, |o| !o.contains_key(&did_node_id(BOB))));

    // allowedIssuers miss: definition witnessed, alice not listed -> skip, no edge.
    // The definition must be keyed by its real content-addressed CID (C-1): the guest only
    // honors a strongRef target whose bytes hash to the badge CID.
    let def = enc(&m(vec![
        ("$type", st("app.certified.badge.definition")),
        ("allowedIssuers", Ipld::List(vec![st(CAROL)])),
    ]));
    let def_cid = zk_core::cid::cid_v1_dagcbor(&zk_core::cid::sha256(&def));
    let mut targets = BTreeMap::new();
    targets.insert(def_cid.clone(), def);
    let g3 = semantics::derive(
        &[repo(ALICE, 0, vec![("app.certified.badge.award/aw", award(BOB, &def_cid))])],
        &targets,
        &params(),
    );
    assert!(g3
        .outgoing
        .get(&did_node_id(ALICE))
        .map_or(true, |o| !o.contains_key(&did_node_id(BOB))));
    assert!(g3.skips.iter().any(|sk| sk.reason == skip_reason::ALLOWED_ISSUERS_MISS));

    // C-1 forgery guard: same award, but the prover supplies a block that does NOT hash to
    // the CID (a forged restriction). It must be ignored, not honored -> award stands, so no
    // ALLOWED_ISSUERS_MISS skip is produced by a fabricated definition.
    let mut forged = BTreeMap::new();
    forged.insert(def_cid.clone(), enc(&m(vec![("$type", st("totally.different.record"))])));
    let g4 = semantics::derive(
        &[repo(ALICE, 0, vec![("app.certified.badge.award/aw", award(BOB, &def_cid))])],
        &forged,
        &params(),
    );
    assert!(!g4.skips.iter().any(|sk| sk.reason == skip_reason::ALLOWED_ISSUERS_MISS));
}

#[test]
fn non_did_contributor_skipped_and_duplicates_collapse() {
    let g = derive(&[repo(
        ALICE,
        0,
        vec![
            ("org.hypercerts.claim.activity/a", activity(vec![(BOB, "1"), ("Just A Name", "1")])),
            // two follows to the same subject: later createdAt wins (same weight here, but the
            // dedup must leave exactly ONE follow edge, not a doubled sum).
            ("app.certified.graph.follow/f1", follow(BOB, "2026-01-01T00:00:00Z")),
            ("app.certified.graph.follow/f2", follow(BOB, "2026-01-02T00:00:00Z")),
        ],
    )]);
    assert!(g.skips.iter().any(|sk| sk.reason == skip_reason::NON_DID_IDENTITY));
    // Bob got the FULL attribution share (junk contributor excluded from Σ).
    let art = artifact_node_id(ALICE, "org.hypercerts.claim.activity", "a");
    // share 1.0 × wAttrib(0.8) × unacked(0.5) × satellite(0.5) = 0.2
    assert_eq!(g.outgoing[&art][&did_node_id(BOB)], fp(2, 10));
    // follow edge counted once: 0.2 × 0.5 = 0.1 (not 0.2)
    assert_eq!(g.outgoing[&did_node_id(ALICE)][&did_node_id(BOB)], fp(1, 10));
}

#[test]
fn missing_score_or_subject_skips_deterministically() {
    let uri = format!("at://{BOB}/org.hypercerts.claim.activity/x");
    // no score
    let no_score = enc(&m(vec![
        ("$type", st("org.hypercerts.context.evaluation")),
        ("createdAt", st("t")),
        ("subject", m(vec![("cid", st("c")), ("uri", st(&uri))])),
    ]));
    // degenerate range
    let degenerate = evaluation(&uri, "5", "5", "5");
    let g = derive(&[repo(
        ALICE,
        0,
        vec![
            ("org.hypercerts.context.evaluation/e1", no_score),
            ("org.hypercerts.context.evaluation/e2", degenerate),
        ],
    )]);
    assert!(g.outgoing.is_empty());
    assert_eq!(
        g.skips.iter().filter(|sk| sk.reason == skip_reason::MISSING_SUBJECT_OR_SCORE).count(),
        2
    );
}

#[test]
fn evaluation_normalizes_into_unit_range() {
    let uri = format!("at://{BOB}/org.hypercerts.claim.activity/x");
    let g = derive(&[repo(
        ALICE,
        0,
        vec![("org.hypercerts.context.evaluation/e", evaluation(&uri, "0", "100", "87.5"))],
    )]);
    let art = artifact_node_id(BOB, "org.hypercerts.claim.activity", "x");
    // 0.875 × wEval(1.0) × satellite(0.5)
    assert_eq!(g.outgoing[&did_node_id(ALICE)][&art], fp(875, 2000));
    // out-of-range value clamps, never exceeds 1.0
    let g2 = derive(&[repo(
        ALICE,
        0,
        vec![("org.hypercerts.context.evaluation/e", evaluation(&uri, "0", "100", "250"))],
    )]);
    assert_eq!(g2.outgoing[&did_node_id(ALICE)][&art], fp(5, 10));
}
