//! Graph semantics v1 (HYPERCERTS_ATPROTO_PLAN §3): which records become edges, with what
//! weights, between which nodes — plus the anti-gaming rules and the deterministic skip
//! list (§3.5). Everything here runs in-guest; a prover cannot pick.
//!
//! Node identity (§3.1, model C + artifact nodes):
//!   actor (DID)  nodeId = keccak256(did bytes)            — bound or satellite
//!   artifact     nodeId = keccak256("at://did/coll/rkey") — score sinks/conduits, never vote
//! A bound actor keeps the DID nodeId; the verified `link.evm` binding attaches an EVM
//! address (v1 address-leaf emission + user-signed authorization class).

use crate::binding;
use crate::decimal::{parse_fp, parse_fp_clamped_01, scale};
use crate::records::{decode, BadgeSubject, Record};
use alloy_primitives::{keccak256, Address, B256, U256};
use pagerank_core::fixed::{fp_div, fp_mul};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use zk_core::anchor::SkipEntry;

/// Rule-Φ reasons 1/2 live in `pagerank_core::skip_reason`; the hypercerts program extends
/// the closed list with its deterministic record-level skips (§3.5).
pub mod skip_reason {
    /// Record failed the typed decode (unknown/malformed shape).
    pub const MALFORMED_RECORD: u8 = 10;
    /// A contributor identity that is not a `did:` string — no node to attach (§3.4).
    pub const NON_DID_IDENTITY: u8 = 11;
    /// Badge award whose issuer is not in the definition's `allowedIssuers`.
    pub const ALLOWED_ISSUERS_MISS: u8 = 12;
    /// Evaluation missing subject or score (both optional in the lexicon), or malformed
    /// score strings / degenerate range.
    pub const MISSING_SUBJECT_OR_SCORE: u8 = 13;
    /// Self-edge dropped (self-evaluation, self-attribution).
    pub const SELF_EDGE: u8 = 14;
}

/// One repo's authenticated record set (out of envelope 1), plus its cross-repo order key.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct RepoRecords {
    pub did: String,
    /// The anchor fold index of the consumed head (cross-repo tie-break, OFFCHAIN §4.3).
    pub anchor_fold_index: u64,
    /// `(mst key "collection/rkey", record dag-cbor bytes)` in MST order.
    pub records: Vec<(String, Vec<u8>)>,
}

/// Governance-pinned edge parameters (§6.1 — all fixed-point 1e18, inside `paramsHash`).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct EdgeParams {
    pub w_follow_fp: U256,
    pub w_badge_fp: U256,
    pub w_eval_fp: U256,
    pub w_attrib_fp: U256,
    pub ack_boost_fp: U256,
    pub unacked_attrib_fp: U256,
    pub pds_attested_weight_fp: U256,
}

/// The derived graph + bookkeeping the program's compute step needs.
#[derive(Clone, Debug, Default)]
pub struct DerivedGraph {
    /// Every node (actor or artifact) that touches an included edge.
    pub nodes: Vec<B256>,
    /// `source -> { target -> weight_fp }`.
    pub outgoing: BTreeMap<B256, BTreeMap<B256, U256>>,
    /// DID nodeId -> verified EVM address (bound actors; drives v1 address leaves).
    pub bindings: BTreeMap<B256, Address>,
    /// Deterministic record-level skips, canonically sorted.
    pub skips: Vec<SkipEntry>,
}

pub fn did_node_id(did: &str) -> B256 {
    keccak256(did.as_bytes())
}

pub fn artifact_node_id(author_did: &str, collection: &str, rkey: &str) -> B256 {
    keccak256(format!("at://{author_did}/{collection}/{rkey}").as_bytes())
}

/// Parse an at-uri "at://did/collection/rkey" into its parts.
fn parse_at_uri(uri: &str) -> Option<(String, String, String)> {
    let rest = uri.strip_prefix("at://")?;
    let mut it = rest.splitn(3, '/');
    let did = it.next()?.to_string();
    let coll = it.next()?.to_string();
    let rkey = it.next()?.to_string();
    (!did.is_empty() && !coll.is_empty() && !rkey.is_empty()).then_some((did, coll, rkey))
}

/// One candidate edge before dedup/summing. `type_tag` scopes last-write-wins per §3.3.
struct Candidate {
    source: B256,
    target: B256,
    type_tag: u8, // 1=follow 2=badge 3=eval 4=attrib
    weight_fp: U256,
    /// last-write-wins order: (createdAt string, rkey) — RFC3339 compares lexicographically.
    order: (String, String),
}

const T_FOLLOW: u8 = 1;
const T_BADGE: u8 = 2;
const T_EVAL: u8 = 3;
const T_ATTRIB: u8 = 4;

/// Derive the trust graph from all repos' authenticated records.
///
/// `strongref_targets`: content-verified blocks for cross-repo strongRefs (badge
/// definitions), keyed by CID string; absence of a definition = open-vocabulary default,
/// never a rejection (§2).
pub fn derive(
    repos: &[RepoRecords],
    strongref_targets: &BTreeMap<String, Vec<u8>>,
    p: &EdgeParams,
) -> DerivedGraph {
    let s = scale();
    let mut skips: Vec<SkipEntry> = Vec::new();
    let mut skip =
        |node: B256, reason: u8| skips.push(SkipEntry { node_id: node, reason, epoch_observed: 0 });

    // ---- pass 1: decode everything + build cross-repo indexes -------------------------
    // (author did, collection, rkey, record) in deterministic repo/MST order.
    let mut decoded: Vec<(usize, String, String, Record)> = Vec::new(); // (repo idx, coll, rkey, rec)
    for (ri, repo) in repos.iter().enumerate() {
        let author_node = did_node_id(&repo.did);
        for (key, bytes) in &repo.records {
            let Some((coll, rkey)) = key.split_once('/') else {
                skip(author_node, skip_reason::MALFORMED_RECORD);
                continue;
            };
            match decode(coll, bytes) {
                Some(rec) => decoded.push((ri, coll.to_string(), rkey.to_string(), rec)),
                None => skip(author_node, skip_reason::MALFORMED_RECORD),
            }
        }
    }

    // Bindings: did -> verified EVM address (last valid binding wins per DID, by record
    // order within the repo — one repo can only bind its own DID).
    let mut bindings: BTreeMap<B256, Address> = BTreeMap::new();
    // Acks: (acker did, subject at-uri) -> acknowledged bool.
    let mut acks: BTreeMap<(String, String), bool> = BTreeMap::new();
    // Badge responses: (responder did, badgeAward at-uri) -> (response, weight).
    let mut responses: BTreeMap<(String, String), (String, Option<String>)> = BTreeMap::new();
    // Activities: at-uri -> (author did, contributors) — the artifact nodes.
    let mut activities: BTreeMap<String, (String, Vec<crate::records::Contributor>, String)> =
        BTreeMap::new(); // value: (author, contributors, createdAt)

    for (ri, coll, rkey, rec) in &decoded {
        let author = &repos[*ri].did;
        match rec {
            Record::LinkEvm { address, message, signature, .. } => {
                if let Some(a) = binding::verify_binding(author, address, message, signature) {
                    bindings.insert(did_node_id(author), a);
                } else {
                    skip(did_node_id(author), skip_reason::MALFORMED_RECORD);
                }
            }
            Record::Acknowledgement { subject, acknowledged, .. } => {
                // Two-sided rule (§5.6): the ack counts because it appears in ITS author's
                // own walked repo — which is exactly where we are reading it from.
                acks.insert((author.clone(), subject.uri.clone()), *acknowledged);
            }
            Record::BadgeResponse { badge_award, response, weight, .. } => {
                responses.insert(
                    (author.clone(), badge_award.uri.clone()),
                    (response.clone(), weight.clone()),
                );
            }
            Record::Activity { contributors, created_at } => {
                activities.insert(
                    format!("at://{author}/{coll}/{rkey}"),
                    (author.clone(), contributors.clone(), created_at.clone()),
                );
            }
            _ => {}
        }
    }

    // ---- pass 2: candidate edges --------------------------------------------------------
    let mut candidates: Vec<(u64, Candidate)> = Vec::new(); // (anchor fold idx, candidate)

    for (ri, coll, rkey, rec) in &decoded {
        let repo = &repos[*ri];
        let author = &repo.did;
        let author_node = did_node_id(author);
        // Authorization class: user-signed (bound) = 1.0, satellite = pdsAttested discount.
        let auth_class =
            if bindings.contains_key(&author_node) { s } else { p.pds_attested_weight_fp };
        let fold_idx = repo.anchor_fold_index;

        match rec {
            Record::Follow { subject_did, created_at } => {
                if !subject_did.starts_with("did:") {
                    skip(author_node, skip_reason::NON_DID_IDENTITY);
                    continue;
                }
                let target = did_node_id(subject_did);
                if target == author_node {
                    skip(author_node, skip_reason::SELF_EDGE);
                    continue;
                }
                let w = fp_mul(p.w_follow_fp, auth_class, s);
                candidates.push((
                    fold_idx,
                    Candidate {
                        source: author_node,
                        target,
                        type_tag: T_FOLLOW,
                        weight_fp: w,
                        order: (created_at.clone(), rkey.clone()),
                    },
                ));
            }
            Record::BadgeAward { badge, subject, created_at } => {
                // allowedIssuers: enforced when the definition block is witnessed (§3.3);
                // absent definition = open-vocabulary default.
                //
                // C-1: only honor a definition block that is content-addressed by the
                // badge's own strongRef CID (author-signed). A prover-supplied block whose
                // bytes do not hash to the CID is not the referenced definition — ignore it
                // so a prover can neither forge a restriction to censor a legitimate award
                // nor swap in permissive bytes. (Withholding a real definition to fall back
                // to open-vocabulary is the separate data-availability gap C-1/E2.)
                if let Some(def_bytes) = strongref_targets.get(&badge.cid) {
                    if zk_core::cid::verify_dagcbor_cid(&badge.cid, def_bytes) {
                        if let Some(allowed) = decode_allowed_issuers(def_bytes) {
                            if !allowed.iter().any(|d| d == author) {
                                skip(author_node, skip_reason::ALLOWED_ISSUERS_MISS);
                                continue;
                            }
                        }
                    }
                }
                let target = match subject {
                    BadgeSubject::Did(d) if d.starts_with("did:") => did_node_id(d),
                    BadgeSubject::Did(_) => {
                        skip(author_node, skip_reason::NON_DID_IDENTITY);
                        continue;
                    }
                    BadgeSubject::Ref(r) => match parse_at_uri(&r.uri) {
                        Some((d, c, k)) => artifact_node_id(&d, &c, &k),
                        None => {
                            skip(author_node, skip_reason::MALFORMED_RECORD);
                            continue;
                        }
                    },
                };
                if target == author_node {
                    skip(author_node, skip_reason::SELF_EDGE);
                    continue;
                }
                // Base 1.0; an accepted response's weight (clamped [0,1]) replaces it and
                // the ack boost applies; a rejected response zeroes the award.
                let award_uri = format!("at://{author}/{coll}/{rkey}");
                let mut base = s;
                let mut boost = s;
                // The response must come from the SUBJECT's own repo (two-sided fact).
                if let BadgeSubject::Did(subject_did) = subject {
                    if let Some((resp, w)) = responses.get(&(subject_did.clone(), award_uri)) {
                        match resp.as_str() {
                            "accepted" => {
                                if let Some(ws) = w {
                                    match parse_fp_clamped_01(ws) {
                                        Some(v) => base = v,
                                        None => {
                                            skip(author_node, skip_reason::MALFORMED_RECORD);
                                            continue;
                                        }
                                    }
                                }
                                boost = p.ack_boost_fp;
                            }
                            "rejected" => continue, // ×0: provably inert, not a skip
                            _ => {}
                        }
                    }
                }
                let w = fp_mul(fp_mul(fp_mul(base, p.w_badge_fp, s), boost, s), auth_class, s);
                candidates.push((
                    fold_idx,
                    Candidate {
                        source: author_node,
                        target,
                        type_tag: T_BADGE,
                        weight_fp: w,
                        order: (created_at.clone(), rkey.clone()),
                    },
                ));
            }
            Record::Evaluation { subject, score, created_at } => {
                let (Some(subject), Some(score)) = (subject, score) else {
                    skip(author_node, skip_reason::MISSING_SUBJECT_OR_SCORE);
                    continue;
                };
                let Some((sdid, scoll, srkey)) = parse_at_uri(&subject.uri) else {
                    skip(author_node, skip_reason::MALFORMED_RECORD);
                    continue;
                };
                // Self-evaluation: you cannot evaluate your own work into rank (§3.3).
                if &sdid == author {
                    skip(author_node, skip_reason::SELF_EDGE);
                    continue;
                }
                let (Some(min), Some(max), Some(value)) =
                    (parse_fp(&score.min), parse_fp(&score.max), parse_fp(&score.value))
                else {
                    skip(author_node, skip_reason::MISSING_SUBJECT_OR_SCORE);
                    continue;
                };
                if max <= min {
                    skip(author_node, skip_reason::MISSING_SUBJECT_OR_SCORE);
                    continue;
                }
                // (value - min) / (max - min), clamped to [0, 1].
                let clamped = value.clamp(min, max);
                let base = fp_div(clamped - min, max - min, s);
                let w = fp_mul(fp_mul(base, p.w_eval_fp, s), auth_class, s);
                candidates.push((
                    fold_idx,
                    Candidate {
                        source: author_node,
                        target: artifact_node_id(&sdid, &scoll, &srkey),
                        type_tag: T_EVAL,
                        weight_fp: w,
                        order: (created_at.clone(), rkey.clone()),
                    },
                ));
            }
            Record::Activity { contributors, created_at } => {
                // E4: artifact -> contributor, per-activity Σ = 1 normalization over
                // parseable contributors, self-attribution dropped BEFORE normalization.
                let artifact = artifact_node_id(author, coll, rkey);
                let activity_uri = format!("at://{author}/{coll}/{rkey}");
                let mut parsed: Vec<(B256, String, U256)> = Vec::new(); // (node, did, weight)
                let mut total = U256::ZERO;
                for c in contributors {
                    if !c.identity.starts_with("did:") {
                        skip(author_node, skip_reason::NON_DID_IDENTITY);
                        continue;
                    }
                    if &c.identity == author {
                        skip(author_node, skip_reason::SELF_EDGE);
                        continue;
                    }
                    let Some(ws) = &c.contribution_weight else {
                        skip(author_node, skip_reason::MALFORMED_RECORD);
                        continue;
                    };
                    let Some(w) = parse_fp(ws) else {
                        skip(author_node, skip_reason::MALFORMED_RECORD);
                        continue;
                    };
                    if w.is_zero() {
                        continue;
                    }
                    parsed.push((did_node_id(&c.identity), c.identity.clone(), w));
                    total += w;
                }
                if total.is_zero() {
                    continue;
                }
                for (node, did, w) in parsed {
                    let share = fp_div(w, total, s);
                    // Confirmed attribution doubles; merely being named is worth less.
                    let ack = acks.get(&(did.clone(), activity_uri.clone()));
                    let gate = match ack {
                        Some(true) => p.ack_boost_fp,
                        _ => p.unacked_attrib_fp,
                    };
                    let wfp =
                        fp_mul(fp_mul(fp_mul(share, p.w_attrib_fp, s), gate, s), auth_class, s);
                    candidates.push((
                        fold_idx,
                        Candidate {
                            source: artifact,
                            target: node,
                            type_tag: T_ATTRIB,
                            weight_fp: wfp,
                            order: (created_at.clone(), did),
                        },
                    ));
                }
            }
            Record::BadgeResponse { .. }
            | Record::Acknowledgement { .. }
            | Record::LinkEvm { .. } => {}
        }
    }

    // ---- pass 3: dedup per (source, target, type) then SUM types into the edge ---------
    // Last-write-wins within a type: order by (anchor fold index, createdAt, rkey) — the
    // OFFCHAIN §4.3 cross-lane total order specialized to lane 2.
    let mut latest: BTreeMap<(B256, B256, u8), ((u64, String, String), U256)> = BTreeMap::new();
    for (fold_idx, c) in candidates {
        let key = (c.source, c.target, c.type_tag);
        let ord = (fold_idx, c.order.0, c.order.1);
        match latest.get(&key) {
            Some((prev, _)) if *prev >= ord => {}
            _ => {
                latest.insert(key, (ord, c.weight_fp));
            }
        }
    }

    let mut outgoing: BTreeMap<B256, BTreeMap<B256, U256>> = BTreeMap::new();
    let mut node_set: BTreeSet<B256> = BTreeSet::new();
    for ((source, target, _), (_, w)) in latest {
        if w.is_zero() {
            continue;
        }
        node_set.insert(source);
        node_set.insert(target);
        *outgoing.entry(source).or_default().entry(target).or_insert(U256::ZERO) += w;
    }

    skips.sort();
    DerivedGraph { nodes: node_set.into_iter().collect(), outgoing, bindings, skips }
}

/// Decode `allowedIssuers` from a witnessed badge.definition block, if the field exists.
fn decode_allowed_issuers(bytes: &[u8]) -> Option<Vec<String>> {
    let v: ipld_core::ipld::Ipld = serde_ipld_dagcbor::from_slice(bytes).ok()?;
    let ipld_core::ipld::Ipld::Map(m) = v else { return None };
    let ipld_core::ipld::Ipld::List(l) = m.get("allowedIssuers")? else { return None };
    let mut out = Vec::new();
    for x in l {
        match x {
            ipld_core::ipld::Ipld::String(s) => out.push(s.clone()),
            ipld_core::ipld::Ipld::Map(dm) => {
                if let Some(ipld_core::ipld::Ipld::String(d)) = dm.get("did") {
                    out.push(d.clone());
                }
            }
            _ => {}
        }
    }
    Some(out)
}
