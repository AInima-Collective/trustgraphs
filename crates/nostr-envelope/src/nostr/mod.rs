//! Envelope 2 — authenticated Buzz audit prefixes and Nostr self-logs.
//!
//! The verifier consumes canonical, bounded TGNW v1 bytes. It binds the exact bytes to the
//! anchor's SHA-256 data commitment, verifies every NIP-01 id and BIP-340 signature, then verifies
//! either the complete Buzz audit prefix or the author's self-log head. Replacement, deletion,
//! roster, and NIP-OA decisions use the same implementation natively and in SP1.

pub mod audit;
pub mod event;
pub mod oa;
pub mod state;
pub mod tgnw;

use std::collections::{BTreeMap, BTreeSet};

use alloy_primitives::{keccak256, B256};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};

use audit::verify_prefix;
use event::{decode_hex, lowercase_hex, NostrEvent};
use tgnw::TgnwBundle;

pub const BUZZ_AUDIT_BITMAP: u8 = 1;
pub const SELF_LOG_BITMAP: u8 = 2;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[repr(u8)]
pub enum CommitmentVariant {
    BuzzAuditV1 = 1,
    SelfLogV1 = 2,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct NostrLimits {
    pub envelope_bytes: u32,
    pub selected_heads: u32,
    pub audit_entries: u32,
    pub events: u32,
    pub encoded_event_bytes: u32,
    pub content_bytes: u32,
    pub tags_per_event: u32,
    pub elements_per_tag: u32,
    pub tag_string_bytes: u32,
    pub all_tag_strings_bytes: u32,
    pub audit_detail_bytes: u32,
    pub nip01_signatures: u32,
    pub oa_signatures: u32,
}

impl NostrLimits {
    pub const HARD: Self = Self {
        envelope_bytes: 12_582_912,
        selected_heads: 129,
        audit_entries: 4_096,
        events: 512,
        encoded_event_bytes: 131_072,
        content_bytes: 65_536,
        tags_per_event: 64,
        elements_per_tag: 8,
        tag_string_bytes: 1_024,
        all_tag_strings_bytes: 16_384,
        audit_detail_bytes: 4_096,
        nip01_signatures: 640,
        oa_signatures: 256,
    };

    pub const PILOT: Self = Self {
        envelope_bytes: 4_194_304,
        selected_heads: 129,
        audit_entries: 2_048,
        events: 512,
        encoded_event_bytes: 131_072,
        content_bytes: 65_536,
        tags_per_event: 64,
        elements_per_tag: 8,
        tag_string_bytes: 1_024,
        all_tag_strings_bytes: 16_384,
        audit_detail_bytes: 4_096,
        nip01_signatures: 640,
        oa_signatures: 128,
    };

    pub fn validate(&self) -> Result<(), NostrError> {
        let hard = Self::HARD;
        if self.envelope_bytes > hard.envelope_bytes
            || self.selected_heads > hard.selected_heads
            || self.audit_entries > hard.audit_entries
            || self.events > hard.events
            || self.encoded_event_bytes > hard.encoded_event_bytes
            || self.content_bytes > hard.content_bytes
            || self.tags_per_event > hard.tags_per_event
            || self.elements_per_tag > hard.elements_per_tag
            || self.tag_string_bytes > hard.tag_string_bytes
            || self.all_tag_strings_bytes > hard.all_tag_strings_bytes
            || self.audit_detail_bytes > hard.audit_detail_bytes
            || self.nip01_signatures > hard.nip01_signatures
            || self.oa_signatures > hard.oa_signatures
        {
            return Err(NostrError::LimitExceeded);
        }
        Ok(())
    }
}

impl Default for NostrLimits {
    fn default() -> Self {
        Self::HARD
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct NostrVerifyConfig {
    pub community_id: [u8; 16],
    pub instance_domain: [u8; 32],
    pub relay_pubkey: [u8; 32],
    pub allowed_variants: u8,
    pub limits: NostrLimits,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct NostrAnchor {
    pub node_id: B256,
    pub head: B256,
    pub count: u64,
    pub data_commitment: B256,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[repr(u8)]
pub enum SkipReason {
    MalformedEvent = 1,
    UnknownKind = 2,
    OaMalformed = 3,
    OaInvalidSignature = 4,
    OaWindowViolation = 5,
    OaSelfOwned = 6,
    OaAmbiguous = 7,
    LwwSuperseded = 8,
    DeletionTombstoned = 9,
    InvalidDeletion = 10,
    RosterNonMember = 11,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum EventDisposition {
    Accepted,
    Skipped(SkipReason),
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct EventOutcome {
    pub event: NostrEvent,
    pub oa_owner: Option<[u8; 32]>,
    pub disposition: EventDisposition,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct VerifiedNostrEnvelope {
    pub variant: CommitmentVariant,
    pub node_id: B256,
    pub head: B256,
    pub count: u64,
    pub data_commitment: B256,
    pub outcomes: Vec<EventOutcome>,
    pub roster: Vec<[u8; 32]>,
    pub accepted_events_digest: B256,
    pub skipped_digest: B256,
}

/// Cross-head cryptographic cache used by the production computation.
///
/// An event id may be present in both an Option-A audit and an Option-C log. Exact duplicates reuse
/// their NIP-01 and NIP-OA results; a different event carrying an already-seen id invalidates that
/// candidate head.
#[derive(Clone, Debug, Default)]
pub struct VerificationCache {
    verified_events: BTreeMap<[u8; 32], NostrEvent>,
    oa_results: BTreeMap<[u8; 32], Result<Option<[u8; 32]>, SkipReason>>,
    event_verifications: usize,
    oa_verifications: usize,
}

impl VerificationCache {
    pub fn event_verifications(&self) -> usize {
        self.event_verifications
    }

    pub fn oa_verifications(&self) -> usize {
        self.oa_verifications
    }

    fn verify_event(&mut self, candidate: &NostrEvent) -> Result<(), NostrError> {
        if let Some(verified) = self.verified_events.get(&candidate.id) {
            return if verified == candidate { Ok(()) } else { Err(NostrError::DuplicateEvent) };
        }
        self.event_verifications =
            self.event_verifications.checked_add(1).ok_or(NostrError::LimitExceeded)?;
        event::verify(candidate)?;
        self.verified_events.insert(candidate.id, candidate.clone());
        Ok(())
    }

    fn owner_for_event(&mut self, event: &NostrEvent) -> Result<Option<[u8; 32]>, SkipReason> {
        if let Some(result) = self.oa_results.get(&event.id) {
            return *result;
        }
        let attempts =
            event.tags.iter().filter(|tag| tag.first().map(String::as_str) == Some("auth")).count();
        self.oa_verifications = self.oa_verifications.saturating_add(attempts);
        let result = oa::owner_for_event(event);
        self.oa_results.insert(event.id, result);
        result
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum NostrError {
    Malformed,
    UnsupportedVariant,
    VariantNotAllowed,
    LimitExceeded,
    TrailingBytes,
    NonCanonicalEncoding,
    NonCanonicalAuditDetail,
    IdentityMismatch,
    DataCommitmentMismatch,
    HeadMismatch,
    CountMismatch,
    AuditSequence,
    AuditPreviousHash,
    AuditHash,
    UnknownAuditAction,
    BadAuditDetail,
    MissingEvent,
    DuplicateEvent,
    UnexpectedDirectEvent,
    BadEventId,
    BadEventSignature,
    BadOa,
    BadRoster,
    BadSelfLogHead,
}

pub fn nostr_node_id(pubkey: &[u8; 32]) -> B256 {
    let mut preimage = Vec::with_capacity(10 + 64);
    preimage.extend_from_slice(b"did:nostr:");
    event::encode_hex(pubkey, &mut preimage);
    keccak256(preimage)
}

fn uuid_text(uuid: &[u8; 16]) -> String {
    let hex = lowercase_hex(uuid);
    format!("{}-{}-{}-{}-{}", &hex[0..8], &hex[8..12], &hex[12..16], &hex[16..20], &hex[20..32])
}

pub fn community_node_id(community_id: &[u8; 16]) -> B256 {
    keccak256(format!("buzz:community:{}", uuid_text(community_id)).as_bytes())
}

pub fn estimated_pgu(
    bundle_bytes: u64,
    audit_entries: u64,
    nip01_signatures: u64,
    oa_signatures: u64,
) -> Option<u64> {
    24u64
        .checked_mul(bundle_bytes)?
        .checked_add(12_000u64.checked_mul(audit_entries)?)?
        .checked_add(71_000u64.checked_mul(nip01_signatures)?)?
        .checked_add(62_000u64.checked_mul(oa_signatures)?)?
        .checked_add(1_000_000)?
        .checked_mul(2)
}

fn variant_allowed(config: &NostrVerifyConfig, variant: CommitmentVariant) -> bool {
    let bit = match variant {
        CommitmentVariant::BuzzAuditV1 => BUZZ_AUDIT_BITMAP,
        CommitmentVariant::SelfLogV1 => SELF_LOG_BITMAP,
    };
    config.allowed_variants & bit != 0
}

fn verify_all_events(
    bundle: &TgnwBundle,
    limits: &NostrLimits,
    cache: &mut VerificationCache,
) -> Result<(), NostrError> {
    let count = bundle.events.len() + usize::from(bundle.head_event.is_some());
    if count > limits.nip01_signatures as usize {
        return Err(NostrError::LimitExceeded);
    }
    let mut ids = BTreeSet::new();
    for event in bundle.events.iter().chain(bundle.head_event.iter()) {
        if !ids.insert(event.id) {
            return Err(NostrError::DuplicateEvent);
        }
        cache.verify_event(event)?;
    }
    Ok(())
}

fn auth_tag_count(bundle: &TgnwBundle) -> usize {
    bundle
        .events
        .iter()
        .chain(bundle.head_event.iter())
        .flat_map(|event| &event.tags)
        .filter(|tag| tag.first().map(String::as_str) == Some("auth"))
        .count()
}

fn audit_event_order(bundle: &TgnwBundle) -> Result<Vec<NostrEvent>, NostrError> {
    let by_id: BTreeMap<_, _> = bundle.events.iter().map(|event| (event.id, event)).collect();
    let mut ordered = Vec::with_capacity(bundle.events.len());
    let mut audited = BTreeSet::new();
    for entry in &bundle.audit {
        if entry.action != 0 {
            continue;
        }
        let object = entry.object_id.as_ref().ok_or(NostrError::MissingEvent)?;
        let id = decode_hex::<32>(object).map_err(|_| NostrError::MissingEvent)?;
        if !audited.insert(id) {
            return Err(NostrError::DuplicateEvent);
        }
        let event = by_id.get(&id).copied().ok_or(NostrError::MissingEvent)?;
        if entry.actor_pubkey != Some(event.pubkey) {
            return Err(NostrError::BadAuditDetail);
        }
        let detail: Value =
            serde_json::from_str(&entry.detail).map_err(|_| NostrError::BadAuditDetail)?;
        let fields = detail.as_object().ok_or(NostrError::BadAuditDetail)?;
        if fields.len() != 2
            || fields.get("event_kind").and_then(Value::as_u64) != Some(u64::from(event.kind))
            || !fields.contains_key("channel_id")
        {
            return Err(NostrError::BadAuditDetail);
        }
        ordered.push(event.clone());
    }
    for event in &bundle.events {
        if audited.contains(&event.id) {
            continue;
        }
        if !matches!(event.kind, 13_534 | 40_099 | 44_100) {
            return Err(NostrError::UnexpectedDirectEvent);
        }
        ordered.push(event.clone());
    }
    Ok(ordered)
}

fn sole_tag<'a>(event: &'a NostrEvent, name: &str) -> Result<&'a [String], NostrError> {
    let tags: Vec<_> =
        event.tags.iter().filter(|tag| tag.first().map(String::as_str) == Some(name)).collect();
    if tags.len() != 1 {
        return Err(NostrError::BadSelfLogHead);
    }
    Ok(tags[0])
}

fn self_log_head(instance_domain: &[u8; 32], author: &[u8; 32], events: &[NostrEvent]) -> [u8; 32] {
    let mut genesis = Sha256::new();
    genesis.update(b"trustgraphs.nostr.self-log.genesis.v1");
    genesis.update(instance_domain);
    genesis.update(author);
    let mut head: [u8; 32] = genesis.finalize().into();
    for (index, event) in events.iter().enumerate() {
        let mut hasher = Sha256::new();
        hasher.update(b"trustgraphs.nostr.self-log.entry.v1");
        hasher.update(instance_domain);
        hasher.update(author);
        hasher.update(((index + 1) as u64).to_be_bytes());
        hasher.update(head);
        hasher.update(event.id);
        head = hasher.finalize().into();
    }
    head
}

fn verify_self_log(
    bundle: &TgnwBundle,
    anchor: &NostrAnchor,
    cache: &mut VerificationCache,
) -> Result<Vec<EventOutcome>, NostrError> {
    if bundle.events.iter().any(|event| event.pubkey != bundle.authority) {
        return Err(NostrError::IdentityMismatch);
    }
    let computed_head = self_log_head(&bundle.instance_domain, &bundle.authority, &bundle.events);
    if B256::from(computed_head) != anchor.head || bundle.events.len() as u64 != anchor.count {
        return Err(NostrError::HeadMismatch);
    }
    let head_event = bundle.head_event.as_ref().ok_or(NostrError::BadSelfLogHead)?;
    if head_event.pubkey != bundle.authority
        || head_event.kind != 36_384
        || !head_event.content.is_empty()
        || head_event.tags.len() != 4
    {
        return Err(NostrError::BadSelfLogHead);
    }
    let d = sole_tag(head_event, "d")?;
    let commitment = sole_tag(head_event, "commitment")?;
    let head = sole_tag(head_event, "head")?;
    let count = sole_tag(head_event, "count")?;
    let expected_domain = lowercase_hex(&bundle.instance_domain);
    let expected_head = lowercase_hex(&computed_head);
    if d.len() != 2
        || d[0] != "d"
        || d[1] != expected_domain
        || commitment.len() != 2
        || commitment[0] != "commitment"
        || commitment[1] != "self-log-v1"
        || head.len() != 2
        || head[0] != "head"
        || head[1] != expected_head
        || count.len() != 2
        || count[0] != "count"
        || count[1].parse::<u64>() != Ok(anchor.count)
        || (count[1].len() > 1 && count[1].starts_with('0'))
    {
        return Err(NostrError::BadSelfLogHead);
    }

    let outcomes = bundle
        .events
        .iter()
        .cloned()
        .map(|event| match cache.owner_for_event(&event) {
            Ok(owner) => {
                EventOutcome { event, oa_owner: owner, disposition: EventDisposition::Accepted }
            }
            Err(reason) => EventOutcome {
                event,
                oa_owner: None,
                disposition: EventDisposition::Skipped(reason),
            },
        })
        .collect::<Vec<_>>();
    Ok(outcomes)
}

pub fn verify(
    anchor: &NostrAnchor,
    config: &NostrVerifyConfig,
    bytes: &[u8],
) -> Result<VerifiedNostrEnvelope, NostrError> {
    verify_cached(anchor, config, bytes, &mut VerificationCache::default())
}

pub fn verify_cached(
    anchor: &NostrAnchor,
    config: &NostrVerifyConfig,
    bytes: &[u8],
    cache: &mut VerificationCache,
) -> Result<VerifiedNostrEnvelope, NostrError> {
    config.limits.validate()?;
    let commitment: [u8; 32] = Sha256::digest(bytes).into();
    if B256::from(commitment) != anchor.data_commitment {
        return Err(NostrError::DataCommitmentMismatch);
    }
    let bundle = tgnw::decode(bytes, &config.limits)?;
    if tgnw::encode(&bundle)?.as_slice() != bytes {
        return Err(NostrError::NonCanonicalEncoding);
    }
    if bundle.community_id != config.community_id
        || bundle.instance_domain != config.instance_domain
        || !variant_allowed(config, bundle.variant)
    {
        return Err(if !variant_allowed(config, bundle.variant) {
            NostrError::VariantNotAllowed
        } else {
            NostrError::IdentityMismatch
        });
    }
    verify_all_events(&bundle, &config.limits, cache)?;
    if auth_tag_count(&bundle) > config.limits.oa_signatures as usize {
        return Err(NostrError::LimitExceeded);
    }

    let (outcomes, roster) = match bundle.variant {
        CommitmentVariant::BuzzAuditV1 => {
            if bundle.authority != config.relay_pubkey
                || anchor.node_id != community_node_id(&bundle.community_id)
            {
                return Err(NostrError::IdentityMismatch);
            }
            if bundle.audit.len() as u64 != anchor.count {
                return Err(NostrError::CountMismatch);
            }
            let head = verify_prefix(&bundle.community_id, &bundle.audit)?;
            if B256::from(head) != anchor.head {
                return Err(NostrError::HeadMismatch);
            }
            let ordered = audit_event_order(&bundle)?;
            let (outcomes, roster) = state::resolve_cached(ordered, &config.relay_pubkey, cache)?;
            (outcomes, roster.into_iter().collect())
        }
        CommitmentVariant::SelfLogV1 => {
            if anchor.node_id != nostr_node_id(&bundle.authority) {
                return Err(NostrError::IdentityMismatch);
            }
            (verify_self_log(&bundle, anchor, cache)?, Vec::new())
        }
    };
    let (accepted, skipped) = state::outcome_digests(&outcomes);
    Ok(VerifiedNostrEnvelope {
        variant: bundle.variant,
        node_id: anchor.node_id,
        head: anchor.head,
        count: anchor.count,
        data_commitment: anchor.data_commitment,
        outcomes,
        roster,
        accepted_events_digest: B256::from(accepted),
        skipped_digest: B256::from(skipped),
    })
}
