use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use alloy_primitives::{keccak256, Address, B256, U256};
use anyhow::{bail, ensure, Context, Result};
use buzz_audit::{compute_hash, AuditAction, AuditEntry};
use buzz_sdk::{
    build_forum_post, build_git_patch, build_git_status, build_vote, GitAppliedPatchRef,
    GitPatchMeta, GitRepoCoord, GitStatus, GitStatusMeta, VoteDirection,
};
use chrono::{DateTime, Utc};
use k256::ecdsa::SigningKey;
use nostr::hashes::{sha256::Hash as NostrSha256, Hash as _};
use nostr::secp256k1::rand::{rngs::StdRng, SeedableRng};
use nostr::secp256k1::{Message, SECP256K1};
use nostr::{Event, EventBuilder, EventId, Keys, Kind, PublicKey, SecretKey, Tag, Timestamp};
use serde::Serialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use uuid::Uuid;

const BUZZ_SHA: &str = "a362fecc2389955f942c9581bdfeba379ab115b3";
const PATCH_SHA256: &str = "3129e43e7b8967635bde8dd4a084613ef8628146dd1d1ba2f62e41ced4762a62";
const DEFAULT_COMMUNITY: &str = "01915f7a-6b4c-7d2e-8f10-112233445566";
const DEFAULT_CHANNEL: &str = "01915f7a-6b4c-7d2e-8f10-665544332211";
const INSTANCE_DOMAIN: [u8; 32] = [0x42; 32];
const DEFAULT_BASE_TIME: u64 = 1_760_000_000;

fn configured_base_time() -> Result<u64> {
    std::env::var("TG_BUZZ_FIXTURE_BASE_TIME")
        .map(|value| value.parse().context("TG_BUZZ_FIXTURE_BASE_TIME must be a u64"))
        .unwrap_or(Ok(DEFAULT_BASE_TIME))
}

fn configured_uuid(variable: &str, default: &str) -> Result<Uuid> {
    let value = std::env::var(variable).unwrap_or_else(|_| default.to_owned());
    Uuid::parse_str(&value).with_context(|| format!("{variable} must be a UUID"))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Corpus {
    format: &'static str,
    generated_by: &'static str,
    buzz_sha: &'static str,
    compatibility_patch_sha256: &'static str,
    rust_nostr: &'static str,
    community_id: Uuid,
    channel_id: Uuid,
    instance_domain: String,
    principals: BTreeMap<&'static str, String>,
    published_oa_vector: PublishedOaVector,
    oa_condition_cases: Vec<OaConditionCase>,
    serializer_vectors: Vec<FixtureEvent>,
    events: Vec<FixtureEvent>,
    audit_prefix: Vec<FixtureAuditEntry>,
    direct_event_rows: Vec<String>,
    envelopes: Vec<EnvelopeArtifact>,
    replacement_expectations: Vec<ReplacementExpectation>,
    self_logs: Vec<SelfLogFixture>,
    adversarial: Vec<AdversarialCase>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PublishedOaVector {
    owner_pubkey: &'static str,
    agent_pubkey: &'static str,
    conditions: &'static str,
    preimage: String,
    sha256: &'static str,
    signature: &'static str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct OaConditionCase {
    conditions: &'static str,
    grammar_valid: bool,
    event_kind: u16,
    created_at: u64,
    applies: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct FixtureEvent {
    name: String,
    source: String,
    nip01_preimage: String,
    nip01_preimage_hex: String,
    event: Event,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct FixtureAuditEntry {
    community_id: Uuid,
    seq: i64,
    hash: String,
    prev_hash: Option<String>,
    action: String,
    actor_pubkey: Option<String>,
    object_id: Option<String>,
    detail: Value,
    created_at: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct EnvelopeArtifact {
    name: &'static str,
    file: &'static str,
    variant: u8,
    bytes: usize,
    sha256: String,
    audit_count: usize,
    event_count: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ReplacementExpectation {
    name: &'static str,
    coordinate: String,
    candidates: Vec<String>,
    winner: String,
    rule: &'static str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SelfLogFixture {
    author: String,
    entry_event_ids: Vec<String>,
    head: String,
    count: u64,
    head_event_id: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AdversarialCase {
    name: &'static str,
    expected: &'static str,
    reason: &'static str,
    event: Option<FixtureEvent>,
    mutation: Option<Value>,
}

struct Principals {
    relay: Keys,
    alice: Keys,
    bob: Keys,
    agent: Keys,
    outsider_owner: Keys,
    outsider_agent: Keys,
}

fn keys(byte: u8) -> Result<Keys> {
    let secret = SecretKey::from_slice(&[byte; 32]).context("fixed Nostr fixture secret")?;
    Ok(Keys::new(secret))
}

fn principals() -> Result<Principals> {
    Ok(Principals {
        relay: keys(1)?,
        alice: keys(2)?,
        bob: keys(3)?,
        agent: keys(4)?,
        outsider_owner: keys(5)?,
        outsider_agent: keys(6)?,
    })
}

fn deterministic_sign(
    builder: EventBuilder,
    signer: &Keys,
    created_at: u64,
    seed: u8,
) -> Result<Event> {
    let unsigned =
        builder.custom_created_at(Timestamp::from(created_at)).build(signer.public_key());
    let mut rng = StdRng::from_seed([seed; 32]);
    let event = unsigned
        .sign_with_ctx(SECP256K1, &mut rng, signer)
        .context("signing deterministic Nostr event")?;
    event.verify().context("rust-nostr event verification")?;
    Ok(event)
}

fn tag(parts: &[&str]) -> Result<Tag> {
    Tag::parse(parts.iter().copied()).context("constructing fixture tag")
}

fn raw_event(
    kind: u16,
    tags: Vec<Tag>,
    content: impl Into<String>,
    signer: &Keys,
    created_at: u64,
    seed: u8,
) -> Result<Event> {
    deterministic_sign(
        EventBuilder::new(Kind::Custom(kind), content.into()).tags(tags).allow_self_tagging(),
        signer,
        created_at,
        seed,
    )
}

fn nip01_preimage(event: &Event) -> Result<String> {
    serde_json::to_string(&json!([
        0,
        event.pubkey,
        event.created_at,
        event.kind,
        event.tags,
        event.content
    ]))
    .context("serializing NIP-01 preimage")
}

fn fixture_event(
    name: impl Into<String>,
    source: impl Into<String>,
    event: Event,
) -> Result<FixtureEvent> {
    let preimage = nip01_preimage(&event)?;
    let digest = Sha256::digest(preimage.as_bytes());
    if digest.as_slice() != event.id.as_bytes() {
        bail!("rust-nostr preimage digest does not match event id");
    }
    Ok(FixtureEvent {
        name: name.into(),
        source: source.into(),
        nip01_preimage_hex: hex::encode(preimage.as_bytes()),
        nip01_preimage: preimage,
        event,
    })
}

fn oa_tag_unchecked(owner: &Keys, agent: &Keys, conditions: &str, seed: u8) -> Result<Tag> {
    let preimage = format!("nostr:agent-auth:{}:{conditions}", agent.public_key().to_hex());
    let digest = NostrSha256::hash(preimage.as_bytes());
    let message = Message::from_digest(digest.to_byte_array());
    let mut rng = StdRng::from_seed([seed; 32]);
    let signature = owner.sign_schnorr_with_ctx(SECP256K1, &message, &mut rng);
    let tag = tag(&["auth", &owner.public_key().to_hex(), conditions, &signature.to_string()])?;
    Ok(tag)
}

fn oa_tag(owner: &Keys, agent: &Keys, conditions: &str, seed: u8) -> Result<Tag> {
    let tag = oa_tag_unchecked(owner, agent, conditions, seed)?;
    let tag_json = serde_json::to_string(&tag).context("serializing OA tag")?;
    let recovered = buzz_sdk::nip_oa::verify_auth_tag(&tag_json, &agent.public_key())
        .context("Buzz OA verification")?;
    if recovered != owner.public_key() {
        bail!("Buzz OA verification recovered the wrong owner");
    }
    Ok(tag)
}

fn conditions_apply(conditions: &str, kind: u16, created_at: u64) -> bool {
    if conditions.is_empty() {
        return true;
    }
    conditions.split('&').all(|clause| {
        if let Some(value) = clause.strip_prefix("kind=") {
            value.parse::<u16>() == Ok(kind)
        } else if let Some(value) = clause.strip_prefix("created_at<") {
            value.parse::<u64>().is_ok_and(|bound| created_at < bound)
        } else if let Some(value) = clause.strip_prefix("created_at>") {
            value.parse::<u64>().is_ok_and(|bound| created_at > bound)
        } else {
            false
        }
    })
}

fn binding_digest(
    did: &str,
    address: Address,
    chain_id: U256,
    timestamp: U256,
    nonce: U256,
) -> B256 {
    let domain_typehash = keccak256(b"EIP712Domain(string name,string version,uint256 chainId)");
    let mut domain = Vec::with_capacity(32 * 4);
    domain.extend_from_slice(domain_typehash.as_slice());
    domain.extend_from_slice(keccak256(b"IdentityLink").as_slice());
    domain.extend_from_slice(keccak256(b"1").as_slice());
    domain.extend_from_slice(&chain_id.to_be_bytes::<32>());
    let domain_separator = keccak256(domain);

    let struct_typehash = keccak256(
        b"LinkAttestation(string did,address evmAddress,uint256 chainId,uint256 timestamp,uint256 nonce)",
    );
    let mut body = Vec::with_capacity(32 * 6);
    body.extend_from_slice(struct_typehash.as_slice());
    body.extend_from_slice(keccak256(did.as_bytes()).as_slice());
    let mut address_word = [0u8; 32];
    address_word[12..].copy_from_slice(address.as_slice());
    body.extend_from_slice(&address_word);
    body.extend_from_slice(&chain_id.to_be_bytes::<32>());
    body.extend_from_slice(&timestamp.to_be_bytes::<32>());
    body.extend_from_slice(&nonce.to_be_bytes::<32>());
    let struct_hash = keccak256(body);

    let mut preimage = Vec::with_capacity(66);
    preimage.extend_from_slice(&[0x19, 0x01]);
    preimage.extend_from_slice(domain_separator.as_slice());
    preimage.extend_from_slice(struct_hash.as_slice());
    keccak256(preimage)
}

fn binding_content(author: PublicKey, base_time: u64) -> Result<(String, String)> {
    let wallet = SigningKey::from_slice(&[7u8; 32]).context("fixed EVM fixture secret")?;
    let uncompressed = wallet.verifying_key().to_encoded_point(false);
    let wallet_hash = keccak256(&uncompressed.as_bytes()[1..]);
    let address = Address::from_slice(&wallet_hash.as_slice()[12..]);
    let address_hex = format!("0x{}", hex::encode(address.as_slice()));
    let chain_id = U256::from(31_337u64);
    let timestamp = U256::from(base_time + 11);
    let nonce = U256::from(1u64);
    let did = format!("did:nostr:{}", author.to_hex());
    let digest = binding_digest(&did, address, chain_id, timestamp, nonce);
    let (signature, recovery_id) = wallet
        .sign_prehash_recoverable(digest.as_slice())
        .context("signing EIP-712 fixture binding")?;
    let normalized = signature.normalize_s().unwrap_or(signature);
    let mut recovery = recovery_id;
    for candidate in 0..=1 {
        let candidate = k256::ecdsa::RecoveryId::from_byte(candidate).expect("0/1 recovery id");
        if let Ok(recovered) = k256::ecdsa::VerifyingKey::recover_from_prehash(
            digest.as_slice(),
            &normalized,
            candidate,
        ) {
            if recovered == *wallet.verifying_key() {
                recovery = candidate;
                break;
            }
        }
    }
    let mut sig65 = normalized.to_bytes().to_vec();
    sig65.push(recovery.to_byte());
    let signature_hex = format!("0x{}", hex::encode(sig65));
    let content = format!(
        "{{\"address\":\"{address_hex}\",\"chainId\":\"31337\",\"timestamp\":\"{}\",\"nonce\":\"1\",\"signature\":\"{signature_hex}\"}}",
        base_time + 11
    );
    Ok((address_hex, content))
}

fn self_log_head(author: PublicKey, entries: &[EventId]) -> [u8; 32] {
    let mut genesis = Sha256::new();
    genesis.update(b"trustgraphs.nostr.self-log.genesis.v1");
    genesis.update(INSTANCE_DOMAIN);
    genesis.update(author.to_bytes());
    let mut head: [u8; 32] = genesis.finalize().into();
    for (index, event_id) in entries.iter().enumerate() {
        let mut hasher = Sha256::new();
        hasher.update(b"trustgraphs.nostr.self-log.entry.v1");
        hasher.update(INSTANCE_DOMAIN);
        hasher.update(author.to_bytes());
        hasher.update(((index + 1) as u64).to_be_bytes());
        hasher.update(head);
        hasher.update(event_id.as_bytes());
        head = hasher.finalize().into();
    }
    head
}

fn audit_entry(
    community_id: Uuid,
    seq: i64,
    prev_hash: Option<Vec<u8>>,
    event: &Event,
    channel_id: Option<Uuid>,
    base_time: u64,
) -> Result<(AuditEntry, FixtureAuditEntry)> {
    let created_at = DateTime::<Utc>::from_timestamp(base_time as i64 + 100 + seq, 123_456_000)
        .context("fixed audit timestamp")?;
    let mut entry = AuditEntry {
        community_id,
        seq,
        hash: Vec::new(),
        prev_hash,
        action: AuditAction::EventCreated,
        actor_pubkey: Some(event.pubkey.to_bytes().to_vec()),
        object_id: Some(event.id.to_hex()),
        detail: json!({
            "event_kind": event.kind.as_u16() as u32,
            "channel_id": channel_id,
        }),
        created_at,
    };
    entry.hash = compute_hash(&entry).context("Buzz audit hash")?.to_vec();
    let fixture = FixtureAuditEntry {
        community_id: entry.community_id,
        seq: entry.seq,
        hash: hex::encode(&entry.hash),
        prev_hash: entry.prev_hash.as_ref().map(hex::encode),
        action: entry.action.to_string(),
        actor_pubkey: entry.actor_pubkey.as_ref().map(hex::encode),
        object_id: entry.object_id.clone(),
        detail: entry.detail.clone(),
        created_at: entry.created_at.to_rfc3339(),
    };
    Ok((entry, fixture))
}

fn deletion(target_tag: &str, target: &str, signer: &Keys, time: u64, seed: u8) -> Result<Event> {
    raw_event(5, vec![tag(&[target_tag, target])?], "", signer, time, seed)
}

fn push_u32(output: &mut Vec<u8>, value: usize) -> Result<()> {
    output
        .extend_from_slice(&u32::try_from(value).context("TGNW length exceeds u32")?.to_be_bytes());
    Ok(())
}

fn push_string(output: &mut Vec<u8>, value: &str) -> Result<()> {
    push_u32(output, value.len())?;
    output.extend_from_slice(value.as_bytes());
    Ok(())
}

fn canonical_json(value: &Value) -> Result<String> {
    match value {
        Value::Object(map) => {
            let sorted: BTreeMap<&str, &Value> =
                map.iter().map(|(key, value)| (key.as_str(), value)).collect();
            let mut output = String::from("{");
            for (index, (key, value)) in sorted.into_iter().enumerate() {
                if index != 0 {
                    output.push(',');
                }
                output.push_str(&serde_json::to_string(key)?);
                output.push(':');
                output.push_str(&canonical_json(value)?);
            }
            output.push('}');
            Ok(output)
        }
        Value::Array(values) => {
            let mut output = String::from("[");
            for (index, value) in values.iter().enumerate() {
                if index != 0 {
                    output.push(',');
                }
                output.push_str(&canonical_json(value)?);
            }
            output.push(']');
            Ok(output)
        }
        scalar => Ok(serde_json::to_string(scalar)?),
    }
}

fn action_code(action: &AuditAction) -> u8 {
    match action {
        AuditAction::EventCreated => 0,
        AuditAction::EventDeleted => 1,
        AuditAction::ChannelCreated => 2,
        AuditAction::ChannelUpdated => 3,
        AuditAction::ChannelDeleted => 4,
        AuditAction::MemberAdded => 5,
        AuditAction::MemberRemoved => 6,
        AuditAction::AuthSuccess => 7,
        AuditAction::AuthFailure => 8,
        AuditAction::RateLimitExceeded => 9,
        AuditAction::MediaUploaded => 10,
    }
}

fn encode_audit(output: &mut Vec<u8>, entry: &AuditEntry) -> Result<()> {
    output.extend_from_slice(&u64::try_from(entry.seq)?.to_be_bytes());
    ensure_len(&entry.hash, 32, "audit hash")?;
    output.extend_from_slice(&entry.hash);
    match &entry.prev_hash {
        Some(previous) => {
            ensure_len(previous, 32, "audit prev_hash")?;
            output.push(1);
            output.extend_from_slice(previous);
        }
        None => output.push(0),
    }
    output.push(action_code(&entry.action));
    match &entry.actor_pubkey {
        Some(actor) => {
            ensure_len(actor, 32, "audit actor")?;
            output.push(1);
            output.extend_from_slice(actor);
        }
        None => output.push(0),
    }
    match &entry.object_id {
        Some(object) => {
            output.push(1);
            push_string(output, object)?;
        }
        None => output.push(0),
    }
    push_string(output, &entry.created_at.to_rfc3339())?;
    push_string(output, &canonical_json(&entry.detail)?)?;
    Ok(())
}

fn ensure_len(value: &[u8], length: usize, label: &str) -> Result<()> {
    ensure!(value.len() == length, "{label} must be {length} bytes");
    Ok(())
}

fn encode_event(output: &mut Vec<u8>, event: &Event) -> Result<()> {
    output.extend_from_slice(event.id.as_bytes());
    output.extend_from_slice(&event.pubkey.to_bytes());
    output.extend_from_slice(&event.created_at.as_secs().to_be_bytes());
    output.extend_from_slice(&(event.kind.as_u16() as u32).to_be_bytes());
    push_u32(output, event.tags.len())?;
    for tag in event.tags.iter() {
        push_u32(output, tag.as_slice().len())?;
        for element in tag.as_slice() {
            push_string(output, element)?;
        }
    }
    push_string(output, &event.content)?;
    output.extend_from_slice(event.sig.as_ref());
    Ok(())
}

fn encode_prefix(
    variant: u8,
    community_id: Uuid,
    instance_domain: [u8; 32],
    authority: PublicKey,
) -> Vec<u8> {
    let mut output = Vec::new();
    output.extend_from_slice(b"TGNW");
    output.push(1);
    output.push(variant);
    output.extend_from_slice(&0u16.to_be_bytes());
    output.extend_from_slice(community_id.as_bytes());
    output.extend_from_slice(&instance_domain);
    output.extend_from_slice(&authority.to_bytes());
    output
}

fn encode_option_a(
    community_id: Uuid,
    authority: PublicKey,
    audit: &[AuditEntry],
    events: &[FixtureEvent],
) -> Result<Vec<u8>> {
    let mut output = encode_prefix(1, community_id, INSTANCE_DOMAIN, authority);
    push_u32(&mut output, audit.len())?;
    for entry in audit {
        encode_audit(&mut output, entry)?;
    }
    push_u32(&mut output, events.len())?;
    for fixture in events {
        encode_event(&mut output, &fixture.event)?;
    }
    ensure!(output.len() <= 12_582_912, "Option-A fixture exceeds TGNW cap");
    Ok(output)
}

fn encode_option_c(
    community_id: Uuid,
    authority: PublicKey,
    entries: &[Event],
    head_event: &Event,
) -> Result<Vec<u8>> {
    let mut output = encode_prefix(2, community_id, INSTANCE_DOMAIN, authority);
    push_u32(&mut output, entries.len())?;
    for event in entries {
        encode_event(&mut output, event)?;
    }
    encode_event(&mut output, head_event)?;
    ensure!(output.len() <= 12_582_912, "Option-C fixture exceeds TGNW cap");
    Ok(output)
}

fn write_artifact(directory: &Path, file: &str, bytes: &[u8]) -> Result<()> {
    std::fs::write(directory.join(file), bytes)
        .with_context(|| format!("writing generated TGNW artifact {file}"))
}

fn main() -> Result<()> {
    let output = std::env::args_os()
        .nth(1)
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("../source-corpus.json"));
    let p = principals()?;
    let community_id = configured_uuid("TG_BUZZ_FIXTURE_COMMUNITY", DEFAULT_COMMUNITY)?;
    let channel_id = configured_uuid("TG_BUZZ_FIXTURE_CHANNEL", DEFAULT_CHANNEL)?;
    let channel = channel_id.to_string();
    let base_time = configured_base_time()?;
    let alice = p.alice.public_key().to_hex();
    let bob = p.bob.public_key().to_hex();
    let agent = p.agent.public_key().to_hex();
    let added_member = p.outsider_owner.public_key().to_hex();
    let epoch_two = std::env::var("TG_BUZZ_FIXTURE_EPOCH").as_deref() == Ok("2");

    let oa_case_specs = [
        ("", true, 0, 0, true),
        ("kind=0", true, 0, 0, true),
        ("kind=65535", true, 65_535, 0, true),
        ("kind=65535", true, 65_534, 0, false),
        ("created_at>0", true, 1, 1, true),
        ("created_at>0", true, 1, 0, false),
        ("created_at>4294967295", true, 1, 4_294_967_295, false),
        ("created_at>4294967295", true, 1, 4_294_967_296, true),
        ("created_at<0", true, 1, 0, false),
        ("created_at<4294967295", true, 1, 4_294_967_294, true),
        ("created_at<4294967295", true, 1, 4_294_967_295, false),
        ("kind=1&created_at>99&created_at<101", true, 1, 100, true),
        ("kind=01", false, 1, 0, false),
        ("kind=65536", false, 1, 0, false),
        ("created_at<4294967296", false, 1, 0, false),
        ("created_at>00", false, 1, 1, false),
        ("kind=1&", false, 1, 0, false),
        ("foo=1", false, 1, 0, false),
    ];
    let mut oa_condition_cases = Vec::new();
    for (index, (conditions, grammar_valid, event_kind, created_at, applies)) in
        oa_case_specs.into_iter().enumerate()
    {
        let test_tag = oa_tag_unchecked(&p.alice, &p.agent, conditions, (100 + index) as u8)?;
        let tag_json = serde_json::to_string(&test_tag)?;
        let accepted = buzz_sdk::nip_oa::verify_auth_tag(&tag_json, &p.agent.public_key()).is_ok();
        if accepted != grammar_valid {
            bail!("Buzz OA grammar result changed for {conditions:?}");
        }
        if grammar_valid && conditions_apply(conditions, event_kind, created_at) != applies {
            bail!("fixture OA application expectation is inconsistent for {conditions:?}");
        }
        oa_condition_cases.push(OaConditionCase {
            conditions,
            grammar_valid,
            event_kind,
            created_at,
            applies,
        });
    }

    let serializer_max = raw_event(
        u16::MAX,
        vec![tag(&["max", "18446744073709551615"])?],
        "",
        &p.bob,
        u64::MAX,
        200,
    )?;
    let controls: String = (0u8..=31).map(char::from).collect();
    let serializer_controls = raw_event(
        1,
        vec![tag(&["x", &format!("tag:{controls}:\"\\:雪:🦀")])?],
        format!("content:{controls}:\"\\:雪:🦀"),
        &p.alice,
        base_time + 1,
        2,
    )?;
    let serializer_vectors = vec![
        fixture_event(
            "nip01-maximum-integers",
            "rust-nostr 0.44 EventId::new serializer; not relay-ingestable due timestamp drift",
            serializer_max,
        )?,
        fixture_event(
            "nip01-controls-unicode",
            "rust-nostr 0.44 EventId::new serializer; PostgreSQL jsonb rejects the NUL escape",
            serializer_controls,
        )?,
    ];

    let mut events = Vec::new();
    let roster = raw_event(
        13_534,
        vec![tag(&["-"])?, tag(&["member", &alice, "owner"])?, tag(&["member", &bob, "member"])?],
        "",
        &p.relay,
        base_time,
        1,
    )?;
    events.push(fixture_event(
        "relay-roster",
        "buzz-admin publish_membership_list_with_bump",
        roster,
    )?);

    let vouch_tie_a = raw_event(
        36_382,
        vec![tag(&["d", &bob])?, tag(&["weight", "25"])?],
        "",
        &p.alice,
        base_time + 2,
        3,
    )?;
    let vouch_tie_b = raw_event(
        36_382,
        vec![tag(&["d", &bob])?, tag(&["weight", "80"])?],
        "",
        &p.alice,
        base_time + 2,
        4,
    )?;
    events.push(fixture_event(
        "vouch-same-second-a",
        "Trustgraphs vouch schema over rust-nostr",
        vouch_tie_a.clone(),
    )?);
    events.push(fixture_event(
        "vouch-same-second-b",
        "Trustgraphs vouch schema over rust-nostr",
        vouch_tie_b.clone(),
    )?);

    let bob_vouch_alice = raw_event(
        36_382,
        vec![tag(&["d", &alice])?, tag(&["weight", "70"])?],
        "",
        &p.bob,
        base_time + 3,
        5,
    )?;
    events.push(fixture_event(
        "vouch-bob-alice",
        "Trustgraphs vouch schema over rust-nostr",
        bob_vouch_alice.clone(),
    )?);

    let deleted_by_e = raw_event(
        36_382,
        vec![tag(&["d", &agent])?, tag(&["weight", "40"])?],
        "",
        &p.alice,
        base_time + 4,
        6,
    )?;
    events.push(fixture_event(
        "vouch-deleted-by-e-target",
        "Trustgraphs vouch schema over rust-nostr",
        deleted_by_e.clone(),
    )?);
    events.push(fixture_event(
        "delete-vouch-by-e",
        "NIP-09 kind 5 with exact e target",
        deletion("e", &deleted_by_e.id.to_hex(), &p.alice, base_time + 5, 7)?,
    )?);

    let deleted_by_a = raw_event(
        36_382,
        vec![tag(&["d", &agent])?, tag(&["weight", "35"])?],
        "",
        &p.bob,
        base_time + 6,
        8,
    )?;
    events.push(fixture_event(
        "vouch-deleted-by-a-target",
        "Trustgraphs vouch schema over rust-nostr",
        deleted_by_a,
    )?);
    let bob_agent_coordinate = format!("36382:{bob}:{agent}");
    events.push(fixture_event(
        "delete-vouch-by-a",
        "NIP-09/NIP-33 coordinate deletion",
        deletion("a", &bob_agent_coordinate, &p.bob, base_time + 7, 9)?,
    )?);

    let agent_vouch_conditions =
        format!("kind=36382&created_at>{}&created_at<{}", base_time + 7, base_time + 9);
    let agent_vouch = raw_event(
        36_382,
        vec![
            tag(&["d", &bob])?,
            tag(&["weight", "65"])?,
            oa_tag(&p.alice, &p.agent, &agent_vouch_conditions, 10)?,
        ],
        "",
        &p.agent,
        base_time + 8,
        11,
    )?;
    events.push(fixture_event(
        "oa-agent-vouch",
        "Trustgraphs vouch schema plus buzz-sdk NIP-OA verifier",
        agent_vouch.clone(),
    )?);

    let self_vouch = raw_event(
        36_382,
        vec![tag(&["d", &alice])?, tag(&["weight", "90"])?],
        "",
        &p.alice,
        base_time + 9,
        12,
    )?;
    events.push(fixture_event(
        "self-vouch-inert",
        "Trustgraphs vouch schema; valid state but no graph edge",
        self_vouch,
    )?);

    let (binding_address, binding_json) = binding_content(p.alice.public_key(), base_time)?;
    let binding = raw_event(
        36_383,
        vec![tag(&["d", &binding_address])?],
        binding_json,
        &p.alice,
        base_time + 11,
        13,
    )?;
    events.push(fixture_event(
        "nostr-evm-binding",
        "IdentityLink v1 EIP-712 schema plus rust-nostr",
        binding,
    )?);

    // Deliberately keep repository owner Alice distinct from patch author Bob. The source builder
    // emits Alice's `p` hint, proving that G1 still derives its target from the signed root author.
    let repo = GitRepoCoord { owner: alice.clone(), id: "trustgraphs-fixture".into() };
    let patch = deterministic_sign(
        build_git_patch(
            &repo,
            "From fixture\n\nSigned patch body\n",
            &GitPatchMeta {
                root: true,
                commit: Some("0123456789abcdef0123456789abcdef01234567".into()),
                parent_commit: Some("89abcdef0123456789abcdef0123456789abcdef".into()),
                ..Default::default()
            },
        )?,
        &p.bob,
        base_time + 12,
        14,
    )?;
    events.push(fixture_event("git-patch-root", "buzz-sdk build_git_patch", patch.clone())?);
    let merged = deterministic_sign(
        build_git_status(
            GitStatus::AppliedOrResolved,
            "merged",
            &GitStatusMeta {
                root_event: patch.id.to_hex(),
                recipients: vec![bob.clone()],
                applied_patches: vec![GitAppliedPatchRef {
                    id: patch.id.to_hex(),
                    relay: None,
                    pubkey: None,
                }],
                merge_commit: Some("fedcba9876543210fedcba9876543210fedcba98".into()),
                ..Default::default()
            },
        )?,
        &p.alice,
        base_time + 13,
        15,
    )?;
    events.push(fixture_event(
        "git-status-merged",
        "buzz-sdk build_git_status(AppliedOrResolved)",
        merged,
    )?);

    let alice_post = deterministic_sign(
        build_forum_post(channel_id, "Alice fixture post", &[], &[])?,
        &p.alice,
        base_time + 14,
        16,
    )?;
    events.push(fixture_event(
        "forum-post-alice",
        "buzz-sdk build_forum_post",
        alice_post.clone(),
    )?);
    let bob_upvote = deterministic_sign(
        build_vote(channel_id, alice_post.id, VoteDirection::Up)?,
        &p.bob,
        base_time + 15,
        17,
    )?;
    events.push(fixture_event("forum-upvote-live", "buzz-sdk build_vote(Up)", bob_upvote)?);

    let bob_post = deterministic_sign(
        build_forum_post(channel_id, "Bob fixture post", &[], &[])?,
        &p.bob,
        base_time + 16,
        18,
    )?;
    events.push(fixture_event("forum-post-bob", "buzz-sdk build_forum_post", bob_post.clone())?);
    let alice_upvote = deterministic_sign(
        build_vote(channel_id, bob_post.id, VoteDirection::Up)?,
        &p.alice,
        base_time + 17,
        19,
    )?;
    events.push(fixture_event("forum-upvote-revoked", "buzz-sdk build_vote(Up)", alice_upvote)?);
    let alice_downvote = deterministic_sign(
        build_vote(channel_id, bob_post.id, VoteDirection::Down)?,
        &p.alice,
        base_time + 18,
        20,
    )?;
    events.push(fixture_event(
        "forum-downvote-clears-upvote",
        "buzz-sdk build_vote(Down)",
        alice_downvote,
    )?);

    let request = raw_event(
        43_001,
        vec![tag(&["h", channel.as_str()])?, tag(&["p", &agent])?],
        "Implement the bounded fixture exporter",
        &p.alice,
        base_time + 19,
        21,
    )?;
    events.push(fixture_event(
        "job-request-completed",
        "Trustgraphs J1 request profile over rust-nostr",
        request.clone(),
    )?);
    let result_conditions =
        format!("kind=43004&created_at>{}&created_at<{}", base_time + 19, base_time + 21);
    let result = raw_event(
        43_004,
        vec![
            tag(&["h", channel.as_str()])?,
            tag(&["p", &alice])?,
            tag(&["e", &request.id.to_hex(), "", "root"])?,
            oa_tag(&p.alice, &p.agent, &result_conditions, 22)?,
        ],
        "Completed with deterministic bytes",
        &p.agent,
        base_time + 20,
        23,
    )?;
    events.push(fixture_event(
        "job-result-completed",
        "Trustgraphs J1 result profile plus buzz-sdk NIP-OA verifier",
        result.clone(),
    )?);

    let cancelled_request = raw_event(
        43_001,
        vec![tag(&["h", channel.as_str()])?, tag(&["p", &agent])?],
        "Second job",
        &p.bob,
        base_time + 21,
        24,
    )?;
    events.push(fixture_event(
        "job-request-later-cancelled",
        "Trustgraphs J1 request profile over rust-nostr",
        cancelled_request.clone(),
    )?);
    let cancelled_result_conditions =
        format!("kind=43004&created_at>{}&created_at<{}", base_time + 21, base_time + 23);
    let cancelled_result = raw_event(
        43_004,
        vec![
            tag(&["h", channel.as_str()])?,
            tag(&["p", &bob])?,
            tag(&["e", &cancelled_request.id.to_hex(), "", "root"])?,
            oa_tag(&p.alice, &p.agent, &cancelled_result_conditions, 25)?,
        ],
        "Initially completed",
        &p.agent,
        base_time + 22,
        26,
    )?;
    events.push(fixture_event(
        "job-result-later-cancelled",
        "Trustgraphs J1 result profile plus buzz-sdk NIP-OA verifier",
        cancelled_result,
    )?);
    let cancel = raw_event(
        43_005,
        vec![
            tag(&["h", channel.as_str()])?,
            tag(&["p", &agent])?,
            tag(&["e", &cancelled_request.id.to_hex(), "", "root"])?,
        ],
        "cancelled after result",
        &p.bob,
        base_time + 23,
        27,
    )?;
    events.push(fixture_event(
        "job-cancel-wins-terminal-order",
        "Trustgraphs J1 cancel profile over rust-nostr",
        cancel,
    )?);

    let self_entries = [agent_vouch.id, result.id];
    let self_head = self_log_head(p.agent.public_key(), &self_entries);
    let self_head_event = raw_event(
        36_384,
        vec![
            tag(&["d", &hex::encode(INSTANCE_DOMAIN)])?,
            tag(&["commitment", "self-log-v1"])?,
            tag(&["head", &hex::encode(self_head)])?,
            tag(&["count", "2"])?,
        ],
        "",
        &p.agent,
        base_time + 24,
        28,
    )?;
    events.push(fixture_event(
        "self-log-head",
        "Trustgraphs Option-C schema over rust-nostr",
        self_head_event.clone(),
    )?);

    // The S4 epoch-two fixture is generated into a separate directory with
    // `TG_BUZZ_FIXTURE_EPOCH=2`; the default branch above remains the frozen S0/S2 golden input.
    // Every mutation is a newly signed event appended to the complete Option-A prefix.
    let mut selected_self_events = vec![agent_vouch.clone(), result.clone()];
    let mut selected_self_head = self_head_event.clone();
    let mut epoch_two_self_log = None;
    if epoch_two {
        let changed_roster = raw_event(
            13_534,
            vec![
                tag(&["-"])?,
                tag(&["member", &alice, "owner"])?,
                tag(&["member", &bob, "member"])?,
                tag(&["member", &added_member, "member"])?,
            ],
            "",
            &p.relay,
            base_time + 25,
            40,
        )?;
        events.push(fixture_event(
            "epoch-two-membership-add",
            "newer relay-signed membership roster",
            changed_roster,
        )?);

        let changed_vouch = raw_event(
            36_382,
            vec![tag(&["d", &bob])?, tag(&["weight", "55"])?],
            "",
            &p.alice,
            base_time + 26,
            41,
        )?;
        events.push(fixture_event(
            "epoch-two-vouch-replacement",
            "newer NIP-33 vouch coordinate replaces epoch one",
            changed_vouch,
        )?);

        events.push(fixture_event(
            "epoch-two-valid-deletion",
            "Bob deletes his epoch-one vouch by exact event id",
            deletion("e", &bob_vouch_alice.id.to_hex(), &p.bob, base_time + 27, 42)?,
        )?);

        let flipped_vote = deterministic_sign(
            build_vote(channel_id, bob_post.id, VoteDirection::Up)?,
            &p.alice,
            base_time + 28,
            43,
        )?;
        events.push(fixture_event(
            "epoch-two-forum-vote-flip",
            "a later literal plus replaces the epoch-one minus",
            flipped_vote,
        )?);

        let new_request = raw_event(
            43_001,
            vec![tag(&["h", channel.as_str()])?, tag(&["p", &agent])?],
            "Second-epoch bounded export",
            &p.outsider_owner,
            base_time + 29,
            44,
        )?;
        events.push(fixture_event(
            "epoch-two-job-request",
            "newly admitted member requests work from the delegated agent",
            new_request.clone(),
        )?);
        let new_result_conditions =
            format!("kind=43004&created_at>{}&created_at<{}", base_time + 29, base_time + 31);
        let new_result = raw_event(
            43_004,
            vec![
                tag(&["h", channel.as_str()])?,
                tag(&["p", &added_member])?,
                tag(&["e", &new_request.id.to_hex(), "", "root"])?,
                oa_tag(&p.alice, &p.agent, &new_result_conditions, 45)?,
            ],
            "Completed second-epoch export",
            &p.agent,
            base_time + 30,
            46,
        )?;
        events.push(fixture_event(
            "epoch-two-job-result",
            "new J1 completion with valid OA owner provenance",
            new_result.clone(),
        )?);

        let epoch_two_entries = [agent_vouch.id, result.id, new_result.id];
        let epoch_two_head = self_log_head(p.agent.public_key(), &epoch_two_entries);
        let epoch_two_head_event = raw_event(
            36_384,
            vec![
                tag(&["d", &hex::encode(INSTANCE_DOMAIN)])?,
                tag(&["commitment", "self-log-v1"])?,
                tag(&["head", &hex::encode(epoch_two_head)])?,
                tag(&["count", "3"])?,
            ],
            "",
            &p.agent,
            base_time + 31,
            47,
        )?;
        events.push(fixture_event(
            "epoch-two-self-log-head",
            "higher signed Option-C count; withheld by the S4 e2e",
            epoch_two_head_event.clone(),
        )?);
        selected_self_events.push(new_result);
        selected_self_head = epoch_two_head_event.clone();
        epoch_two_self_log = Some(SelfLogFixture {
            author: agent.clone(),
            entry_event_ids: epoch_two_entries.iter().map(EventId::to_hex).collect(),
            head: hex::encode(epoch_two_head),
            count: 3,
            head_event_id: epoch_two_head_event.id.to_hex(),
        });
    }

    let channel_kinds = [43_001u16, 43_004, 43_005, 43_006, 45_001, 45_002, 45_003];
    let mut audit_prefix = Vec::new();
    let mut audit_entries = Vec::new();
    let mut previous = None;
    for (index, fixture) in events.iter().skip(1).enumerate() {
        let channel_scope =
            channel_kinds.contains(&fixture.event.kind.as_u16()).then_some(channel_id);
        let (entry, serialized) = audit_entry(
            community_id,
            (index + 1) as i64,
            previous,
            &fixture.event,
            channel_scope,
            base_time,
        )?;
        previous = Some(entry.hash.clone());
        audit_entries.push(entry);
        audit_prefix.push(serialized);
    }

    let tie_ids = vec![vouch_tie_a.id.to_hex(), vouch_tie_b.id.to_hex()];
    let tie_winner = tie_ids.iter().min().expect("two tie candidates").clone();
    let replacement_expectations = vec![ReplacementExpectation {
        name: "same-second-lowest-event-id-wins",
        coordinate: format!("36382:{alice}:{bob}"),
        candidates: tie_ids,
        winner: tie_winner,
        rule: "greatest created_at, then lexicographically lowest event id",
    }];

    let mut self_logs = vec![SelfLogFixture {
        author: agent.clone(),
        entry_event_ids: self_entries.iter().map(EventId::to_hex).collect(),
        head: hex::encode(self_head),
        count: self_entries.len() as u64,
        head_event_id: self_head_event.id.to_hex(),
    }];
    if let Some(epoch_two_log) = epoch_two_self_log {
        self_logs.push(epoch_two_log);
    }

    let option_a = encode_option_a(community_id, p.relay.public_key(), &audit_entries, &events)?;
    let option_c = encode_option_c(
        community_id,
        p.agent.public_key(),
        &selected_self_events,
        &selected_self_head,
    )?;
    let output_directory = output.parent().unwrap_or_else(|| Path::new("."));
    write_artifact(output_directory, "source-option-a.tgnw", &option_a)?;
    write_artifact(output_directory, "source-option-c.tgnw", &option_c)?;
    let adversarial_directory = output_directory.join("adversarial");
    std::fs::create_dir_all(&adversarial_directory)
        .context("creating generated adversarial artifact directory")?;
    let audit_gap_entries: Vec<AuditEntry> =
        audit_entries.iter().filter(|entry| entry.seq != 2).cloned().collect();
    let audit_gap =
        encode_option_a(community_id, p.relay.public_key(), &audit_gap_entries, &events)?;
    write_artifact(&adversarial_directory, "audit-gap.tgnw", &audit_gap)?;
    let mut changed_bundle_byte = option_a.clone();
    changed_bundle_byte[32] ^= 1;
    write_artifact(&adversarial_directory, "changed-bundle-byte.tgnw", &changed_bundle_byte)?;
    let envelopes = vec![
        EnvelopeArtifact {
            name: "source-option-a",
            file: "source-option-a.tgnw",
            variant: 1,
            bytes: option_a.len(),
            sha256: hex::encode(Sha256::digest(&option_a)),
            audit_count: audit_entries.len(),
            event_count: events.len(),
        },
        EnvelopeArtifact {
            name: "source-option-c",
            file: "source-option-c.tgnw",
            variant: 2,
            bytes: option_c.len(),
            sha256: hex::encode(Sha256::digest(&option_c)),
            audit_count: 0,
            event_count: selected_self_events.len(),
        },
    ];

    let duplicate_auth = raw_event(
        36_382,
        vec![
            tag(&["d", &bob])?,
            tag(&["weight", "50"])?,
            oa_tag(&p.alice, &p.agent, &agent_vouch_conditions, 29)?,
            oa_tag(&p.alice, &p.agent, &agent_vouch_conditions, 30)?,
        ],
        "",
        &p.agent,
        base_time + 8,
        31,
    )?;
    let lower_conditions = format!("kind=36382&created_at>{}", base_time + 30);
    let lower_edge = raw_event(
        36_382,
        vec![
            tag(&["d", &bob])?,
            tag(&["weight", "50"])?,
            oa_tag(&p.alice, &p.agent, &lower_conditions, 32)?,
        ],
        "",
        &p.agent,
        base_time + 30,
        33,
    )?;
    let upper_conditions = format!("kind=36382&created_at<{}", base_time + 31);
    let upper_edge = raw_event(
        36_382,
        vec![
            tag(&["d", &bob])?,
            tag(&["weight", "50"])?,
            oa_tag(&p.alice, &p.agent, &upper_conditions, 34)?,
        ],
        "",
        &p.agent,
        base_time + 31,
        35,
    )?;
    let wrong_author_delete = deletion("e", &deleted_by_e.id.to_hex(), &p.bob, base_time + 32, 36)?;
    let missing_target = deterministic_sign(
        build_vote(channel_id, EventId::from_byte_array([0x99; 32]), VoteDirection::Up)?,
        &p.bob,
        base_time + 33,
        37,
    )?;
    let outsider_conditions =
        format!("kind=36382&created_at>{}&created_at<{}", base_time + 33, base_time + 35);
    let outsider_agent = raw_event(
        36_382,
        vec![
            tag(&["d", &bob])?,
            tag(&["weight", "50"])?,
            oa_tag(&p.outsider_owner, &p.outsider_agent, &outsider_conditions, 38)?,
        ],
        "",
        &p.outsider_agent,
        base_time + 34,
        39,
    )?;
    let adversarial = vec![
        AdversarialCase {
            name: "duplicate-auth-tags",
            expected: "skip",
            reason: "OA identity is ambiguous unless exactly one auth tag exists",
            event: Some(fixture_event(
                "duplicate-auth-tags",
                "valid rust-nostr signature; malformed Trustgraphs schema",
                duplicate_auth,
            )?),
            mutation: None,
        },
        AdversarialCase {
            name: "oa-created-at-lower-edge",
            expected: "skip",
            reason: "created_at>N is strict; equality violates the clause",
            event: Some(fixture_event(
                "oa-created-at-lower-edge",
                "valid Buzz OA signature with an unsatisfied boundary",
                lower_edge,
            )?),
            mutation: None,
        },
        AdversarialCase {
            name: "oa-created-at-upper-edge",
            expected: "skip",
            reason: "created_at<N is strict; equality violates the clause",
            event: Some(fixture_event(
                "oa-created-at-upper-edge",
                "valid Buzz OA signature with an unsatisfied boundary",
                upper_edge,
            )?),
            mutation: None,
        },
        AdversarialCase {
            name: "wrong-author-e-deletion",
            expected: "skip",
            reason: "a deletion cannot revoke another author's event",
            event: Some(fixture_event(
                "wrong-author-e-deletion",
                "valid rust-nostr signature; wrong deletion owner",
                wrong_author_delete,
            )?),
            mutation: None,
        },
        AdversarialCase {
            name: "missing-referenced-forum-object",
            expected: "skip",
            reason: "F1 requires the exact referenced post/comment event",
            event: Some(fixture_event(
                "missing-referenced-forum-object",
                "buzz-sdk build_vote against a missing id",
                missing_target,
            )?),
            mutation: None,
        },
        AdversarialCase {
            name: "agent-owner-not-in-roster",
            expected: "skip",
            reason: "the OA signature is valid but its owner is not a current roster member",
            event: Some(fixture_event(
                "agent-owner-not-in-roster",
                "valid Buzz OA and rust-nostr signatures; ineligible owner",
                outsider_agent,
            )?),
            mutation: None,
        },
        AdversarialCase {
            name: "audit-gap",
            expected: "hard-fail",
            reason: "a full-prefix Option-A proof requires contiguous sequence and prev_hash",
            event: None,
            mutation: Some(json!({
                "operation":"removeAuditEntry",
                "seq":2,
                "file":"adversarial/audit-gap.tgnw"
            })),
        },
        AdversarialCase {
            name: "changed-bundle-byte",
            expected: "hard-fail",
            reason: "dataCommitment binds every exact TGNW byte",
            event: None,
            mutation: Some(json!({
                "operation":"xorEnvelopeByte",
                "offset":32,
                "xor":1,
                "file":"adversarial/changed-bundle-byte.tgnw"
            })),
        },
        AdversarialCase {
            name: "duplicate-a-c-event",
            expected: "accept-once",
            reason: "the job result occurs in both the audit prefix and the agent self-log",
            event: None,
            mutation: Some(json!({"eventId":result.id.to_hex()})),
        },
    ];

    let mut principal_map = BTreeMap::new();
    principal_map.insert("relay", p.relay.public_key().to_hex());
    principal_map.insert("alice", alice);
    principal_map.insert("bob", bob);
    principal_map.insert("agent", agent);
    principal_map.insert("outsiderOwner", p.outsider_owner.public_key().to_hex());
    principal_map.insert("outsiderAgent", p.outsider_agent.public_key().to_hex());

    let published_oa_vector = PublishedOaVector {
        owner_pubkey: "79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798",
        agent_pubkey: "c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5",
        conditions: "kind=1&created_at<1713957000",
        preimage: "nostr:agent-auth:c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5:kind=1&created_at<1713957000".into(),
        sha256: "08cdecd55af4c28d3801fd69615dcf5cc04fab3bc134b38a840bf157197069a6",
        signature: "8b7df2575caf0a108374f8471722b233c53f9ff827a8b0f91861966c3b9dd5cb2e189eae9f49d72187674c2f5bd244145e10ff86c9f257ffe65a1ee5f108b369",
    };
    let published_agent = PublicKey::from_hex(published_oa_vector.agent_pubkey)?;
    let published_tag = json!([
        "auth",
        published_oa_vector.owner_pubkey,
        published_oa_vector.conditions,
        published_oa_vector.signature
    ])
    .to_string();
    let published_owner = buzz_sdk::nip_oa::verify_auth_tag(&published_tag, &published_agent)
        .context("Buzz published OA vector verification")?;
    if published_owner.to_hex() != published_oa_vector.owner_pubkey {
        bail!("published OA vector recovered the wrong owner");
    }

    let corpus = Corpus {
        format: "trustgraphs.nostr.buzz-source-corpus.v1",
        generated_by: "generator/src/main.rs",
        buzz_sha: BUZZ_SHA,
        compatibility_patch_sha256: PATCH_SHA256,
        rust_nostr: "0.44.7",
        community_id,
        channel_id,
        instance_domain: hex::encode(INSTANCE_DOMAIN),
        principals: principal_map,
        published_oa_vector,
        oa_condition_cases,
        serializer_vectors,
        events,
        audit_prefix,
        direct_event_rows: vec!["relay-roster".into()],
        envelopes,
        replacement_expectations,
        self_logs,
        adversarial,
    };
    let bytes = serde_json::to_vec_pretty(&corpus).context("serializing source corpus")?;
    std::fs::write(&output, bytes)
        .with_context(|| format!("writing generated corpus to {}", output.display()))?;
    Ok(())
}
