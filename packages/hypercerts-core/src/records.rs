//! Typed decode of the seven §2 collections from dag-cbor, following the REAL lexicon
//! v1.1.0 shapes (docs/DEVIATIONS.md #2 — measured from the seeded-PDS fixture, not the
//! plan's table). Every decode failure is a DETERMINISTIC per-record skip, never an abort:
//! a stock PDS writes these NSIDs unvalidated, so these rules are the ONLY shape
//! enforcement anywhere (§3.5).

use ipld_core::ipld::Ipld;
use std::collections::BTreeMap;

/// A strongRef: `{cid, uri}` — pins an exact record version by CID.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StrongRef {
    pub cid: String,
    pub uri: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Record {
    /// `app.certified.graph.follow` — subject is a BARE did string.
    Follow { subject_did: String, created_at: String },
    /// `app.certified.badge.award` — subject is `{$type: app.certified.defs#did, did}` or a
    /// strongRef (record subject); badge is a strongRef to the definition.
    BadgeAward { badge: StrongRef, subject: BadgeSubject, created_at: String },
    /// `app.certified.badge.response` — weight is an OPTIONAL decimal string.
    BadgeResponse {
        badge_award: StrongRef,
        response: String,
        weight: Option<String>,
        created_at: String,
    },
    /// `org.hypercerts.context.evaluation` — subject and score are OPTIONAL (required per
    /// lexicon: evaluators/summary/createdAt); missing either ⇒ the caller skips E3.
    Evaluation { subject: Option<StrongRef>, score: Option<Score>, created_at: String },
    /// `org.hypercerts.claim.activity` — the artifact node + attribution edges.
    Activity { contributors: Vec<Contributor>, created_at: String },
    /// `org.hypercerts.context.acknowledgement` — consent gate on attribution.
    Acknowledgement { subject: StrongRef, acknowledged: bool, created_at: String },
    /// `app.certified.link.evm` — DID ↔ EVM binding (nested proof shape).
    LinkEvm {
        address: String,
        message: LinkEvmMessage,
        /// 65-byte signature as 0x-hex string.
        signature: String,
        created_at: String,
    },
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum BadgeSubject {
    Did(String),
    Ref(StrongRef),
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Score {
    pub min: String,
    pub max: String,
    pub value: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Contributor {
    /// The DID at `contributorIdentity.identity` — a FREE string; non-DID values are
    /// skipped by the caller (no node to attach, §3.4).
    pub identity: String,
    /// Optional decimal string.
    pub contribution_weight: Option<String>,
}

/// All five EIP-712 message fields arrive as STRINGS in the record.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LinkEvmMessage {
    pub did: String,
    pub evm_address: String,
    pub chain_id: String,
    pub timestamp: String,
    pub nonce: String,
}

fn as_map(v: &Ipld) -> Option<&BTreeMap<String, Ipld>> {
    match v {
        Ipld::Map(m) => Some(m),
        _ => None,
    }
}
fn get_str(m: &BTreeMap<String, Ipld>, k: &str) -> Option<String> {
    match m.get(k) {
        Some(Ipld::String(s)) => Some(s.clone()),
        _ => None,
    }
}
fn get_bool(m: &BTreeMap<String, Ipld>, k: &str) -> Option<bool> {
    match m.get(k) {
        Some(Ipld::Bool(b)) => Some(*b),
        _ => None,
    }
}
fn get_strongref(m: &BTreeMap<String, Ipld>, k: &str) -> Option<StrongRef> {
    let r = as_map(m.get(k)?)?;
    Some(StrongRef { cid: get_str(r, "cid")?, uri: get_str(r, "uri")? })
}

/// Decode one record given its collection NSID. `None` = deterministic skip (malformed).
pub fn decode(collection: &str, bytes: &[u8]) -> Option<Record> {
    let v: Ipld = serde_ipld_dagcbor::from_slice(bytes).ok()?;
    let m = as_map(&v)?;
    // $type must match the collection (defense against records filed under foreign keys).
    if get_str(m, "$type").as_deref() != Some(collection) {
        return None;
    }
    let created_at = get_str(m, "createdAt")?;

    match collection {
        "app.certified.graph.follow" => {
            Some(Record::Follow { subject_did: get_str(m, "subject")?, created_at })
        }
        "app.certified.badge.award" => {
            let badge = get_strongref(m, "badge")?;
            let subject = match m.get("subject")? {
                Ipld::Map(sm) => {
                    if let Some(did) = get_str(sm, "did") {
                        BadgeSubject::Did(did)
                    } else if let (Some(cid), Some(uri)) = (get_str(sm, "cid"), get_str(sm, "uri"))
                    {
                        BadgeSubject::Ref(StrongRef { cid, uri })
                    } else {
                        return None;
                    }
                }
                Ipld::String(did) => BadgeSubject::Did(did.clone()),
                _ => return None,
            };
            Some(Record::BadgeAward { badge, subject, created_at })
        }
        "app.certified.badge.response" => Some(Record::BadgeResponse {
            badge_award: get_strongref(m, "badgeAward")?,
            response: get_str(m, "response")?,
            weight: get_str(m, "weight"),
            created_at,
        }),
        "org.hypercerts.context.evaluation" => {
            let score = m.get("score").and_then(as_map).and_then(|sm| {
                Some(Score {
                    min: get_str(sm, "min")?,
                    max: get_str(sm, "max")?,
                    value: get_str(sm, "value")?,
                })
            });
            Some(Record::Evaluation { subject: get_strongref(m, "subject"), score, created_at })
        }
        "org.hypercerts.claim.activity" => {
            let mut contributors = Vec::new();
            if let Some(Ipld::List(l)) = m.get("contributors") {
                for c in l {
                    let Some(cm) = as_map(c) else { continue };
                    let Some(idm) = cm.get("contributorIdentity").and_then(as_map) else {
                        continue;
                    };
                    let Some(identity) = get_str(idm, "identity") else { continue };
                    contributors.push(Contributor {
                        identity,
                        contribution_weight: get_str(cm, "contributionWeight"),
                    });
                }
            }
            Some(Record::Activity { contributors, created_at })
        }
        "org.hypercerts.context.acknowledgement" => Some(Record::Acknowledgement {
            subject: get_strongref(m, "subject")?,
            acknowledged: get_bool(m, "acknowledged")?,
            created_at,
        }),
        "app.certified.link.evm" => {
            let proof = as_map(m.get("proof")?)?;
            let msg = as_map(proof.get("message")?)?;
            Some(Record::LinkEvm {
                address: get_str(m, "address")?,
                message: LinkEvmMessage {
                    did: get_str(msg, "did")?,
                    evm_address: get_str(msg, "evmAddress")?,
                    chain_id: get_str(msg, "chainId")?,
                    timestamp: get_str(msg, "timestamp")?,
                    nonce: get_str(msg, "nonce")?,
                },
                signature: get_str(proof, "signature")?,
                created_at,
            })
        }
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use envelopes::atproto::carset::Car;

    #[test]
    fn all_fixture_records_decode() {
        let root = concat!(env!("CARGO_MANIFEST_DIR"), "/../..");
        let car = std::fs::read(format!("{root}/test/fixtures/atproto/hypercerts/fixtures/hypercerts.car"))
            .unwrap();
        let parsed = Car::parse(&car).unwrap();
        let tsv = std::fs::read_to_string(format!(
            "{root}/test/fixtures/atproto/hypercerts/fixtures/hypercerts.records.tsv"
        ))
        .unwrap();
        let mut n = 0;
        for line in tsv.lines() {
            let (key, cid_s) = line.split_once('\t').unwrap();
            let collection = key.split('/').next().unwrap();
            let cid: ipld_core::cid::Cid = cid_s.parse().unwrap();
            let bytes = parsed.get(&cid).unwrap();
            let rec = decode(collection, bytes)
                .unwrap_or_else(|| panic!("fixture record {key} must decode"));
            n += 1;
            match (&rec, collection) {
                (
                    Record::Evaluation { score: Some(s), subject: Some(_), .. },
                    "org.hypercerts.context.evaluation",
                ) => {
                    // Alice now has TWO evaluations: a cross-repo eval of Bob's activity
                    // (87.5) and a self-eval of her own activity (90, inert but recorded).
                    assert!(s.value == "87.5" || s.value == "90", "unexpected score {}", s.value);
                }
                (
                    Record::BadgeResponse { response, weight, .. },
                    "app.certified.badge.response",
                ) => {
                    assert_eq!(response, "accepted");
                    assert_eq!(weight.as_deref(), Some("0.85"));
                }
                (Record::Activity { contributors, .. }, "org.hypercerts.claim.activity") => {
                    // Alice's only activity: [bob 0.6, carol 0.4].
                    assert_eq!(contributors.len(), 2);
                    assert_eq!(contributors[0].contribution_weight.as_deref(), Some("0.6"));
                }
                (Record::LinkEvm { message, .. }, "app.certified.link.evm") => {
                    assert_eq!(message.chain_id, "10");
                }
                _ => {}
            }
        }
        assert_eq!(n, 6);
    }

    #[test]
    fn foreign_type_rejected() {
        // A follow record filed under the evaluation collection must be skipped.
        let follow = serde_ipld_dagcbor::to_vec(&{
            let mut m = std::collections::BTreeMap::new();
            m.insert(
                "$type".to_string(),
                ipld_core::ipld::Ipld::String("app.certified.graph.follow".into()),
            );
            m.insert("subject".to_string(), ipld_core::ipld::Ipld::String("did:plc:x".into()));
            m.insert("createdAt".to_string(), ipld_core::ipld::Ipld::String("t".into()));
            ipld_core::ipld::Ipld::Map(m)
        })
        .unwrap();
        assert!(decode("org.hypercerts.context.evaluation", &follow).is_none());
    }
}
