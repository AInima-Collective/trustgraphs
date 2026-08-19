use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use std::str::FromStr;

use anyhow::{ensure, Context, Result};
use chrono::{DateTime, Utc};
use k256::schnorr::signature::hazmat::PrehashVerifier;
use k256::schnorr::{Signature as SchnorrSignature, VerifyingKey as SchnorrVerifyingKey};
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use uuid::Uuid;

const SOURCE_FORMAT: &str = "trustgraphs.nostr.buzz-source-corpus.v1";
const EXPORT_FORMAT: &str = "trustgraphs-buzz-live-db-export-v1";
const SEED_FORMAT: &str = "trustgraphs-buzz-live-seed-report-v1";
const BUZZ_SHA: &str = "a362fecc2389955f942c9581bdfeba379ab115b3";
const PATCH_SHA256: &str = "3129e43e7b8967635bde8dd4a084613ef8628146dd1d1ba2f62e41ced4762a62";

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SourceCorpus {
    format: String,
    buzz_sha: String,
    compatibility_patch_sha256: String,
    rust_nostr: String,
    community_id: Uuid,
    channel_id: Uuid,
    principals: BTreeMap<String, String>,
    serializer_vectors: Vec<FixtureEvent>,
    events: Vec<FixtureEvent>,
    replacement_expectations: Vec<ReplacementExpectation>,
}

#[derive(Clone, Deserialize, PartialEq, Eq)]
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

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReplacementExpectation {
    candidates: Vec<String>,
    winner: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LiveExport {
    format: String,
    buzz_sha: String,
    compatibility_patch_sha256: String,
    rust_nostr: String,
    source_corpus_sha256: String,
    seed_report_sha256: String,
    community: Value,
    nip11: Value,
    channel: Value,
    relay_members: Vec<Value>,
    serializer_vectors: Vec<FixtureEvent>,
    submitted_inputs: Vec<FixtureEvent>,
    seed_report: SeedReport,
    events: Vec<ExportedEvent>,
    audit_prefix: Vec<AuditEntry>,
    audit_event_coverage: Vec<Coverage>,
    direct_event_rows: Vec<String>,
    observations: Value,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ExportedEvent {
    event: Event,
    nip01_preimage: String,
    nip01_preimage_hex: String,
    deleted_at: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AuditEntry {
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
struct Coverage {
    seq: i64,
    event_id: String,
    source: String,
}

#[derive(Clone, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct SeedReport {
    format: String,
    source_corpus: String,
    relay_url: String,
    channel_id: Uuid,
    receipts: Vec<Receipt>,
}

#[derive(Clone, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct Receipt {
    name: String,
    event_id: String,
    kind: u16,
    http_status: u16,
    accepted: bool,
    message: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct NulProbe {
    format: String,
    name: String,
    event_id: String,
    kind: u16,
    nip01_preimage: String,
    nip01_preimage_hex: String,
    event: Event,
    http_status: u16,
    response: Value,
}

fn digest_hex(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

fn decode_hex<const N: usize>(value: &str, label: &str) -> Result<[u8; N]> {
    let bytes = hex::decode(value).with_context(|| format!("decoding {label}"))?;
    bytes.try_into().map_err(|_| anyhow::anyhow!("{label} must be {N} bytes"))
}

struct Cursor<'a> {
    input: &'a [u8],
    offset: usize,
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
        _ => anyhow::bail!("unknown TGNW audit action {code}"),
    })
}

fn parse_tgnw_event(cursor: &mut Cursor<'_>) -> Result<Event> {
    let event_start = cursor.offset;
    let id = hex::encode(cursor.take(32)?);
    let pubkey = hex::encode(cursor.take(32)?);
    let created_at = cursor.u64()?;
    let kind = cursor.u32()?;
    ensure!(kind <= u32::from(u16::MAX), "TGNW event kind exceeds u16");
    let tag_count = usize::try_from(cursor.u32()?)?;
    ensure!(tag_count <= 64, "TGNW tag count exceeds cap");
    let mut tags = Vec::with_capacity(tag_count);
    let mut tag_bytes = 0usize;
    let mut maximum_elements = 0usize;
    let mut maximum_tag_string = 0usize;
    for _ in 0..tag_count {
        let element_count = usize::try_from(cursor.u32()?)?;
        ensure!(element_count <= 8, "TGNW tag element count exceeds cap");
        maximum_elements = maximum_elements.max(element_count);
        let mut tag = Vec::with_capacity(element_count);
        for _ in 0..element_count {
            let element = cursor.string(1_024, "TGNW tag element")?;
            maximum_tag_string = maximum_tag_string.max(element.len());
            tag_bytes = tag_bytes.checked_add(element.len()).context("TGNW tag byte overflow")?;
            ensure!(tag_bytes <= 16_384, "TGNW total tag bytes exceed cap");
            tag.push(element);
        }
        tags.push(tag);
    }
    let content = cursor.string(65_536, "TGNW event content")?;
    let sig = hex::encode(cursor.take(64)?);
    verify_event_caps(
        cursor.offset - event_start,
        content.len(),
        tag_count,
        maximum_elements,
        maximum_tag_string,
        tag_bytes,
    )?;
    Ok(Event { id, pubkey, created_at, kind: kind as u16, tags, content, sig })
}

fn verify_event_caps(
    encoded_bytes: usize,
    content_bytes: usize,
    tags: usize,
    maximum_elements: usize,
    maximum_tag_string: usize,
    all_tag_strings: usize,
) -> Result<()> {
    ensure!(encoded_bytes <= 131_072, "encoded event exceeds cap");
    ensure!(content_bytes <= 65_536, "event content exceeds cap");
    ensure!(tags <= 64, "tags per event exceed cap");
    ensure!(maximum_elements <= 8, "tag elements exceed cap");
    ensure!(maximum_tag_string <= 1_024, "tag string exceeds cap");
    ensure!(all_tag_strings <= 16_384, "all tag strings exceed cap");
    Ok(())
}

fn verify_work_caps(
    bundle_bytes: usize,
    selected_heads: usize,
    audit_entries: usize,
    events: usize,
    signature_checks: usize,
    oa_checks: usize,
) -> Result<()> {
    ensure!(bundle_bytes <= 12_582_912, "TGNW envelope exceeds byte cap");
    ensure!(selected_heads <= 129, "selected-head count exceeds cap");
    ensure!(audit_entries <= 4_096, "audit-entry count exceeds cap");
    ensure!(events <= 512, "event count exceeds cap");
    ensure!(signature_checks <= 640, "NIP-01 signature count exceeds cap");
    ensure!(oa_checks <= 256, "NIP-OA signature count exceeds cap");
    Ok(())
}

fn estimated_pgu(
    bundle_bytes: usize,
    audit_entries: usize,
    signature_checks: usize,
    oa_checks: usize,
) -> Result<u64> {
    let subtotal = 24u64
        .checked_mul(u64::try_from(bundle_bytes)?)
        .and_then(|value| value.checked_add(12_000u64.checked_mul(audit_entries as u64)?))
        .and_then(|value| value.checked_add(71_000u64.checked_mul(signature_checks as u64)?))
        .and_then(|value| value.checked_add(62_000u64.checked_mul(oa_checks as u64)?))
        .and_then(|value| value.checked_add(1_000_000))
        .context("work estimate overflow")?;
    subtotal.checked_mul(2).context("work estimate safety-factor overflow")
}

fn verify_pilot_caps(
    bundle_bytes: usize,
    audit_entries: usize,
    events: usize,
    signature_checks: usize,
    oa_checks: usize,
) -> Result<u64> {
    verify_work_caps(bundle_bytes, 1, audit_entries, events, signature_checks, oa_checks)?;
    ensure!(bundle_bytes <= 4_194_304, "pilot bundle exceeds cap");
    ensure!(audit_entries <= 2_048, "pilot audit entries exceed cap");
    ensure!(oa_checks <= 128, "pilot OA checks exceed cap");
    let estimate = estimated_pgu(bundle_bytes, audit_entries, signature_checks, oa_checks)?;
    ensure!(estimate <= 400_000_000, "pilot work estimate exceeds cap");
    Ok(estimate)
}

fn verify_live_tgnw(bytes: &[u8], export: &LiveExport) -> Result<String> {
    let mut cursor = Cursor::new(bytes)?;
    ensure!(cursor.take(4)? == b"TGNW", "TGNW magic");
    ensure!(cursor.byte()? == 1, "TGNW version");
    ensure!(cursor.byte()? == 1, "TGNW commitment variant");
    ensure!(cursor.u16()? == 0, "TGNW reserved flags");
    let community = Uuid::from_bytes(cursor.take(16)?.try_into().unwrap());
    ensure!(
        export.community.get("id").and_then(Value::as_str) == Some(community.to_string().as_str()),
        "TGNW community"
    );
    ensure!(cursor.take(32)? == [0x42; 32], "TGNW instance domain");
    let authority = hex::encode(cursor.take(32)?);
    ensure!(
        export.nip11.get("self").and_then(Value::as_str) == Some(authority.as_str()),
        "TGNW relay authority"
    );

    let audit_count = usize::try_from(cursor.u32()?)?;
    ensure!(audit_count <= 4_096, "TGNW audit count exceeds cap");
    ensure!(audit_count == export.audit_prefix.len(), "TGNW audit count");
    for expected in &export.audit_prefix {
        let seq = cursor.u64()?;
        let hash = hex::encode(cursor.take(32)?);
        let prev_hash = match cursor.byte()? {
            0 => None,
            1 => Some(hex::encode(cursor.take(32)?)),
            other => anyhow::bail!("invalid TGNW prev_hash presence {other}"),
        };
        let action = action_name(cursor.byte()?)?;
        let actor_pubkey = match cursor.byte()? {
            0 => None,
            1 => Some(hex::encode(cursor.take(32)?)),
            other => anyhow::bail!("invalid TGNW actor presence {other}"),
        };
        let object_id = match cursor.byte()? {
            0 => None,
            1 => Some(cursor.string(1_024, "TGNW object id")?),
            other => anyhow::bail!("invalid TGNW object presence {other}"),
        };
        let created_at = cursor.string(64, "TGNW audit timestamp")?;
        let detail = cursor.string(4_096, "TGNW audit detail")?;
        ensure!(seq == u64::try_from(expected.seq)?, "TGNW audit sequence");
        ensure!(hash == expected.hash, "TGNW audit hash");
        ensure!(prev_hash == expected.prev_hash, "TGNW audit previous hash");
        ensure!(action == expected.action, "TGNW audit action");
        ensure!(actor_pubkey == expected.actor_pubkey, "TGNW audit actor");
        ensure!(object_id == expected.object_id, "TGNW audit object");
        ensure!(created_at == expected.created_at, "TGNW audit timestamp");
        ensure!(detail == canonical_json(&expected.detail)?, "TGNW canonical audit detail");
    }

    let event_count = usize::try_from(cursor.u32()?)?;
    ensure!(event_count <= 512, "TGNW event count exceeds cap");
    ensure!(event_count == export.events.len(), "TGNW event count");
    for expected in &export.events {
        let event_start = cursor.offset;
        ensure!(parse_tgnw_event(&mut cursor)? == expected.event, "TGNW event bytes differ");
        ensure!(cursor.offset - event_start <= 131_072, "TGNW encoded event exceeds cap");
    }
    ensure!(cursor.finished(), "trailing TGNW bytes");
    let oa_count = export
        .events
        .iter()
        .filter(|row| {
            row.event
                .tags
                .iter()
                .filter(|tag| tag.first().map(String::as_str) == Some("auth"))
                .count()
                == 1
        })
        .count();
    verify_work_caps(bytes.len(), 1, audit_count, event_count, event_count, oa_count)?;
    verify_pilot_caps(bytes.len(), audit_count, event_count, event_count, oa_count)?;
    Ok(digest_hex(bytes))
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
        scalar => serde_json::to_string(scalar).map_err(anyhow::Error::from),
    }
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

fn verify_event(name: &str, event: &Event, expected_text: &str, expected_hex: &str) -> Result<()> {
    let preimage = serde_json::to_string(&json!([
        0,
        &event.pubkey,
        event.created_at,
        event.kind,
        &event.tags,
        &event.content
    ]))?;
    ensure!(preimage == expected_text, "{name}: NIP-01 text differs");
    ensure!(hex::encode(preimage.as_bytes()) == expected_hex, "{name}: NIP-01 hex differs");
    let id: [u8; 32] = Sha256::digest(preimage.as_bytes()).into();
    ensure!(hex::encode(id) == event.id, "{name}: event id differs");
    verify_schnorr_prehash(&event.pubkey, &id, &event.sig)
        .with_context(|| format!("{name}: event signature"))
}

fn verify_fixture(fixture: &FixtureEvent) -> Result<()> {
    verify_event(
        &fixture.name,
        &fixture.event,
        &fixture.nip01_preimage,
        &fixture.nip01_preimage_hex,
    )
}

fn verify_audit(
    export: &LiveExport,
    events: &BTreeMap<String, &Event>,
) -> Result<BTreeSet<String>> {
    let community_id = Uuid::parse_str(
        export.community.get("id").and_then(Value::as_str).context("exported community id")?,
    )?;
    let channel_id =
        export.channel.get("id").and_then(Value::as_str).context("exported channel id")?;
    let mut previous: Option<[u8; 32]> = None;
    let mut object_ids = BTreeSet::new();
    for (index, entry) in export.audit_prefix.iter().enumerate() {
        ensure!(entry.community_id == community_id, "audit community mismatch");
        ensure!(entry.seq == (index + 1) as i64, "audit sequence gap");
        let recorded_previous = entry
            .prev_hash
            .as_deref()
            .map(|value| decode_hex::<32>(value, "audit prev_hash"))
            .transpose()?;
        ensure!(recorded_previous == previous, "audit prev_hash mismatch");
        let parsed = DateTime::<Utc>::from_str(&entry.created_at)?;
        ensure!(parsed.to_rfc3339() == entry.created_at, "non-canonical audit timestamp");
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

        ensure!(entry.action == "event_created", "unexpected live audit action");
        let object_id = entry.object_id.as_ref().context("EventCreated object id")?;
        ensure!(object_ids.insert(object_id.clone()), "duplicate audit object id");
        let event = events.get(object_id).context("audit object missing from DB rows")?;
        ensure!(entry.detail["event_kind"] == event.kind, "audit event kind mismatch");
        let expected_channel = matches!(event.kind, 39000..=39002 | 43001..=43006 | 44100 | 45001..=45003 | 9000..=9022)
            .then_some(channel_id);
        ensure!(entry.detail["channel_id"] == json!(expected_channel), "audit channel mismatch");
    }
    Ok(object_ids)
}

fn verify_roster(export: &LiveExport, events: &BTreeMap<String, &Event>) -> Result<()> {
    let relay_key = export.nip11.get("self").and_then(Value::as_str).context("NIP-11 self key")?;
    decode_hex::<32>(relay_key, "NIP-11 self key")?;
    let rosters: Vec<&Event> =
        events.values().copied().filter(|event| event.kind == 13_534).collect();
    ensure!(rosters.len() == 1, "expected exactly one live roster event");
    let roster = rosters[0];
    ensure!(roster.pubkey == relay_key && roster.content.is_empty(), "live roster signer/content");
    ensure!(roster.tags.first().is_some_and(|tag| tag.as_slice() == ["-"]), "roster '-' tag");
    let roster_members: BTreeSet<(String, String)> = roster
        .tags
        .iter()
        .skip(1)
        .map(|tag| {
            ensure!(tag.len() == 3 && tag[0] == "member", "roster member tag grammar");
            Ok((tag[1].clone(), tag[2].clone()))
        })
        .collect::<Result<_>>()?;
    let db_members: BTreeSet<(String, String)> = export
        .relay_members
        .iter()
        .map(|member| {
            Ok((
                member
                    .get("pubkey")
                    .and_then(Value::as_str)
                    .context("relay member pubkey")?
                    .to_owned(),
                member.get("role").and_then(Value::as_str).context("relay member role")?.to_owned(),
            ))
        })
        .collect::<Result<_>>()?;
    ensure!(roster_members == db_members, "roster and relay_members differ");
    ensure!(
        export.direct_event_rows.contains(&roster.id),
        "roster is not recorded as a direct row"
    );
    Ok(())
}

fn load<T: for<'de> Deserialize<'de>>(path: &Path, label: &str) -> Result<(Vec<u8>, T)> {
    let bytes =
        std::fs::read(path).with_context(|| format!("reading {label} {}", path.display()))?;
    let value = serde_json::from_slice(&bytes).with_context(|| format!("decoding {label}"))?;
    Ok((bytes, value))
}

fn main() -> Result<()> {
    let mut args = std::env::args_os().skip(1);
    let export_path =
        args.next().map(PathBuf::from).unwrap_or_else(|| PathBuf::from("live-export.json"));
    let directory = export_path.parent().unwrap_or_else(|| Path::new("."));
    let source_path =
        args.next().map(PathBuf::from).unwrap_or_else(|| directory.join("source-corpus.json"));
    let seed_path =
        args.next().map(PathBuf::from).unwrap_or_else(|| directory.join("seed-report.json"));
    let probe_path =
        args.next().map(PathBuf::from).unwrap_or_else(|| directory.join("nul-ingest-probe.json"));
    let bundle_path =
        args.next().map(PathBuf::from).unwrap_or_else(|| directory.join("live-option-a.tgnw"));
    ensure!(args.next().is_none(), "unexpected extra verify_live_export argument");

    let (_, export): (Vec<u8>, LiveExport) = load(&export_path, "live export")?;
    let (source_bytes, source): (Vec<u8>, SourceCorpus) = load(&source_path, "live source corpus")?;
    let (seed_bytes, seed): (Vec<u8>, SeedReport) = load(&seed_path, "live seed report")?;
    let (_, probe): (Vec<u8>, NulProbe) = load(&probe_path, "NUL ingest probe")?;
    let bundle_bytes = std::fs::read(&bundle_path)
        .with_context(|| format!("reading live TGNW bundle {}", bundle_path.display()))?;
    ensure!(export.format == EXPORT_FORMAT, "live export format pin");
    ensure!(source.format == SOURCE_FORMAT, "source corpus format pin");
    ensure!(seed.format == SEED_FORMAT, "seed report format pin");
    ensure!(probe.format == "trustgraphs-buzz-nul-ingest-probe-v1", "NUL probe format pin");
    for (buzz, patch, nostr) in [
        (&export.buzz_sha, &export.compatibility_patch_sha256, &export.rust_nostr),
        (&source.buzz_sha, &source.compatibility_patch_sha256, &source.rust_nostr),
    ] {
        ensure!(buzz == BUZZ_SHA, "Buzz SHA pin");
        ensure!(patch == PATCH_SHA256, "compatibility patch pin");
        ensure!(nostr == "0.44.7", "rust-nostr pin");
    }
    ensure!(digest_hex(&source_bytes) == export.source_corpus_sha256, "source corpus digest");
    ensure!(digest_hex(&seed_bytes) == export.seed_report_sha256, "seed report digest");
    ensure!(seed == export.seed_report, "embedded seed report differs");
    ensure!(source.channel_id == seed.channel_id, "seed channel differs from source corpus");
    ensure!(
        export.community.get("id").and_then(Value::as_str)
            == Some(source.community_id.to_string().as_str()),
        "exported community differs from source corpus"
    );
    ensure!(
        export.channel.get("id").and_then(Value::as_str)
            == Some(source.channel_id.to_string().as_str()),
        "exported channel differs from source corpus"
    );

    for fixture in source.serializer_vectors.iter().chain(&source.events) {
        verify_fixture(fixture)?;
    }
    ensure!(export.serializer_vectors == source.serializer_vectors, "serializer vectors differ");

    let source_by_name: BTreeMap<&str, &FixtureEvent> =
        source.events.iter().map(|fixture| (fixture.name.as_str(), fixture)).collect();
    let submitted_by_name: BTreeMap<&str, &FixtureEvent> =
        export.submitted_inputs.iter().map(|fixture| (fixture.name.as_str(), fixture)).collect();
    ensure!(submitted_by_name.len() == seed.receipts.len(), "submitted input/receipt count");
    for receipt in &seed.receipts {
        ensure!(receipt.http_status == 200 && receipt.accepted, "seed receipt was not accepted");
        let source_input =
            source_by_name.get(receipt.name.as_str()).context("receipt source input")?;
        let embedded = submitted_by_name.get(receipt.name.as_str()).context("embedded input")?;
        ensure!(*source_input == *embedded, "embedded submitted input differs");
        ensure!(receipt.event_id == embedded.event.id && receipt.kind == embedded.event.kind);
    }

    let mut db_events = BTreeMap::new();
    for row in &export.events {
        verify_event(
            &format!("db-event-{}", row.event.id),
            &row.event,
            &row.nip01_preimage,
            &row.nip01_preimage_hex,
        )?;
        ensure!(
            db_events.insert(row.event.id.clone(), &row.event).is_none(),
            "duplicate DB event id"
        );
        if let Some(deleted_at) = &row.deleted_at {
            DateTime::<Utc>::from_str(deleted_at).context("soft-delete timestamp")?;
        }
    }
    let audit_ids = verify_audit(&export, &db_events)?;
    let db_ids: BTreeSet<String> = db_events.keys().cloned().collect();
    let expected_direct: BTreeSet<String> = db_ids.difference(&audit_ids).cloned().collect();
    ensure!(
        export.direct_event_rows.iter().cloned().collect::<BTreeSet<_>>() == expected_direct,
        "direct event row set differs from DB-minus-audit"
    );
    ensure!(export.audit_event_coverage.len() == export.audit_prefix.len());
    for (entry, coverage) in export.audit_prefix.iter().zip(&export.audit_event_coverage) {
        ensure!(
            coverage.seq == entry.seq && coverage.event_id == entry.object_id.as_deref().unwrap()
        );
        ensure!(coverage.source == "database", "audit coverage is not database-backed");
    }
    verify_roster(&export, &db_events)?;
    let data_commitment = verify_live_tgnw(&bundle_bytes, &export)?;

    verify_event(&probe.name, &probe.event, &probe.nip01_preimage, &probe.nip01_preimage_hex)?;
    ensure!(probe.name == "nip01-controls-unicode");
    ensure!(probe.event_id == probe.event.id && probe.kind == 1 && probe.event.kind == 1);
    ensure!(probe.event.content.contains('\0'));
    ensure!(probe.event.tags.iter().flatten().any(|value| value.contains('\0')));
    ensure!(probe.http_status == 500);
    ensure!(probe.response["error"] == "internal server error");
    ensure!(!db_ids.contains(&probe.event_id) && !audit_ids.contains(&probe.event_id));
    let controls_vector = source
        .serializer_vectors
        .iter()
        .find(|fixture| fixture.name == "nip01-controls-unicode")
        .context("controls serializer vector")?;
    ensure!(probe.event.pubkey == controls_vector.event.pubkey);
    ensure!(probe.event.tags == controls_vector.event.tags);
    ensure!(probe.event.content == controls_vector.event.content);

    let alice = source.principals.get("alice").context("Alice principal")?;
    let bob = source.principals.get("bob").context("Bob principal")?;
    let agent = source.principals.get("agent").context("agent principal")?;
    let relay_pubkeys: BTreeSet<&str> = export
        .relay_members
        .iter()
        .filter_map(|member| member.get("pubkey").and_then(Value::as_str))
        .collect();
    ensure!(relay_pubkeys == BTreeSet::from([alice.as_str(), bob.as_str()]));
    ensure!(!relay_pubkeys.contains(agent.as_str()), "OA agent unexpectedly appears in roster");

    ensure!(source.replacement_expectations.len() == 1, "replacement expectation count");
    let replacement = &source.replacement_expectations[0];
    let winner = replacement.candidates.iter().min().context("replacement candidates")?;
    ensure!(winner == &replacement.winner && db_ids.contains(winner), "replacement winner");
    let loser = replacement
        .candidates
        .iter()
        .find(|candidate| *candidate != winner)
        .context("replacement loser")?;
    ensure!(!db_ids.contains(loser) && !audit_ids.contains(loser), "replacement loser persisted");
    let loser_receipt = seed
        .receipts
        .iter()
        .find(|receipt| &receipt.event_id == loser)
        .context("replacement loser receipt")?;
    ensure!(loser_receipt.message == "duplicate:", "replacement loser response changed");

    ensure!(export.observations["databaseEventCount"] == export.events.len());
    ensure!(export.observations["auditRowCount"] == export.audit_prefix.len());
    ensure!(export.observations["directEventRowCount"] == export.direct_event_rows.len());
    println!(
        "verified live export: {} DB events, {} audit rows, {} direct rows, {} submitted inputs; TGNW {} bytes / {}",
        export.events.len(),
        export.audit_prefix.len(),
        export.direct_event_rows.len(),
        export.submitted_inputs.len(),
        bundle_bytes.len(),
        data_commitment,
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn live_directory() -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../live")
    }

    fn mutation_offsets(bytes: &[u8]) -> Result<Vec<(&'static str, usize)>> {
        let mut output = vec![
            ("magic", 0),
            ("version", 4),
            ("variant", 5),
            ("flags", 6),
            ("community", 8),
            ("instance-domain", 24),
            ("authority", 56),
            ("audit-count", 88),
        ];
        let mut cursor = Cursor::new(bytes)?;
        cursor.take(88)?;
        let audit_count = usize::try_from(cursor.u32()?)?;
        for index in 0..audit_count {
            if index == 0 {
                output.push(("audit-sequence", cursor.offset));
            }
            cursor.take(8)?;
            if index == 0 {
                output.push(("audit-hash", cursor.offset));
            }
            cursor.take(32)?;
            if index == 0 {
                output.push(("audit-prev-presence", cursor.offset));
            }
            if cursor.byte()? == 1 {
                if index == 1 {
                    output.push(("audit-prev-hash", cursor.offset));
                }
                cursor.take(32)?;
            }
            if index == 0 {
                output.push(("audit-action", cursor.offset));
            }
            cursor.byte()?;
            if index == 0 {
                output.push(("audit-actor-presence", cursor.offset));
            }
            if cursor.byte()? == 1 {
                if index == 0 {
                    output.push(("audit-actor", cursor.offset));
                }
                cursor.take(32)?;
            }
            if index == 0 {
                output.push(("audit-object-presence", cursor.offset));
            }
            if cursor.byte()? == 1 {
                let length_offset = cursor.offset;
                let length = usize::try_from(cursor.u32()?)?;
                if index == 0 {
                    output.push(("audit-object-length", length_offset));
                    output.push(("audit-object", cursor.offset));
                }
                cursor.take(length)?;
            }
            for (length_name, value_name) in
                [("audit-time-length", "audit-time"), ("audit-detail-length", "audit-detail")]
            {
                let length_offset = cursor.offset;
                let length = usize::try_from(cursor.u32()?)?;
                if index == 0 {
                    output.push((length_name, length_offset));
                    output.push((value_name, cursor.offset));
                }
                cursor.take(length)?;
            }
        }

        output.push(("event-count", cursor.offset));
        let event_count = usize::try_from(cursor.u32()?)?;
        ensure!(event_count > 0, "live fixture needs an event");
        let mut found_content = false;
        for event_index in 0..event_count {
            if event_index == 0 {
                output.push(("event-id", cursor.offset));
            }
            cursor.take(32)?;
            if event_index == 0 {
                output.push(("event-pubkey", cursor.offset));
            }
            cursor.take(32)?;
            if event_index == 0 {
                output.push(("event-created-at", cursor.offset));
            }
            cursor.take(8)?;
            if event_index == 0 {
                output.push(("event-kind", cursor.offset));
            }
            cursor.take(4)?;
            if event_index == 0 {
                output.push(("event-tag-count", cursor.offset));
            }
            let tag_count = usize::try_from(cursor.u32()?)?;
            for tag_index in 0..tag_count {
                if event_index == 0 && tag_index == 0 {
                    output.push(("tag-element-count", cursor.offset));
                }
                let element_count = usize::try_from(cursor.u32()?)?;
                for element_index in 0..element_count {
                    let length_offset = cursor.offset;
                    let length = usize::try_from(cursor.u32()?)?;
                    if event_index == 0 && tag_index == 0 && element_index == 0 {
                        output.push(("tag-string-length", length_offset));
                        output.push(("tag-string", cursor.offset));
                    }
                    cursor.take(length)?;
                }
            }
            if event_index == 0 {
                output.push(("content-length", cursor.offset));
            }
            let content_length = usize::try_from(cursor.u32()?)?;
            if !found_content && content_length > 0 {
                output.push(("content", cursor.offset));
                found_content = true;
            }
            cursor.take(content_length)?;
            if event_index == 0 {
                output.push(("signature", cursor.offset));
            }
            cursor.take(64)?;
        }
        ensure!(found_content, "live fixture needs non-empty content");
        Ok(output)
    }

    #[test]
    fn every_tgnw_field_mutation_is_rejected() -> Result<()> {
        let directory = live_directory();
        let (_, export): (Vec<u8>, LiveExport) =
            load(&directory.join("live-export.json"), "export")?;
        let bytes = std::fs::read(directory.join("live-option-a.tgnw"))?;
        let commitment = digest_hex(&bytes);
        verify_live_tgnw(&bytes, &export)?;
        let offsets = mutation_offsets(&bytes)?;
        ensure!(offsets.len() >= 25, "mutation suite unexpectedly small");
        for (name, offset) in offsets {
            let mut changed = bytes.clone();
            changed[offset] ^= 1;
            ensure!(digest_hex(&changed) != commitment, "{name}: commitment did not change");
            ensure!(
                verify_live_tgnw(&changed, &export).is_err(),
                "{name}: changed TGNW field was accepted"
            );
        }
        Ok(())
    }

    #[test]
    fn aggregate_hard_caps_accept_boundary_and_reject_next_value() {
        assert!(verify_work_caps(12_582_912, 129, 4_096, 512, 640, 256).is_ok());
        assert_eq!(estimated_pgu(12_582_912, 4_096, 640, 256).unwrap(), 826_907_776);
        for rejected in [
            verify_work_caps(12_582_913, 129, 4_096, 512, 640, 256),
            verify_work_caps(12_582_912, 130, 4_096, 512, 640, 256),
            verify_work_caps(12_582_912, 129, 4_097, 512, 640, 256),
            verify_work_caps(12_582_912, 129, 4_096, 513, 640, 256),
            verify_work_caps(12_582_912, 129, 4_096, 512, 641, 256),
            verify_work_caps(12_582_912, 129, 4_096, 512, 640, 257),
        ] {
            assert!(rejected.is_err());
        }
    }

    #[test]
    fn per_event_caps_accept_boundary_and_reject_next_value() {
        assert!(verify_event_caps(131_072, 65_536, 64, 8, 1_024, 16_384).is_ok());
        for rejected in [
            verify_event_caps(131_073, 65_536, 64, 8, 1_024, 16_384),
            verify_event_caps(131_072, 65_537, 64, 8, 1_024, 16_384),
            verify_event_caps(131_072, 65_536, 65, 8, 1_024, 16_384),
            verify_event_caps(131_072, 65_536, 64, 9, 1_024, 16_384),
            verify_event_caps(131_072, 65_536, 64, 8, 1_025, 16_384),
            verify_event_caps(131_072, 65_536, 64, 8, 1_024, 16_385),
        ] {
            assert!(rejected.is_err());
        }
    }

    #[test]
    fn pilot_caps_and_work_model_are_enforced() {
        assert_eq!(verify_pilot_caps(4_194_304, 2_048, 512, 640, 128).unwrap(), 359_230_592);
        assert_eq!(estimated_pgu(20_297, 30, 35, 3).unwrap(), 9_036_256);
        assert!(verify_pilot_caps(4_194_305, 2_048, 512, 640, 128).is_err());
        assert!(verify_pilot_caps(4_194_304, 2_049, 512, 640, 128).is_err());
        assert!(verify_pilot_caps(4_194_304, 2_048, 512, 640, 129).is_err());
        assert!(verify_pilot_caps(4_194_304, 2_048, 512, 640, 256).is_err());
    }

    #[test]
    fn string_caps_accept_boundary_and_reject_next_value() -> Result<()> {
        for maximum in [64usize, 1_024, 4_096, 65_536] {
            let mut boundary = Vec::with_capacity(4 + maximum);
            boundary.extend_from_slice(&u32::try_from(maximum)?.to_be_bytes());
            boundary.resize(4 + maximum, b'x');
            assert_eq!(Cursor::new(&boundary)?.string(maximum, "boundary")?.len(), maximum);

            let mut above = Vec::new();
            above.extend_from_slice(&u32::try_from(maximum + 1)?.to_be_bytes());
            assert!(Cursor::new(&above)?.string(maximum, "above").is_err());
        }
        assert!(Cursor::new(&vec![0u8; 12_582_912]).is_ok());
        assert!(Cursor::new(&vec![0u8; 12_582_913]).is_err());
        Ok(())
    }

    #[test]
    fn checked_in_cap_fixture_matches_code() -> Result<()> {
        let bytes = std::fs::read(live_directory().join("adversarial/cap-boundaries.json"))?;
        let fixture: Value = serde_json::from_slice(&bytes)?;
        ensure!(fixture["format"] == "trustgraphs.nostr.tgnw-cap-boundaries.v1");
        let cases = fixture["cases"].as_array().context("cap cases")?;
        ensure!(cases.len() == 17, "cap fixture case count");
        for case in cases {
            let maximum = case["maximum"].as_u64().context("cap maximum")?;
            let rejected = case["firstRejected"].as_u64().context("cap firstRejected")?;
            ensure!(rejected == maximum + 1, "cap boundary is not adjacent");
        }
        ensure!(cases[0]["maximum"] == 12_582_912);
        ensure!(cases[1]["maximum"] == 129);
        ensure!(cases[2]["maximum"] == 4_096);
        ensure!(cases[3]["maximum"] == 512);
        ensure!(cases[11]["maximum"] == 640);
        ensure!(cases[12]["maximum"] == 256);
        ensure!(cases[16]["maximum"] == 400_000_000);
        Ok(())
    }
}
