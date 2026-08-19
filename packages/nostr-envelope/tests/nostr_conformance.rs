use std::path::{Path, PathBuf};

use alloy_primitives::B256;
use nostr_envelope::nostr::event::decode_hex;
use nostr_envelope::nostr::event::NostrEvent;
use nostr_envelope::nostr::tgnw;
use nostr_envelope::nostr::{
    community_node_id, nostr_node_id, verify, verify_cached, CommitmentVariant, EventDisposition,
    NostrAnchor, NostrError, NostrLimits, NostrVerifyConfig, SkipReason, VerificationCache,
    BUZZ_AUDIT_BITMAP, SELF_LOG_BITMAP,
};
use nostr_envelope::nostr::{event, oa, state};
use serde::Deserialize;
use sha2::{Digest, Sha256};

fn fixture() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../test/fixtures/nostr/buzz/a362fecc2389955f942c9581bdfeba379ab115b3")
}

fn digest(bytes: &[u8]) -> B256 {
    B256::from(<[u8; 32]>::from(Sha256::digest(bytes)))
}

fn option_a_claim(bytes: &[u8]) -> (NostrAnchor, NostrVerifyConfig, tgnw::TgnwBundle) {
    let bundle = tgnw::decode(bytes, &NostrLimits::HARD).unwrap();
    assert_eq!(bundle.variant, CommitmentVariant::BuzzAuditV1);
    let head = bundle.audit.last().unwrap().hash;
    let anchor = NostrAnchor {
        node_id: community_node_id(&bundle.community_id),
        head: B256::from(head),
        count: bundle.audit.len() as u64,
        data_commitment: digest(bytes),
    };
    let config = NostrVerifyConfig {
        community_id: bundle.community_id,
        instance_domain: bundle.instance_domain,
        relay_pubkey: bundle.authority,
        allowed_variants: BUZZ_AUDIT_BITMAP,
        limits: NostrLimits::HARD,
    };
    (anchor, config, bundle)
}

fn option_c_claim(bytes: &[u8]) -> (NostrAnchor, NostrVerifyConfig, tgnw::TgnwBundle) {
    let bundle = tgnw::decode(bytes, &NostrLimits::HARD).unwrap();
    assert_eq!(bundle.variant, CommitmentVariant::SelfLogV1);
    let head = bundle
        .head_event
        .as_ref()
        .unwrap()
        .tags
        .iter()
        .find(|tag| tag.first().map(String::as_str) == Some("head"))
        .unwrap();
    let anchor = NostrAnchor {
        node_id: nostr_node_id(&bundle.authority),
        head: B256::from(decode_hex::<32>(&head[1]).unwrap()),
        count: bundle.events.len() as u64,
        data_commitment: digest(bytes),
    };
    let config = NostrVerifyConfig {
        community_id: bundle.community_id,
        instance_domain: bundle.instance_domain,
        relay_pubkey: [0; 32],
        allowed_variants: SELF_LOG_BITMAP,
        limits: NostrLimits::HARD,
    };
    (anchor, config, bundle)
}

#[test]
fn live_option_a_round_trips_natively() {
    let bytes = std::fs::read(fixture().join("live/live-option-a.tgnw")).unwrap();
    let (anchor, config, decoded) = option_a_claim(&bytes);
    assert_eq!(tgnw::encode(&decoded).unwrap(), bytes);
    let verified = verify(&anchor, &config, &bytes).unwrap();
    assert_eq!(verified.variant, CommitmentVariant::BuzzAuditV1);
    assert_eq!(verified.count, 30);
    assert_eq!(verified.outcomes.len(), 35);
    assert_eq!(verified.roster.len(), 2);
    assert_eq!(
        verified.data_commitment,
        B256::from(
            decode_hex::<32>("872093fcdc876464c5c98f4349e090bc86a70da8bef7ef105ccdb5a532033a5d")
                .unwrap()
        )
    );
}

#[test]
fn live_option_c_round_trips_natively() {
    let bytes = std::fs::read(fixture().join("live/source-option-c.tgnw")).unwrap();
    let (anchor, config, bundle) = option_c_claim(&bytes);
    assert_eq!(tgnw::encode(&bundle).unwrap(), bytes);
    let verified = verify(&anchor, &config, &bytes).unwrap();
    assert_eq!(verified.variant, CommitmentVariant::SelfLogV1);
    assert_eq!(verified.outcomes.len(), bundle.events.len());
}

#[test]
fn mixed_a_c_reuses_exact_event_and_oa_verification_results() {
    let a_bytes = std::fs::read(fixture().join("source-option-a.tgnw")).unwrap();
    let c_bytes = std::fs::read(fixture().join("source-option-c.tgnw")).unwrap();
    let (a_anchor, mut config, a_bundle) = option_a_claim(&a_bytes);
    let (c_anchor, _, c_bundle) = option_c_claim(&c_bytes);
    config.allowed_variants = BUZZ_AUDIT_BITMAP | SELF_LOG_BITMAP;

    let mut cache = VerificationCache::default();
    verify_cached(&a_anchor, &config, &a_bytes, &mut cache).unwrap();
    verify_cached(&c_anchor, &config, &c_bytes, &mut cache).unwrap();

    let unique_events: std::collections::BTreeSet<_> = a_bundle
        .events
        .iter()
        .chain(c_bundle.events.iter())
        .chain(c_bundle.head_event.iter())
        .map(|event| event.id)
        .collect();
    let total_occurrences =
        a_bundle.events.len() + c_bundle.events.len() + usize::from(c_bundle.head_event.is_some());
    assert_eq!(cache.event_verifications(), unique_events.len());
    assert!(cache.event_verifications() < total_occurrences);

    let unique_auth_attempts: usize = unique_events
        .iter()
        .map(|id| {
            a_bundle
                .events
                .iter()
                .chain(c_bundle.events.iter())
                .find(|event| &event.id == id)
                .map(|event| {
                    event
                        .tags
                        .iter()
                        .filter(|tag| tag.first().map(String::as_str) == Some("auth"))
                        .count()
                })
                .unwrap_or_default()
        })
        .sum();
    assert_eq!(cache.oa_verifications(), unique_auth_attempts);
}

#[test]
fn option_c_identity_order_head_and_claim_mutations_are_rejected() {
    let bytes = std::fs::read(fixture().join("live/source-option-c.tgnw")).unwrap();
    let (anchor, config, baseline) = option_c_claim(&bytes);

    let mut wrong_anchor = anchor;
    wrong_anchor.node_id = B256::ZERO;
    assert!(verify(&wrong_anchor, &config, &bytes).is_err());
    wrong_anchor = anchor;
    wrong_anchor.head = B256::ZERO;
    assert!(verify(&wrong_anchor, &config, &bytes).is_err());
    wrong_anchor = anchor;
    wrong_anchor.count ^= 1;
    assert!(verify(&wrong_anchor, &config, &bytes).is_err());

    let mut wrong_config = config.clone();
    wrong_config.allowed_variants = BUZZ_AUDIT_BITMAP;
    assert_eq!(verify(&anchor, &wrong_config, &bytes), Err(NostrError::VariantNotAllowed));
    wrong_config = config.clone();
    wrong_config.instance_domain[0] ^= 1;
    assert!(verify(&anchor, &wrong_config, &bytes).is_err());

    let mut mutations = Vec::new();
    let mut mutated = baseline.clone();
    mutated.events.swap(0, 1);
    mutations.push(mutated);
    let mut mutated = baseline.clone();
    mutated.authority[0] ^= 1;
    mutations.push(mutated);
    let mut mutated = baseline.clone();
    mutated.head_event.as_mut().unwrap().tags[0][1].push('0');
    mutations.push(mutated);
    let mut mutated = baseline.clone();
    mutated.head_event.as_mut().unwrap().sig[0] ^= 1;
    mutations.push(mutated);

    for mutated in mutations {
        assert!(verify_reencoded(&mutated, &anchor, &config).is_err());
    }
    let mut missing_head = baseline;
    missing_head.head_event = None;
    assert_eq!(tgnw::encode(&missing_head), Err(NostrError::Malformed));
}

#[test]
fn changed_signed_byte_fails_after_recommitting() {
    let mut bytes = std::fs::read(fixture().join("live/live-option-a.tgnw")).unwrap();
    let (mut anchor, config, _) = option_a_claim(&bytes);
    let last = bytes.len() - 1;
    bytes[last] ^= 1;
    anchor.data_commitment = digest(&bytes);
    assert_eq!(verify(&anchor, &config, &bytes), Err(NostrError::BadEventSignature));
}

#[test]
fn audit_gap_fails_even_when_recommitted_and_recounted() {
    let baseline = std::fs::read(fixture().join("source-option-a.tgnw")).unwrap();
    let gap = std::fs::read(fixture().join("adversarial/audit-gap.tgnw")).unwrap();
    let (mut anchor, config, _) = option_a_claim(&baseline);
    anchor.data_commitment = digest(&gap);
    anchor.count -= 1;
    assert_eq!(verify(&anchor, &config, &gap), Err(NostrError::AuditSequence));
}

#[test]
fn missing_audited_event_cannot_produce_a_root() {
    let baseline = std::fs::read(fixture().join("live/live-option-a.tgnw")).unwrap();
    let (mut anchor, config, mut bundle) = option_a_claim(&baseline);
    let missing = decode_hex::<32>(bundle.audit[0].object_id.as_ref().unwrap()).unwrap();
    bundle.events.retain(|event| event.id != missing);
    let bytes = tgnw::encode(&bundle).unwrap();
    anchor.data_commitment = digest(&bytes);
    assert_eq!(verify(&anchor, &config, &bytes), Err(NostrError::MissingEvent));
}

fn verify_reencoded(
    bundle: &tgnw::TgnwBundle,
    anchor: &NostrAnchor,
    config: &NostrVerifyConfig,
) -> Result<nostr_envelope::nostr::VerifiedNostrEnvelope, NostrError> {
    let bytes = tgnw::encode(bundle)?;
    let mut anchor = *anchor;
    anchor.data_commitment = digest(&bytes);
    verify(&anchor, config, &bytes)
}

#[test]
fn every_authenticated_option_a_field_mutation_is_rejected() {
    let bytes = std::fs::read(fixture().join("live/live-option-a.tgnw")).unwrap();
    let (anchor, config, baseline) = option_a_claim(&bytes);

    let mut anchor_mutations = [anchor; 4];
    anchor_mutations[0].node_id.0[0] ^= 1;
    anchor_mutations[1].head.0[0] ^= 1;
    anchor_mutations[2].count ^= 1;
    anchor_mutations[3].data_commitment.0[0] ^= 1;
    for mutated in anchor_mutations {
        assert!(verify(&mutated, &config, &bytes).is_err());
    }

    let mut bundle_mutations = Vec::new();
    let mut mutated = baseline.clone();
    mutated.community_id[0] ^= 1;
    bundle_mutations.push(mutated);
    let mut mutated = baseline.clone();
    mutated.instance_domain[0] ^= 1;
    bundle_mutations.push(mutated);
    let mut mutated = baseline.clone();
    mutated.authority[0] ^= 1;
    bundle_mutations.push(mutated);

    for mutate in [
        |entry: &mut nostr_envelope::nostr::audit::AuditEntry| entry.sequence ^= 1,
        |entry: &mut nostr_envelope::nostr::audit::AuditEntry| entry.hash[0] ^= 1,
        |entry: &mut nostr_envelope::nostr::audit::AuditEntry| {
            entry.previous_hash = Some([1; 32]);
        },
        |entry: &mut nostr_envelope::nostr::audit::AuditEntry| entry.action = 1,
        |entry: &mut nostr_envelope::nostr::audit::AuditEntry| {
            entry.actor_pubkey = Some([1; 32]);
        },
        |entry: &mut nostr_envelope::nostr::audit::AuditEntry| {
            entry.object_id = Some("00".into());
        },
        |entry: &mut nostr_envelope::nostr::audit::AuditEntry| {
            entry.created_at = "2026-02-30T00:00:00.000000+00:00".into()
        },
        |entry: &mut nostr_envelope::nostr::audit::AuditEntry| entry.detail.push(' '),
    ] {
        let mut mutated = baseline.clone();
        mutate(&mut mutated.audit[0]);
        bundle_mutations.push(mutated);
    }

    for mutate in [
        |event: &mut NostrEvent| event.id[0] ^= 1,
        |event: &mut NostrEvent| event.pubkey[0] ^= 1,
        |event: &mut NostrEvent| event.created_at ^= 1,
        |event: &mut NostrEvent| event.kind ^= 1,
        |event: &mut NostrEvent| event.tags.push(vec!["x".into()]),
        |event: &mut NostrEvent| event.content.push('x'),
        |event: &mut NostrEvent| event.sig[0] ^= 1,
    ] {
        let mut mutated = baseline.clone();
        mutate(&mut mutated.events[0]);
        bundle_mutations.push(mutated);
    }

    for mutated in bundle_mutations {
        assert!(verify_reencoded(&mutated, &anchor, &config).is_err());
    }
}

#[test]
fn oa_attempt_limit_is_checked_before_state_results() {
    let bytes = std::fs::read(fixture().join("live/live-option-a.tgnw")).unwrap();
    let (anchor, mut config, _) = option_a_claim(&bytes);
    config.limits.oa_signatures = 2;
    assert_eq!(verify(&anchor, &config, &bytes), Err(NostrError::LimitExceeded));
}

#[test]
fn bounded_decoder_mutations_are_canonical_or_rejected_without_panics() {
    let baseline = std::fs::read(fixture().join("live/live-option-a.tgnw")).unwrap();
    let mut state = 0x7a5b_9d31_4c20_e817u64;
    for _ in 0..2_048 {
        state ^= state << 13;
        state ^= state >> 7;
        state ^= state << 17;
        let length = (state as usize) % (baseline.len() + 1);
        let mut candidate = baseline[..length].to_vec();
        if !candidate.is_empty() {
            let offset = ((state >> 17) as usize) % candidate.len();
            candidate[offset] ^= ((state >> 40) as u8) | 1;
        }
        let result = std::panic::catch_unwind(|| tgnw::decode(&candidate, &NostrLimits::HARD));
        let decoded = result.expect("bounded TGNW decode must not panic");
        if let Ok(bundle) = decoded {
            assert_eq!(tgnw::encode(&bundle).unwrap(), candidate);
        }
    }
}

fn state_event(
    id: u8,
    pubkey: [u8; 32],
    created_at: u64,
    kind: u16,
    tags: Vec<Vec<&str>>,
) -> NostrEvent {
    NostrEvent {
        id: [id; 32],
        pubkey,
        created_at,
        kind,
        tags: tags.into_iter().map(|tag| tag.into_iter().map(str::to_owned).collect()).collect(),
        content: String::new(),
        sig: vec![0; 64],
    }
}

fn roster_event(relay: [u8; 32], member: [u8; 32]) -> NostrEvent {
    state_event(
        200,
        relay,
        1,
        13_534,
        vec![vec!["-"], vec!["member", &hex::encode(member), "member"]],
    )
}

#[test]
fn same_second_replacement_is_order_independent_and_lowest_id_wins() {
    let relay = [1; 32];
    let member = [2; 32];
    let subject = hex::encode([3; 32]);
    let low = state_event(4, member, 10, 36_382, vec![vec!["d", &subject], vec!["weight", "50"]]);
    let high = state_event(5, member, 10, 36_382, vec![vec!["d", &subject], vec!["weight", "90"]]);
    for candidates in [vec![high.clone(), low.clone()], vec![low.clone(), high.clone()]] {
        let mut events = vec![roster_event(relay, member)];
        events.extend(candidates);
        let (outcomes, _) = state::resolve(events, &relay).unwrap();
        let winner = outcomes
            .iter()
            .find(|outcome| {
                outcome.event.kind == 36_382 && outcome.disposition == EventDisposition::Accepted
            })
            .unwrap();
        assert_eq!(winner.event.id, low.id);
        assert!(outcomes.iter().any(|outcome| {
            outcome.event.id == high.id
                && outcome.disposition == EventDisposition::Skipped(SkipReason::LwwSuperseded)
        }));
    }
}

#[test]
fn newest_valid_relay_roster_defines_current_membership() {
    let relay = [1; 32];
    let old_member = [2; 32];
    let current_member = [3; 32];
    let mut old = roster_event(relay, old_member);
    old.id = [201; 32];
    old.created_at = 1;
    let mut current = roster_event(relay, current_member);
    current.id = [202; 32];
    current.created_at = 2;
    let old_authored = state_event(10, old_member, 3, 45_001, vec![]);
    let current_authored = state_event(11, current_member, 3, 45_001, vec![]);
    let (outcomes, roster) = state::resolve(
        vec![old.clone(), current.clone(), old_authored.clone(), current_authored],
        &relay,
    )
    .unwrap();
    assert_eq!(roster, [current_member].into_iter().collect());
    assert!(outcomes.iter().any(|outcome| {
        outcome.event.id == old.id
            && outcome.disposition == EventDisposition::Skipped(SkipReason::LwwSuperseded)
    }));
    assert!(outcomes.iter().any(|outcome| {
        outcome.event.id == old_authored.id
            && outcome.disposition == EventDisposition::Skipped(SkipReason::RosterNonMember)
    }));
}

#[test]
fn deletion_requires_target_ownership() {
    let relay = [1; 32];
    let owner = [2; 32];
    let stranger = [3; 32];
    let target = state_event(10, owner, 5, 45_001, vec![]);
    let valid = state_event(11, owner, 6, 5, vec![vec!["e", &hex::encode(target.id)]]);
    let invalid = state_event(12, stranger, 7, 5, vec![vec!["e", &hex::encode(target.id)]]);
    let (valid_outcomes, _) =
        state::resolve(vec![roster_event(relay, owner), target.clone(), valid], &relay).unwrap();
    assert!(valid_outcomes.iter().any(|outcome| {
        outcome.event.id == target.id
            && outcome.disposition == EventDisposition::Skipped(SkipReason::DeletionTombstoned)
    }));

    let mut roster = roster_event(relay, owner);
    roster.tags.push(vec!["member".into(), hex::encode(stranger), "member".into()]);
    let (invalid_outcomes, _) =
        state::resolve(vec![roster, target, invalid.clone()], &relay).unwrap();
    assert!(invalid_outcomes.iter().any(|outcome| {
        outcome.event.id == invalid.id
            && outcome.disposition == EventDisposition::Skipped(SkipReason::InvalidDeletion)
    }));
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SourceCorpus {
    principals: SourcePrincipals,
    events: Vec<SourceEventVector>,
    adversarial: Vec<AdversarialCase>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SourcePrincipals {
    relay: String,
    outsider_owner: String,
}

#[derive(Deserialize)]
struct SourceEventVector {
    name: String,
    event: WireEvent,
}

#[derive(Deserialize)]
struct AdversarialCase {
    name: String,
    event: Option<SourceEventVector>,
}

#[derive(Clone, Deserialize)]
struct WireEvent {
    id: String,
    pubkey: String,
    created_at: u64,
    kind: u16,
    tags: Vec<Vec<String>>,
    content: String,
    sig: String,
}

impl WireEvent {
    fn decode(&self) -> NostrEvent {
        NostrEvent {
            id: decode_hex(&self.id).unwrap(),
            pubkey: decode_hex(&self.pubkey).unwrap(),
            created_at: self.created_at,
            kind: self.kind,
            tags: self.tags.clone(),
            content: self.content.clone(),
            sig: decode_hex::<64>(&self.sig).unwrap().to_vec(),
        }
    }
}

fn source_corpus() -> SourceCorpus {
    serde_json::from_slice(&std::fs::read(fixture().join("source-corpus.json")).unwrap()).unwrap()
}

fn adversarial_event(corpus: &SourceCorpus, name: &str) -> NostrEvent {
    corpus
        .adversarial
        .iter()
        .find(|case| case.name == name)
        .and_then(|case| case.event.as_ref())
        .unwrap()
        .event
        .decode()
}

#[test]
fn signed_adversarial_oa_vectors_have_the_frozen_skip_results() {
    let corpus = source_corpus();
    let cases = [
        ("duplicate-auth-tags", SkipReason::OaAmbiguous),
        ("oa-created-at-lower-edge", SkipReason::OaWindowViolation),
        ("oa-created-at-upper-edge", SkipReason::OaWindowViolation),
    ];
    for (name, expected) in cases {
        let candidate = adversarial_event(&corpus, name);
        event::verify(&candidate).unwrap();
        assert_eq!(oa::owner_for_event(&candidate), Err(expected));
    }

    let outsider = adversarial_event(&corpus, "agent-owner-not-in-roster");
    event::verify(&outsider).unwrap();
    assert_eq!(
        oa::owner_for_event(&outsider).unwrap(),
        Some(decode_hex(&corpus.principals.outsider_owner).unwrap())
    );

    let roster =
        corpus.events.iter().find(|event| event.name == "relay-roster").unwrap().event.decode();
    let relay = decode_hex(&corpus.principals.relay).unwrap();
    let (outcomes, _) = state::resolve(vec![roster, outsider.clone()], &relay).unwrap();
    assert!(outcomes.iter().any(|outcome| {
        outcome.event.id == outsider.id
            && outcome.disposition == EventDisposition::Skipped(SkipReason::RosterNonMember)
    }));
}

#[test]
fn signed_wrong_author_deletion_is_a_deterministic_skip() {
    let corpus = source_corpus();
    let roster =
        corpus.events.iter().find(|event| event.name == "relay-roster").unwrap().event.decode();
    let target = corpus
        .events
        .iter()
        .find(|event| event.name == "vouch-deleted-by-e-target")
        .unwrap()
        .event
        .decode();
    let deletion = adversarial_event(&corpus, "wrong-author-e-deletion");
    for candidate in [&target, &deletion] {
        event::verify(candidate).unwrap();
    }
    let relay = decode_hex(&corpus.principals.relay).unwrap();
    let (outcomes, _) =
        state::resolve(vec![roster, target.clone(), deletion.clone()], &relay).unwrap();
    assert!(outcomes.iter().any(|outcome| {
        outcome.event.id == deletion.id
            && outcome.disposition == EventDisposition::Skipped(SkipReason::InvalidDeletion)
    }));
    assert!(outcomes.iter().any(|outcome| {
        outcome.event.id == target.id && outcome.disposition == EventDisposition::Accepted
    }));
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CapFixture {
    cases: Vec<CapCase>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CapCase {
    field: String,
    maximum: u64,
    first_rejected: u64,
}

#[test]
fn checked_in_caps_match_production_constants() {
    let fixture: CapFixture = serde_json::from_slice(
        &std::fs::read(fixture().join("live/adversarial/cap-boundaries.json")).unwrap(),
    )
    .unwrap();
    let expected = [
        ("bundleBytes", NostrLimits::HARD.envelope_bytes as u64),
        ("selectedHeads", NostrLimits::HARD.selected_heads as u64),
        ("auditEntries", NostrLimits::HARD.audit_entries as u64),
        ("events", NostrLimits::HARD.events as u64),
        ("encodedEventBytes", NostrLimits::HARD.encoded_event_bytes as u64),
        ("contentBytes", NostrLimits::HARD.content_bytes as u64),
        ("tagsPerEvent", NostrLimits::HARD.tags_per_event as u64),
        ("elementsPerTag", NostrLimits::HARD.elements_per_tag as u64),
        ("tagStringBytes", NostrLimits::HARD.tag_string_bytes as u64),
        ("allTagStringBytes", NostrLimits::HARD.all_tag_strings_bytes as u64),
        ("auditDetailBytes", NostrLimits::HARD.audit_detail_bytes as u64),
        ("nip01SignatureChecks", NostrLimits::HARD.nip01_signatures as u64),
        ("nipOaSignatureChecks", NostrLimits::HARD.oa_signatures as u64),
    ];
    for (field, maximum) in expected {
        let case = fixture.cases.iter().find(|case| case.field == field).unwrap();
        assert_eq!(case.maximum, maximum);
        assert_eq!(case.first_rejected, maximum + 1);
    }
}
