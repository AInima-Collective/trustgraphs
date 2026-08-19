use std::collections::{BTreeMap, BTreeSet};
use std::path::PathBuf;
use std::str::FromStr;

use alloy_primitives::{keccak256, Address, B256, U256};
use anyhow::{bail, ensure, Context, Result};
use chrono::{DateTime, Utc};
use k256::ecdsa::{RecoveryId, Signature as EcdsaSignature, VerifyingKey as EcdsaVerifyingKey};
use k256::schnorr::signature::hazmat::PrehashVerifier;
use k256::schnorr::signature::Verifier as MessageVerifier;
use k256::schnorr::{Signature as SchnorrSignature, VerifyingKey as SchnorrVerifyingKey};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use uuid::Uuid;

const FORMAT: &str = "trustgraphs.nostr.buzz-source-corpus.v1";
const BUZZ_SHA: &str = "a362fecc2389955f942c9581bdfeba379ab115b3";
const PATCH_SHA256: &str = "3129e43e7b8967635bde8dd4a084613ef8628146dd1d1ba2f62e41ced4762a62";
const INSTANCE_DOMAIN: [u8; 32] = [0x42; 32];

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Corpus {
    format: String,
    buzz_sha: String,
    compatibility_patch_sha256: String,
    rust_nostr: String,
    community_id: Uuid,
    channel_id: Uuid,
    instance_domain: String,
    principals: BTreeMap<String, String>,
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

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PublishedOaVector {
    owner_pubkey: String,
    agent_pubkey: String,
    conditions: String,
    preimage: String,
    sha256: String,
    signature: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct OaConditionCase {
    conditions: String,
    grammar_valid: bool,
    event_kind: u16,
    created_at: u64,
    applies: bool,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FixtureEvent {
    name: String,
    nip01_preimage: String,
    nip01_preimage_hex: String,
    event: Event,
}

#[derive(Clone, Deserialize, PartialEq, Eq)]
struct Event {
    id: String,
    pubkey: String,
    created_at: u64,
    kind: u16,
    tags: Vec<Vec<String>>,
    content: String,
    sig: String,
}

#[derive(Clone, Deserialize, PartialEq)]
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

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct EnvelopeArtifact {
    file: String,
    variant: u8,
    bytes: usize,
    sha256: String,
    audit_count: usize,
    event_count: usize,
}

#[derive(Deserialize)]
struct ReplacementExpectation {
    coordinate: String,
    candidates: Vec<String>,
    winner: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SelfLogFixture {
    author: String,
    entry_event_ids: Vec<String>,
    head: String,
    count: u64,
    head_event_id: String,
}

#[derive(Deserialize)]
struct AdversarialCase {
    name: String,
    expected: String,
    event: Option<FixtureEvent>,
    mutation: Option<Value>,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct BindingContent {
    address: String,
    chain_id: String,
    timestamp: String,
    nonce: String,
    signature: String,
}

#[derive(PartialEq)]
struct ParsedEnvelope {
    variant: u8,
    community_id: Uuid,
    instance_domain: [u8; 32],
    authority: [u8; 32],
    audit: Vec<FixtureAuditEntry>,
    events: Vec<Event>,
    head_event: Option<Event>,
}

struct Cursor<'a> {
    input: &'a [u8],
    offset: usize,
}

fn decode_hex<const N: usize>(value: &str, label: &str) -> Result<[u8; N]> {
    let bytes = hex::decode(value).with_context(|| format!("decoding {label}"))?;
    bytes.try_into().map_err(|_| anyhow::anyhow!("{label} must be {N} bytes"))
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

impl<'a> Cursor<'a> {
    fn new(input: &'a [u8]) -> Result<Self> {
        ensure!(input.len() <= 12_582_912, "TGNW envelope exceeds byte cap");
        Ok(Self { input, offset: 0 })
    }

    fn take(&mut self, length: usize) -> Result<&'a [u8]> {
        let end = self.offset.checked_add(length).context("TGNW offset overflow")?;
        ensure!(end <= self.input.len(), "truncated TGNW at byte {}", self.offset);
        let bytes = &self.input[self.offset..end];
        self.offset = end;
        Ok(bytes)
    }

    fn byte(&mut self) -> Result<u8> {
        Ok(self.take(1)?[0])
    }

    fn u16(&mut self) -> Result<u16> {
        Ok(u16::from_be_bytes(self.take(2)?.try_into().unwrap()))
    }

    fn u32(&mut self) -> Result<u32> {
        Ok(u32::from_be_bytes(self.take(4)?.try_into().unwrap()))
    }

    fn u64(&mut self) -> Result<u64> {
        Ok(u64::from_be_bytes(self.take(8)?.try_into().unwrap()))
    }

    fn string(&mut self, maximum: usize, label: &str) -> Result<String> {
        let length = usize::try_from(self.u32()?)?;
        ensure!(length <= maximum, "{label} exceeds cap");
        String::from_utf8(self.take(length)?.to_vec()).with_context(|| format!("{label} UTF-8"))
    }

    fn finished(&self) -> bool {
        self.offset == self.input.len()
    }
}

fn action_name(code: u8) -> Result<&'static str> {
    Ok(match code {
        0 => "event_created",
        1 => "event_deleted",
        2 => "channel_created",
        3 => "channel_updated",
        4 => "channel_deleted",
        5 => "member_added",
        6 => "member_removed",
        7 => "auth_success",
        8 => "auth_failure",
        9 => "rate_limit_exceeded",
        10 => "media_uploaded",
        _ => bail!("unknown TGNW audit action {code}"),
    })
}

fn action_code(action: &str) -> Result<u8> {
    Ok(match action {
        "event_created" => 0,
        "event_deleted" => 1,
        "channel_created" => 2,
        "channel_updated" => 3,
        "channel_deleted" => 4,
        "member_added" => 5,
        "member_removed" => 6,
        "auth_success" => 7,
        "auth_failure" => 8,
        "rate_limit_exceeded" => 9,
        "media_uploaded" => 10,
        _ => bail!("unknown audit action {action}"),
    })
}

fn parse_audit(cursor: &mut Cursor<'_>, community_id: Uuid) -> Result<FixtureAuditEntry> {
    let seq = cursor.u64()?;
    ensure!(seq <= i64::MAX as u64, "audit sequence exceeds i64");
    let hash = hex::encode(cursor.take(32)?);
    let prev_hash = match cursor.byte()? {
        0 => None,
        1 => Some(hex::encode(cursor.take(32)?)),
        other => bail!("invalid audit prev_hash presence byte {other}"),
    };
    let action = action_name(cursor.byte()?)?.to_string();
    let actor_pubkey = match cursor.byte()? {
        0 => None,
        1 => Some(hex::encode(cursor.take(32)?)),
        other => bail!("invalid audit actor presence byte {other}"),
    };
    let object_id = match cursor.byte()? {
        0 => None,
        1 => Some(cursor.string(1_024, "audit object id")?),
        other => bail!("invalid audit object presence byte {other}"),
    };
    let created_at = cursor.string(64, "audit created_at")?;
    let detail_text = cursor.string(4_096, "audit detail")?;
    let detail: Value = serde_json::from_str(&detail_text).context("audit detail JSON")?;
    ensure!(canonical_json(&detail)? == detail_text, "non-canonical audit detail");
    Ok(FixtureAuditEntry {
        community_id,
        seq: seq as i64,
        hash,
        prev_hash,
        action,
        actor_pubkey,
        object_id,
        detail,
        created_at,
    })
}

fn parse_event(cursor: &mut Cursor<'_>) -> Result<Event> {
    let id = hex::encode(cursor.take(32)?);
    let pubkey = hex::encode(cursor.take(32)?);
    let created_at = cursor.u64()?;
    let kind = cursor.u32()?;
    ensure!(kind <= u16::MAX.into(), "Nostr kind exceeds rust-nostr u16");
    let tag_count = usize::try_from(cursor.u32()?)?;
    ensure!(tag_count <= 64, "TGNW tag count exceeds cap");
    let mut tags = Vec::with_capacity(tag_count);
    let mut total_tag_bytes = 0usize;
    for _ in 0..tag_count {
        let element_count = usize::try_from(cursor.u32()?)?;
        ensure!(element_count <= 8, "TGNW tag element count exceeds cap");
        let mut tag = Vec::with_capacity(element_count);
        for _ in 0..element_count {
            let element = cursor.string(1_024, "tag element")?;
            total_tag_bytes =
                total_tag_bytes.checked_add(element.len()).context("tag byte count overflow")?;
            ensure!(total_tag_bytes <= 16_384, "TGNW total tag bytes exceed cap");
            tag.push(element);
        }
        tags.push(tag);
    }
    let content = cursor.string(65_536, "event content")?;
    let sig = hex::encode(cursor.take(64)?);
    Ok(Event { id, pubkey, created_at, kind: kind as u16, tags, content, sig })
}

fn parse_tgnw(bytes: &[u8]) -> Result<ParsedEnvelope> {
    let mut cursor = Cursor::new(bytes)?;
    ensure!(cursor.take(4)? == b"TGNW", "TGNW magic");
    ensure!(cursor.byte()? == 1, "TGNW version");
    let variant = cursor.byte()?;
    ensure!(matches!(variant, 1 | 2), "unsupported TGNW variant");
    ensure!(cursor.u16()? == 0, "TGNW flags");
    let community_id = Uuid::from_bytes(cursor.take(16)?.try_into().unwrap());
    let instance_domain = cursor.take(32)?.try_into().unwrap();
    let authority = cursor.take(32)?.try_into().unwrap();
    let mut audit = Vec::new();
    let mut events = Vec::new();
    let head_event = if variant == 1 {
        let audit_count = usize::try_from(cursor.u32()?)?;
        ensure!(audit_count <= 4_096, "TGNW audit count exceeds cap");
        audit.reserve(audit_count);
        for _ in 0..audit_count {
            audit.push(parse_audit(&mut cursor, community_id)?);
        }
        let event_count = usize::try_from(cursor.u32()?)?;
        ensure!(event_count <= 512, "TGNW event count exceeds cap");
        events.reserve(event_count);
        for _ in 0..event_count {
            events.push(parse_event(&mut cursor)?);
        }
        None
    } else {
        let event_count = usize::try_from(cursor.u32()?)?;
        ensure!(event_count <= 512, "TGNW event count exceeds cap");
        events.reserve(event_count);
        for _ in 0..event_count {
            events.push(parse_event(&mut cursor)?);
        }
        Some(parse_event(&mut cursor)?)
    };
    ensure!(cursor.finished(), "trailing TGNW bytes");
    Ok(ParsedEnvelope {
        variant,
        community_id,
        instance_domain,
        authority,
        audit,
        events,
        head_event,
    })
}

fn push_u32(output: &mut Vec<u8>, value: usize) -> Result<()> {
    output.extend_from_slice(&u32::try_from(value)?.to_be_bytes());
    Ok(())
}

fn push_string(output: &mut Vec<u8>, value: &str) -> Result<()> {
    push_u32(output, value.len())?;
    output.extend_from_slice(value.as_bytes());
    Ok(())
}

fn encode_audit(output: &mut Vec<u8>, entry: &FixtureAuditEntry) -> Result<()> {
    output.extend_from_slice(&u64::try_from(entry.seq)?.to_be_bytes());
    output.extend_from_slice(&decode_hex::<32>(&entry.hash, "audit hash")?);
    match &entry.prev_hash {
        Some(previous) => {
            output.push(1);
            output.extend_from_slice(&decode_hex::<32>(previous, "audit prev_hash")?);
        }
        None => output.push(0),
    }
    output.push(action_code(&entry.action)?);
    match &entry.actor_pubkey {
        Some(actor) => {
            output.push(1);
            output.extend_from_slice(&decode_hex::<32>(actor, "audit actor")?);
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
    push_string(output, &entry.created_at)?;
    push_string(output, &canonical_json(&entry.detail)?)?;
    Ok(())
}

fn encode_event(output: &mut Vec<u8>, event: &Event) -> Result<()> {
    output.extend_from_slice(&decode_hex::<32>(&event.id, "event id")?);
    output.extend_from_slice(&decode_hex::<32>(&event.pubkey, "event pubkey")?);
    output.extend_from_slice(&event.created_at.to_be_bytes());
    output.extend_from_slice(&(event.kind as u32).to_be_bytes());
    push_u32(output, event.tags.len())?;
    for tag in &event.tags {
        push_u32(output, tag.len())?;
        for element in tag {
            push_string(output, element)?;
        }
    }
    push_string(output, &event.content)?;
    output.extend_from_slice(&decode_hex::<64>(&event.sig, "event signature")?);
    Ok(())
}

fn encode_tgnw(envelope: &ParsedEnvelope) -> Result<Vec<u8>> {
    let mut output = Vec::new();
    output.extend_from_slice(b"TGNW");
    output.push(1);
    output.push(envelope.variant);
    output.extend_from_slice(&0u16.to_be_bytes());
    output.extend_from_slice(envelope.community_id.as_bytes());
    output.extend_from_slice(&envelope.instance_domain);
    output.extend_from_slice(&envelope.authority);
    if envelope.variant == 1 {
        push_u32(&mut output, envelope.audit.len())?;
        for entry in &envelope.audit {
            encode_audit(&mut output, entry)?;
        }
        push_u32(&mut output, envelope.events.len())?;
        for event in &envelope.events {
            encode_event(&mut output, event)?;
        }
    } else {
        push_u32(&mut output, envelope.events.len())?;
        for event in &envelope.events {
            encode_event(&mut output, event)?;
        }
        encode_event(&mut output, envelope.head_event.as_ref().context("Option-C head event")?)?;
    }
    Ok(output)
}

fn verify_schnorr_prehash(pubkey: &str, prehash: &[u8; 32], signature: &str) -> Result<()> {
    let pubkey = decode_hex::<32>(pubkey, "x-only public key")?;
    let signature = hex::decode(signature).context("decoding Schnorr signature")?;
    let verifying_key =
        SchnorrVerifyingKey::from_bytes(&pubkey).context("parsing x-only public key")?;
    let signature =
        SchnorrSignature::try_from(signature.as_slice()).context("parsing BIP-340 signature")?;
    verifying_key.verify_prehash(prehash, &signature).context("BIP-340 prehash verification")
}

fn verify_event(fixture: &FixtureEvent) -> Result<()> {
    let event = &fixture.event;
    let preimage = serde_json::to_string(&json!([
        0,
        &event.pubkey,
        event.created_at,
        event.kind,
        &event.tags,
        &event.content
    ]))?;
    ensure!(preimage == fixture.nip01_preimage, "{}: NIP-01 text differs", fixture.name);
    ensure!(
        hex::encode(preimage.as_bytes()) == fixture.nip01_preimage_hex,
        "{}: NIP-01 hex differs",
        fixture.name
    );
    let id: [u8; 32] = Sha256::digest(preimage.as_bytes()).into();
    ensure!(hex::encode(id) == event.id, "{}: event id differs", fixture.name);
    verify_schnorr_prehash(&event.pubkey, &id, &event.sig)
        .with_context(|| format!("{}: event signature", fixture.name))
}

fn ensure_message_api_is_not_nostr(event: &Event) -> Result<()> {
    let id = decode_hex::<32>(&event.id, "event id")?;
    let pubkey = decode_hex::<32>(&event.pubkey, "x-only public key")?;
    let signature = hex::decode(&event.sig)?;
    let verifying_key = SchnorrVerifyingKey::from_bytes(&pubkey)?;
    let signature = SchnorrSignature::try_from(signature.as_slice())?;
    ensure!(
        MessageVerifier::verify(&verifying_key, &id, &signature).is_err(),
        "k256 message-level Verifier unexpectedly accepted a rust-nostr prehash signature"
    );
    Ok(())
}

fn validate_decimal(value: &str, max: u64) -> bool {
    !value.is_empty()
        && (value == "0" || !value.starts_with('0'))
        && value.bytes().all(|byte| byte.is_ascii_digit())
        && value.parse::<u64>().is_ok_and(|parsed| parsed <= max)
}

fn validate_conditions(conditions: &str) -> bool {
    conditions.is_empty()
        || (!conditions.bytes().any(|byte| byte.is_ascii_whitespace())
            && conditions.split('&').all(|clause| {
                if let Some(value) = clause.strip_prefix("kind=") {
                    validate_decimal(value, 65_535)
                } else if let Some(value) = clause.strip_prefix("created_at<") {
                    validate_decimal(value, u32::MAX.into())
                } else if let Some(value) = clause.strip_prefix("created_at>") {
                    validate_decimal(value, u32::MAX.into())
                } else {
                    false
                }
            }))
}

fn conditions_apply(conditions: &str, kind: u16, created_at: u64) -> bool {
    validate_conditions(conditions)
        && (conditions.is_empty()
            || conditions.split('&').all(|clause| {
                if let Some(value) = clause.strip_prefix("kind=") {
                    value.parse::<u16>() == Ok(kind)
                } else if let Some(value) = clause.strip_prefix("created_at<") {
                    value.parse::<u64>().is_ok_and(|bound| created_at < bound)
                } else if let Some(value) = clause.strip_prefix("created_at>") {
                    value.parse::<u64>().is_ok_and(|bound| created_at > bound)
                } else {
                    false
                }
            }))
}

fn verify_oa_tag(tag: &[String], agent: &str, kind: u16, created_at: u64) -> Result<String> {
    ensure!(tag.len() == 4 && tag[0] == "auth", "invalid OA tag shape");
    ensure!(validate_conditions(&tag[2]), "invalid OA conditions grammar");
    ensure!(conditions_apply(&tag[2], kind, created_at), "OA conditions do not apply");
    ensure!(tag[1] != agent, "OA self-attestation");
    let preimage = format!("nostr:agent-auth:{agent}:{}", tag[2]);
    let digest: [u8; 32] = Sha256::digest(preimage.as_bytes()).into();
    verify_schnorr_prehash(&tag[1], &digest, &tag[3])?;
    Ok(tag[1].clone())
}

fn tags_named<'a>(event: &'a Event, name: &str) -> Vec<&'a Vec<String>> {
    event.tags.iter().filter(|tag| tag.first().is_some_and(|value| value == name)).collect()
}

fn sole_tag<'a>(event: &'a Event, name: &str) -> Result<&'a Vec<String>> {
    let matches = tags_named(event, name);
    ensure!(matches.len() == 1, "kind {} needs one {name} tag", event.kind);
    Ok(matches[0])
}

fn parse_address(value: &str) -> Result<Address> {
    ensure!(
        value.len() == 42
            && value.starts_with("0x")
            && value[2..]
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)),
        "address is not canonical lowercase hex"
    );
    Address::from_str(value).context("parsing EVM address")
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

fn verify_binding(event: &Event) -> Result<()> {
    let d = sole_tag(event, "d")?;
    ensure!(event.tags.len() == 1 && d.len() == 2, "binding tag shape");
    let binding: BindingContent = serde_json::from_str(&event.content)?;
    ensure!(serde_json::to_string(&binding)? == event.content, "binding JSON is not canonical");
    ensure!(d[1] == binding.address, "binding d/address mismatch");
    let address = parse_address(&binding.address)?;
    for (label, value) in [
        ("chainId", binding.chain_id.as_str()),
        ("timestamp", binding.timestamp.as_str()),
        ("nonce", binding.nonce.as_str()),
    ] {
        ensure!(validate_decimal(value, u64::MAX), "non-canonical binding {label}");
    }
    let chain_id = U256::from_str_radix(&binding.chain_id, 10)?;
    let timestamp = U256::from_str_radix(&binding.timestamp, 10)?;
    let nonce = U256::from_str_radix(&binding.nonce, 10)?;
    let did = format!("did:nostr:{}", event.pubkey);
    let digest = binding_digest(&did, address, chain_id, timestamp, nonce);
    let signature_bytes =
        hex::decode(binding.signature.strip_prefix("0x").context("binding signature lacks 0x")?)?;
    ensure!(signature_bytes.len() == 65, "binding signature length");
    let signature = EcdsaSignature::from_slice(&signature_bytes[..64])?;
    ensure!(signature.normalize_s().is_none(), "binding signature is high-S");
    let recovery_id = RecoveryId::from_byte(signature_bytes[64]).context("binding recovery id")?;
    let recovered =
        EcdsaVerifyingKey::recover_from_prehash(digest.as_slice(), &signature, recovery_id)?;
    let uncompressed = recovered.to_encoded_point(false);
    let hash = keccak256(&uncompressed.as_bytes()[1..]);
    ensure!(Address::from_slice(&hash.as_slice()[12..]) == address, "wrong binding signer");
    Ok(())
}

fn verify_roster(corpus: &Corpus, event: &Event) -> Result<BTreeSet<String>> {
    ensure!(event.kind == 13_534 && event.content.is_empty(), "roster kind/content");
    ensure!(event.pubkey == corpus.principals["relay"], "roster relay signer");
    ensure!(event.tags.first() == Some(&vec!["-".into()]), "roster protected marker");
    ensure!(tags_named(event, "-").len() == 1, "duplicate roster protected marker");
    let mut members = BTreeSet::new();
    for tag in event.tags.iter().skip(1) {
        ensure!(tag.len() == 3 && tag[0] == "member", "roster member shape");
        ensure!(matches!(tag[2].as_str(), "owner" | "admin" | "member"), "roster role");
        ensure!(decode_hex::<32>(&tag[1], "roster pubkey").is_ok(), "roster pubkey");
        ensure!(members.insert(tag[1].clone()), "duplicate roster member");
    }
    Ok(members)
}

fn verify_valid_schema(
    fixture: &FixtureEvent,
    events: &BTreeMap<String, Event>,
    roster: &BTreeSet<String>,
    channel_id: Uuid,
) -> Result<()> {
    let event = &fixture.event;
    let channel = channel_id.to_string();
    match event.kind {
        1 => {}
        5 => {
            ensure!(event.content.is_empty(), "deletion content");
            ensure!(event.tags.len() == 1, "deletion singleton target");
            let target = &event.tags[0];
            ensure!(
                target.len() == 2 && matches!(target[0].as_str(), "e" | "a"),
                "deletion target"
            );
            if target[0] == "e" {
                let deleted = events.get(&target[1]).context("missing valid e-deletion target")?;
                ensure!(deleted.pubkey == event.pubkey, "valid deletion owner mismatch");
            } else {
                let fields: Vec<&str> = target[1].splitn(3, ':').collect();
                ensure!(fields.len() == 3 && fields[1] == event.pubkey, "valid a-deletion owner");
            }
        }
        13_534 => {}
        1_617 => {
            ensure!(!event.content.trim().is_empty(), "empty git patch");
            ensure!(sole_tag(event, "a")?.len() == 2, "git patch a shape");
            ensure!(!tags_named(event, "p").is_empty(), "git patch owner p");
            let roots = tags_named(event, "t")
                .into_iter()
                .filter(|tag| tag.as_slice() == ["t", "root"])
                .count();
            ensure!(roots == 1, "git patch root marker");
            ensure!(
                !event.tags.iter().any(|tag| {
                    tag.as_slice() == ["t", "root-revision"]
                        || tag.first().is_some_and(|name| name == "e")
                }),
                "git patch root cannot be a reply/revision"
            );
        }
        1_631 => {
            let root = sole_tag(event, "e")?;
            ensure!(root.len() == 4 && root[2].is_empty() && root[3] == "root", "G1 root e");
            let target = events.get(&root[1]).context("missing G1 root")?;
            ensure!(matches!(target.kind, 1_617 | 1_618), "G1 root kind");
            ensure!(target.pubkey != event.pubkey, "G1 self edge");
            let allowed = ["e", "p", "a", "r", "q", "merge-commit", "applied-as-commits"];
            ensure!(
                event
                    .tags
                    .iter()
                    .all(|tag| tag.first().is_some_and(|name| allowed.contains(&name.as_str()))),
                "unknown G1 status tag"
            );
        }
        36_382 => {
            ensure!(event.content.is_empty(), "vouch content");
            let d = sole_tag(event, "d")?;
            let weight = sole_tag(event, "weight")?;
            ensure!(d.len() == 2 && decode_hex::<32>(&d[1], "vouch subject").is_ok(), "vouch d");
            ensure!(weight.len() == 2 && validate_decimal(&weight[1], 100), "vouch weight");
            let auth = tags_named(event, "auth");
            ensure!(event.tags.len() == 2 + auth.len() && auth.len() <= 1, "vouch tags");
            if let Some(auth) = auth.first() {
                let owner = verify_oa_tag(auth, &event.pubkey, event.kind, event.created_at)?;
                ensure!(roster.contains(&owner), "vouch OA owner is not rostered");
            } else {
                ensure!(roster.contains(&event.pubkey), "human vouch author is not rostered");
            }
        }
        36_383 => verify_binding(event)?,
        36_384 => {
            ensure!(event.content.is_empty() && event.tags.len() == 4, "self-head shape");
            ensure!(
                sole_tag(event, "d")?.as_slice() == ["d", &hex::encode(INSTANCE_DOMAIN)],
                "head d"
            );
            ensure!(
                sole_tag(event, "commitment")?.as_slice() == ["commitment", "self-log-v1"],
                "head commitment"
            );
            ensure!(
                decode_hex::<32>(&sole_tag(event, "head")?[1], "self head").is_ok(),
                "head hex"
            );
            ensure!(validate_decimal(&sole_tag(event, "count")?[1], u64::MAX), "head count");
        }
        43_001 => {
            ensure!(
                !event.content.is_empty() && event.content.len() <= 16_384,
                "J1 request content"
            );
            ensure!(event.tags.len() == 2, "J1 request tags");
            ensure!(sole_tag(event, "h")?.as_slice() == ["h", channel.as_str()], "J1 h");
            ensure!(sole_tag(event, "p")?.len() == 2, "J1 request p");
            ensure!(roster.contains(&event.pubkey), "J1 requester roster");
        }
        43_004 => {
            ensure!(
                !event.content.is_empty() && event.content.len() <= 65_536,
                "J1 result content"
            );
            ensure!(event.tags.len() == 4, "J1 result tags");
            let h = sole_tag(event, "h")?;
            let p = sole_tag(event, "p")?;
            let root = sole_tag(event, "e")?;
            ensure!(h.as_slice() == ["h", channel.as_str()], "J1 result h");
            ensure!(
                p.len() == 2 && root.len() == 4 && root[2].is_empty() && root[3] == "root",
                "J1 result refs"
            );
            let request = events.get(&root[1]).context("missing J1 request")?;
            ensure!(request.kind == 43_001 && request.pubkey == p[1], "J1 linked requester");
            ensure!(sole_tag(request, "p")?[1] == event.pubkey, "J1 linked agent");
            let owner = verify_oa_tag(
                sole_tag(event, "auth")?,
                &event.pubkey,
                event.kind,
                event.created_at,
            )?;
            ensure!(roster.contains(&owner), "J1 OA owner roster");
        }
        43_005 => {
            ensure!(event.content.len() <= 4_096 && event.tags.len() == 3, "J1 cancel shape");
            let root = sole_tag(event, "e")?;
            let request = events.get(&root[1]).context("missing cancelled request")?;
            ensure!(request.kind == 43_001 && request.pubkey == event.pubkey, "cancel requester");
            ensure!(sole_tag(event, "p")?[1] == sole_tag(request, "p")?[1], "cancel agent");
            ensure!(sole_tag(event, "h")?[1] == sole_tag(request, "h")?[1], "cancel h");
        }
        45_001 => {
            ensure!(event.tags.len() == 1, "forum post tags");
            ensure!(sole_tag(event, "h")?.as_slice() == ["h", channel.as_str()], "post h");
        }
        45_002 => {
            ensure!(
                event.tags.len() == 2 && matches!(event.content.as_str(), "+" | "-"),
                "vote shape"
            );
            ensure!(sole_tag(event, "h")?.as_slice() == ["h", channel.as_str()], "vote h");
            let target = events.get(&sole_tag(event, "e")?[1]).context("missing vote target")?;
            ensure!(matches!(target.kind, 45_001 | 45_003), "vote target kind");
            ensure!(sole_tag(target, "h")?[1] == channel, "vote target h");
        }
        other => bail!("unexpected valid fixture kind {other}"),
    }
    Ok(())
}

fn verify_audit(corpus: &Corpus, events: &BTreeMap<String, Event>) -> Result<()> {
    let mut previous: Option<[u8; 32]> = None;
    let mut audited_ids = BTreeSet::new();
    for (index, entry) in corpus.audit_prefix.iter().enumerate() {
        ensure!(entry.community_id == corpus.community_id, "audit community");
        ensure!(entry.seq == (index + 1) as i64, "audit sequence gap");
        let recorded_previous = entry
            .prev_hash
            .as_deref()
            .map(|value| decode_hex::<32>(value, "audit prev_hash"))
            .transpose()?;
        ensure!(recorded_previous == previous, "audit prev_hash mismatch");
        ensure!(entry.action == "event_created", "unexpected audit action");
        let created_at = DateTime::<Utc>::from_str(&entry.created_at)?;
        ensure!(created_at.to_rfc3339() == entry.created_at, "non-canonical audit timestamp");
        let mut preimage = Vec::new();
        preimage.extend_from_slice(entry.community_id.as_bytes());
        preimage.extend_from_slice(&entry.seq.to_be_bytes());
        preimage.extend_from_slice(entry.created_at.as_bytes());
        preimage.extend_from_slice(entry.action.as_bytes());
        match &entry.actor_pubkey {
            Some(actor) => {
                preimage.push(1);
                preimage.extend_from_slice(&hex::decode(actor)?);
            }
            None => preimage.push(0),
        }
        match &entry.object_id {
            Some(object) => {
                preimage.push(1);
                preimage.extend_from_slice(object.as_bytes());
            }
            None => preimage.push(0),
        }
        preimage.extend_from_slice(canonical_json(&entry.detail)?.as_bytes());
        preimage.extend_from_slice(previous.as_ref().unwrap_or(&[0u8; 32]));
        let hash: [u8; 32] = Sha256::digest(&preimage).into();
        ensure!(hex::encode(hash) == entry.hash, "audit hash mismatch at seq {}", entry.seq);
        previous = Some(hash);

        let object_id = entry.object_id.as_ref().context("EventCreated object id")?;
        ensure!(audited_ids.insert(object_id.clone()), "duplicate audited event id");
        let event = events.get(object_id).context("audit object event row missing")?;
        ensure!(entry.detail["event_kind"] == event.kind, "audit kind detail mismatch");
        let expected_channel = matches!(event.kind, 43_001..=43_006 | 45_001..=45_003)
            .then_some(corpus.channel_id.to_string());
        ensure!(entry.detail["channel_id"] == json!(expected_channel), "audit channel detail");
    }
    let direct_names: BTreeSet<&str> =
        corpus.direct_event_rows.iter().map(String::as_str).collect();
    for fixture in &corpus.events {
        if direct_names.contains(fixture.name.as_str()) {
            ensure!(
                !audited_ids.contains(&fixture.event.id),
                "direct row was unexpectedly audited"
            );
        } else {
            ensure!(audited_ids.contains(&fixture.event.id), "event missing from audit prefix");
        }
    }
    Ok(())
}

fn verify_self_logs(corpus: &Corpus, events: &BTreeMap<String, Event>) -> Result<()> {
    for log in &corpus.self_logs {
        ensure!(log.count == log.entry_event_ids.len() as u64, "self-log count");
        let mut hasher = Sha256::new();
        hasher.update(b"trustgraphs.nostr.self-log.genesis.v1");
        hasher.update(INSTANCE_DOMAIN);
        hasher.update(decode_hex::<32>(&log.author, "self-log author")?);
        let mut head: [u8; 32] = hasher.finalize().into();
        for (index, event_id) in log.entry_event_ids.iter().enumerate() {
            let event = events.get(event_id).context("self-log event row missing")?;
            ensure!(event.pubkey == log.author, "self-log event author");
            let mut hasher = Sha256::new();
            hasher.update(b"trustgraphs.nostr.self-log.entry.v1");
            hasher.update(INSTANCE_DOMAIN);
            hasher.update(decode_hex::<32>(&log.author, "self-log author")?);
            hasher.update(((index + 1) as u64).to_be_bytes());
            hasher.update(head);
            hasher.update(decode_hex::<32>(event_id, "self-log event id")?);
            head = hasher.finalize().into();
        }
        ensure!(hex::encode(head) == log.head, "self-log head");
        let head_event = events.get(&log.head_event_id).context("self-log head event missing")?;
        ensure!(
            head_event.pubkey == log.author && head_event.kind == 36_384,
            "self-head author/kind"
        );
        ensure!(sole_tag(head_event, "head")?[1] == log.head, "self-head tag mismatch");
        ensure!(sole_tag(head_event, "count")?[1] == log.count.to_string(), "self-count tag");
    }
    Ok(())
}

fn verify_envelope_against_corpus(
    corpus: &Corpus,
    artifact: &EnvelopeArtifact,
    bytes: &[u8],
) -> Result<()> {
    ensure!(bytes.len() == artifact.bytes, "TGNW artifact byte length");
    ensure!(hex::encode(Sha256::digest(bytes)) == artifact.sha256, "dataCommitment mismatch");
    let parsed = parse_tgnw(bytes)?;
    ensure!(encode_tgnw(&parsed)? == bytes, "TGNW canonical re-encoding mismatch");
    ensure!(parsed.variant == artifact.variant, "TGNW metadata variant");
    ensure!(parsed.community_id == corpus.community_id, "TGNW community");
    ensure!(parsed.instance_domain == INSTANCE_DOMAIN, "TGNW instance domain");
    ensure!(parsed.audit.len() == artifact.audit_count, "TGNW audit count metadata");
    ensure!(parsed.events.len() == artifact.event_count, "TGNW event count metadata");
    if parsed.variant == 1 {
        ensure!(
            parsed.authority == decode_hex::<32>(&corpus.principals["relay"], "relay authority")?,
            "Option-A relay authority"
        );
        ensure!(parsed.audit == corpus.audit_prefix, "Option-A audit bytes differ from corpus");
        let expected: Vec<Event> = corpus.events.iter().map(|item| item.event.clone()).collect();
        ensure!(parsed.events == expected, "Option-A event bytes differ from corpus");
        ensure!(parsed.head_event.is_none(), "Option-A unexpected head event");
    } else {
        ensure!(corpus.self_logs.len() == 1, "fixture Option-C log count");
        let log = &corpus.self_logs[0];
        ensure!(
            parsed.authority == decode_hex::<32>(&log.author, "self-log authority")?,
            "Option-C author authority"
        );
        let events: BTreeMap<&str, &Event> =
            corpus.events.iter().map(|item| (item.event.id.as_str(), &item.event)).collect();
        let expected: Vec<Event> = log
            .entry_event_ids
            .iter()
            .map(|id| {
                corpus
                    .events
                    .iter()
                    .find(|item| item.event.id == *id)
                    .expect("checked self-log id")
                    .event
                    .clone()
            })
            .collect();
        ensure!(parsed.events == expected, "Option-C event bytes/order differ from corpus");
        let expected_head = events.get(log.head_event_id.as_str()).context("Option-C head row")?;
        ensure!(parsed.head_event.as_ref() == Some(*expected_head), "Option-C head event differs");
        ensure!(parsed.audit.is_empty(), "Option-C audit entries");
    }
    Ok(())
}

fn verify_envelope_artifacts(corpus: &Corpus, directory: &std::path::Path) -> Result<()> {
    ensure!(corpus.envelopes.len() == 2, "fixture envelope artifact count");
    for artifact in &corpus.envelopes {
        let bytes = std::fs::read(directory.join(&artifact.file))
            .with_context(|| format!("reading TGNW artifact {}", artifact.file))?;
        verify_envelope_against_corpus(corpus, artifact, &bytes)
            .with_context(|| format!("verifying TGNW artifact {}", artifact.file))?;
    }
    let option_a = corpus
        .envelopes
        .iter()
        .find(|artifact| artifact.variant == 1)
        .context("Option-A artifact metadata")?;
    for file in ["adversarial/audit-gap.tgnw", "adversarial/changed-bundle-byte.tgnw"] {
        let bytes = std::fs::read(directory.join(file))
            .with_context(|| format!("reading adversarial TGNW artifact {file}"))?;
        ensure!(
            verify_envelope_against_corpus(corpus, option_a, &bytes).is_err(),
            "adversarial artifact {file} unexpectedly verified"
        );
    }
    Ok(())
}

fn verify_adversarial(
    cases: &[AdversarialCase],
    events: &BTreeMap<String, Event>,
    roster: &BTreeSet<String>,
) -> Result<()> {
    for case in cases {
        if let Some(fixture) = &case.event {
            verify_event(fixture)
                .with_context(|| format!("adversarial {} signature", case.name))?;
        }
        match case.name.as_str() {
            "duplicate-auth-tags" => {
                ensure!(tags_named(&case.event.as_ref().unwrap().event, "auth").len() == 2);
                ensure!(case.expected == "skip");
            }
            "oa-created-at-lower-edge" | "oa-created-at-upper-edge" => {
                let event = &case.event.as_ref().unwrap().event;
                let auth = sole_tag(event, "auth")?;
                ensure!(validate_conditions(&auth[2]));
                ensure!(!conditions_apply(&auth[2], event.kind, event.created_at));
                ensure!(case.expected == "skip");
            }
            "wrong-author-e-deletion" => {
                let event = &case.event.as_ref().unwrap().event;
                let target =
                    events.get(&event.tags[0][1]).context("wrong-author target missing")?;
                ensure!(target.pubkey != event.pubkey && case.expected == "skip");
            }
            "missing-referenced-forum-object" => {
                let event = &case.event.as_ref().unwrap().event;
                ensure!(!events.contains_key(&sole_tag(event, "e")?[1]) && case.expected == "skip");
            }
            "agent-owner-not-in-roster" => {
                let event = &case.event.as_ref().unwrap().event;
                let auth = sole_tag(event, "auth")?;
                let owner = verify_oa_tag(auth, &event.pubkey, event.kind, event.created_at)?;
                ensure!(!roster.contains(&owner) && case.expected == "skip");
            }
            "audit-gap" => {
                ensure!(case.expected == "hard-fail" && case.mutation.is_some());
            }
            "changed-bundle-byte" => {
                ensure!(case.expected == "hard-fail" && case.mutation.is_some());
            }
            "duplicate-a-c-event" => {
                let id = case.mutation.as_ref().unwrap()["eventId"]
                    .as_str()
                    .context("duplicate event id")?;
                ensure!(events.contains_key(id) && case.expected == "accept-once");
            }
            other => bail!("unknown adversarial case {other}"),
        }
    }
    Ok(())
}

fn main() -> Result<()> {
    let input = std::env::args_os()
        .nth(1)
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("source-corpus.json"));
    let bytes = std::fs::read(&input)
        .with_context(|| format!("reading source corpus from {}", input.display()))?;
    let corpus: Corpus = serde_json::from_slice(&bytes).context("decoding source corpus")?;
    ensure!(corpus.format == FORMAT, "fixture format pin");
    ensure!(corpus.buzz_sha == BUZZ_SHA, "Buzz SHA pin");
    ensure!(corpus.compatibility_patch_sha256 == PATCH_SHA256, "Buzz patch pin");
    ensure!(corpus.rust_nostr == "0.44.7", "rust-nostr pin");
    ensure!(decode_hex::<32>(&corpus.instance_domain, "instance domain")? == INSTANCE_DOMAIN);

    let published = &corpus.published_oa_vector;
    ensure!(
        published.preimage
            == format!("nostr:agent-auth:{}:{}", published.agent_pubkey, published.conditions),
        "published OA preimage"
    );
    let published_digest: [u8; 32] = Sha256::digest(published.preimage.as_bytes()).into();
    ensure!(hex::encode(published_digest) == published.sha256, "published OA hash");
    verify_schnorr_prehash(&published.owner_pubkey, &published_digest, &published.signature)
        .context("published OA signature")?;

    for case in &corpus.oa_condition_cases {
        ensure!(validate_conditions(&case.conditions) == case.grammar_valid, "OA grammar case");
        let applies = case.grammar_valid
            && conditions_apply(&case.conditions, case.event_kind, case.created_at);
        ensure!(applies == case.applies, "OA application case");
    }
    for vector in &corpus.serializer_vectors {
        verify_event(vector)?;
    }
    for fixture in &corpus.events {
        verify_event(fixture)?;
    }
    ensure_message_api_is_not_nostr(&corpus.events[0].event)?;

    let events: BTreeMap<String, Event> = corpus
        .events
        .iter()
        .map(|fixture| (fixture.event.id.clone(), fixture.event.clone()))
        .collect();
    ensure!(events.len() == corpus.events.len(), "duplicate valid event id");
    let roster_fixture = corpus
        .events
        .iter()
        .find(|fixture| fixture.name == "relay-roster")
        .context("roster fixture missing")?;
    let roster = verify_roster(&corpus, &roster_fixture.event)?;
    for fixture in &corpus.events {
        verify_valid_schema(fixture, &events, &roster, corpus.channel_id)
            .with_context(|| format!("{} schema", fixture.name))?;
    }
    verify_audit(&corpus, &events)?;
    verify_self_logs(&corpus, &events)?;
    verify_envelope_artifacts(
        &corpus,
        input.parent().unwrap_or_else(|| std::path::Path::new(".")),
    )?;

    for replacement in &corpus.replacement_expectations {
        ensure!(replacement.candidates.len() >= 2, "replacement candidates");
        let winner = replacement.candidates.iter().min().unwrap();
        ensure!(winner == &replacement.winner, "replacement tie winner");
        for id in &replacement.candidates {
            let event = events.get(id).context("replacement event missing")?;
            let coordinate =
                format!("{}:{}:{}", event.kind, event.pubkey, sole_tag(event, "d")?[1]);
            ensure!(coordinate == replacement.coordinate, "replacement coordinate");
        }
    }
    verify_adversarial(&corpus.adversarial, &events, &roster)?;

    println!(
        "verified {} events, {} audit rows, {} serializer vectors, {} OA cases, and {} adversarial cases",
        corpus.events.len(),
        corpus.audit_prefix.len(),
        corpus.serializer_vectors.len(),
        corpus.oa_condition_cases.len(),
        corpus.adversarial.len()
    );
    Ok(())
}
