use std::path::{Path, PathBuf};

use anyhow::{ensure, Context, Result};
use k256::schnorr::signature::hazmat::PrehashSigner;
use k256::schnorr::{Signature, SigningKey};
use rand::rngs::StdRng;
use rand::SeedableRng;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use sp1_sdk::blocking::{EnvProver, Prover, ProverClient};
use sp1_sdk::{include_elf, Elf, SP1Stdin};

const ELF_SCHNORR: Elf = include_elf!("nostr-bench-schnorr");
const ELF_EVENT: Elf = include_elf!("nostr-bench-event");
const ELF_AUDIT: Elf = include_elf!("nostr-bench-audit");
const ELF_OA: Elf = include_elf!("nostr-bench-oa");
const ELF_ENVELOPE: Elf = include_elf!("nostr-bench-envelope");

type SchnorrCase = (Vec<u8>, Vec<u8>, Vec<u8>);
type EventCase = (Vec<u8>, u64, u16, Vec<Vec<String>>, String, Vec<u8>, Vec<u8>);
type AuditCase = (
    Vec<u8>,
    u64,
    String,
    String,
    Option<Vec<u8>>,
    Option<String>,
    String,
    Option<Vec<u8>>,
    Vec<u8>,
);
type OaCase = (Vec<u8>, Vec<u8>, String, Vec<u8>, u16, u64);

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LiveExport {
    community: Value,
    nip11: Value,
    events: Vec<ExportedEvent>,
    audit_prefix: Vec<AuditEntry>,
}

#[derive(Clone, Deserialize)]
struct ExportedEvent {
    event: Event,
}

#[derive(Clone, Deserialize)]
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
struct AuditEntry {
    community_id: String,
    seq: u64,
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
struct Results {
    format: &'static str,
    sp1: &'static str,
    cargo_prove: &'static str,
    live_event_count: usize,
    live_audit_count: usize,
    live_oa_count: usize,
    live_bundle_bytes: usize,
    live_data_commitment: String,
    measurements: Vec<Measurement>,
    derived: Vec<Derived>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Measurement {
    label: String,
    count: usize,
    cycles: u64,
    pgu: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Derived {
    label: String,
    numerator: String,
    denominator: u64,
    cycles_per_operation: u64,
    pgu_per_operation: u64,
}

fn run<T: Serialize>(
    client: &EnvProver,
    elf: Elf,
    label: &str,
    count: usize,
    input: &T,
) -> Result<Measurement> {
    let mut stdin = SP1Stdin::new();
    stdin.write(input);
    let (_public, report) =
        client.execute(elf, stdin).run().with_context(|| format!("executing {label}"))?;
    let result = Measurement {
        label: label.to_owned(),
        count,
        cycles: report.total_instruction_count(),
        pgu: report.gas().unwrap_or(0),
    };
    println!("RESULT,{},{},{},{}", result.label, result.count, result.cycles, result.pgu);
    Ok(result)
}

fn canonical_json(value: &Value) -> Result<String> {
    match value {
        Value::Object(map) => {
            let mut fields: Vec<_> = map.iter().collect();
            fields.sort_unstable_by(|left, right| left.0.cmp(right.0));
            let mut output = String::from("{");
            for (index, (key, value)) in fields.into_iter().enumerate() {
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

fn audit_hash(case: &AuditCase) -> Result<[u8; 32]> {
    let (community, sequence, created_at, action, actor, object_id, detail, previous, _) = case;
    ensure!(community.len() == 16, "audit community must be UUID bytes");
    let mut preimage = Vec::with_capacity(256);
    preimage.extend_from_slice(community);
    preimage.extend_from_slice(&sequence.to_be_bytes());
    preimage.extend_from_slice(created_at.as_bytes());
    preimage.extend_from_slice(action.as_bytes());
    match actor {
        Some(actor) => {
            ensure!(actor.len() == 32, "audit actor must be 32 bytes");
            preimage.push(1);
            preimage.extend_from_slice(actor);
        }
        None => preimage.push(0),
    }
    match object_id {
        Some(object_id) => {
            preimage.push(1);
            preimage.extend_from_slice(object_id.as_bytes());
        }
        None => preimage.push(0),
    }
    preimage.extend_from_slice(detail.as_bytes());
    preimage.extend_from_slice(previous.as_deref().unwrap_or(&[0u8; 32]));
    Ok(Sha256::digest(preimage).into())
}

fn generated_audit_cases(count: usize) -> Result<Vec<AuditCase>> {
    let community = vec![0x42; 16];
    let actor = vec![0x24; 32];
    let mut previous: Option<Vec<u8>> = None;
    let mut cases = Vec::with_capacity(count);
    for index in 0..count {
        let object_id = hex::encode(Sha256::digest(format!("audit-object-{index}").as_bytes()));
        let mut case = (
            community.clone(),
            (index + 1) as u64,
            format!("2026-08-19T00:00:{:02}.123456+00:00", index % 60),
            "event_created".to_owned(),
            Some(actor.clone()),
            Some(object_id),
            format!(r#"{{"channel_id":null,"event_kind":{}}}"#, 36_382 + index % 3),
            previous.clone(),
            Vec::new(),
        );
        let hash = audit_hash(&case)?;
        case.8 = hash.to_vec();
        previous = Some(hash.to_vec());
        cases.push(case);
    }
    Ok(cases)
}

fn generated_oa_cases(count: usize) -> Result<Vec<OaCase>> {
    let mut rng = StdRng::seed_from_u64(0x4f41_5f42_454e_4348 ^ count as u64);
    let mut cases = Vec::with_capacity(count);
    for index in 0..count {
        let owner = SigningKey::random(&mut rng);
        let agent = SigningKey::random(&mut rng);
        let owner_pubkey = owner.verifying_key().to_bytes().to_vec();
        let agent_pubkey = agent.verifying_key().to_bytes().to_vec();
        let kind = 43_004;
        let created_at = 1_760_000_000 + index as u64;
        let conditions =
            format!("kind={kind}&created_at>{}&created_at<{}", created_at - 1, created_at + 1);
        let preimage = format!("nostr:agent-auth:{}:{conditions}", hex::encode(&agent_pubkey));
        let digest: [u8; 32] = Sha256::digest(preimage.as_bytes()).into();
        let signature: Signature = owner.sign_prehash(&digest)?;
        cases.push((
            agent_pubkey,
            owner_pubkey,
            conditions,
            signature.to_bytes().to_vec(),
            kind,
            created_at,
        ));
    }
    Ok(cases)
}

fn generated_cases(count: usize) -> Result<(Vec<SchnorrCase>, Vec<EventCase>)> {
    let mut rng = StdRng::seed_from_u64(0x004e_4f53_5452 ^ count as u64);
    let mut schnorr = Vec::with_capacity(count);
    let mut events = Vec::with_capacity(count);
    for index in 0..count {
        let key = SigningKey::random(&mut rng);
        let pubkey = key.verifying_key().to_bytes().to_vec();
        let created_at = 1_760_000_000 + index as u64;
        let kind = 36_382;
        let control = char::from((index % 32) as u8);
        let tags = vec![
            vec!["d".to_owned(), hex::encode(&pubkey)],
            vec!["probe".to_owned(), format!("quote:\" slash:\\ control:{control} 雪 🦀")],
        ];
        let content = format!("nostr-bench-{index}-{control}-雪-🦀");
        let preimage = serde_json::to_vec(&json!([
            0,
            hex::encode(&pubkey),
            created_at,
            kind,
            &tags,
            &content
        ]))?;
        let id: [u8; 32] = Sha256::digest(&preimage).into();
        let signature: Signature = key.sign_prehash(&id)?;
        let signature = signature.to_bytes().to_vec();
        schnorr.push((id.to_vec(), signature.clone(), pubkey.clone()));
        events.push((pubkey, created_at, kind, tags, content, signature, id.to_vec()));
    }
    Ok((schnorr, events))
}

fn load_live(path: &Path) -> Result<LiveExport> {
    let bytes = std::fs::read(path).with_context(|| format!("reading {}", path.display()))?;
    serde_json::from_slice(&bytes).context("decoding live export")
}

fn event_case(event: &Event) -> Result<(SchnorrCase, EventCase)> {
    let id = hex::decode(&event.id)?;
    let signature = hex::decode(&event.sig)?;
    let pubkey = hex::decode(&event.pubkey)?;
    ensure!(id.len() == 32 && signature.len() == 64 && pubkey.len() == 32);
    Ok((
        (id.clone(), signature.clone(), pubkey.clone()),
        (
            pubkey,
            event.created_at,
            event.kind,
            event.tags.clone(),
            event.content.clone(),
            signature,
            id,
        ),
    ))
}

fn live_cases(export: &LiveExport) -> Result<(Vec<SchnorrCase>, Vec<EventCase>)> {
    export
        .events
        .iter()
        .map(|row| event_case(&row.event))
        .collect::<Result<Vec<_>>>()
        .map(|pairs| pairs.into_iter().unzip())
}

fn uuid_bytes(value: &str) -> Result<Vec<u8>> {
    let compact: String = value.chars().filter(|character| *character != '-').collect();
    let bytes = hex::decode(compact).context("decoding UUID")?;
    ensure!(bytes.len() == 16, "UUID must decode to 16 bytes");
    Ok(bytes)
}

fn live_audit_cases(export: &LiveExport) -> Result<Vec<AuditCase>> {
    export
        .audit_prefix
        .iter()
        .map(|entry| {
            Ok((
                uuid_bytes(&entry.community_id)?,
                entry.seq,
                entry.created_at.clone(),
                entry.action.clone(),
                entry.actor_pubkey.as_deref().map(hex::decode).transpose()?,
                entry.object_id.clone(),
                canonical_json(&entry.detail)?,
                entry.prev_hash.as_deref().map(hex::decode).transpose()?,
                hex::decode(&entry.hash)?,
            ))
        })
        .collect()
}

fn live_oa_cases(export: &LiveExport) -> Result<Vec<OaCase>> {
    let mut output = Vec::new();
    for row in &export.events {
        let event = &row.event;
        let auth_tags: Vec<_> = event
            .tags
            .iter()
            .filter(|tag| tag.first().map(String::as_str) == Some("auth"))
            .collect();
        ensure!(auth_tags.len() <= 1, "live event has ambiguous OA tags");
        if let Some(tag) = auth_tags.first() {
            ensure!(tag.len() == 4, "live OA tag cardinality");
            output.push((
                hex::decode(&event.pubkey)?,
                hex::decode(&tag[1])?,
                tag[2].clone(),
                hex::decode(&tag[3])?,
                event.kind,
                event.created_at,
            ));
        }
    }
    Ok(output)
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

fn audit_action_code(action: &str) -> Result<u8> {
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
        _ => anyhow::bail!("unknown Buzz audit action {action}"),
    })
}

fn encode_audit(output: &mut Vec<u8>, entry: &AuditEntry) -> Result<()> {
    output.extend_from_slice(&entry.seq.to_be_bytes());
    let hash = hex::decode(&entry.hash)?;
    ensure!(hash.len() == 32, "audit hash length");
    output.extend_from_slice(&hash);
    match &entry.prev_hash {
        Some(previous) => {
            let previous = hex::decode(previous)?;
            ensure!(previous.len() == 32, "audit prev_hash length");
            output.push(1);
            output.extend_from_slice(&previous);
        }
        None => output.push(0),
    }
    output.push(audit_action_code(&entry.action)?);
    match &entry.actor_pubkey {
        Some(actor) => {
            let actor = hex::decode(actor)?;
            ensure!(actor.len() == 32, "audit actor length");
            output.push(1);
            output.extend_from_slice(&actor);
        }
        None => output.push(0),
    }
    match &entry.object_id {
        Some(object_id) => {
            output.push(1);
            push_string(output, object_id)?;
        }
        None => output.push(0),
    }
    push_string(output, &entry.created_at)?;
    push_string(output, &canonical_json(&entry.detail)?)?;
    Ok(())
}

fn encode_event(output: &mut Vec<u8>, event: &Event) -> Result<()> {
    let id = hex::decode(&event.id)?;
    let pubkey = hex::decode(&event.pubkey)?;
    let signature = hex::decode(&event.sig)?;
    ensure!(id.len() == 32 && pubkey.len() == 32 && signature.len() == 64);
    output.extend_from_slice(&id);
    output.extend_from_slice(&pubkey);
    output.extend_from_slice(&event.created_at.to_be_bytes());
    output.extend_from_slice(&u32::from(event.kind).to_be_bytes());
    push_u32(output, event.tags.len())?;
    for tag in &event.tags {
        push_u32(output, tag.len())?;
        for element in tag {
            push_string(output, element)?;
        }
    }
    push_string(output, &event.content)?;
    output.extend_from_slice(&signature);
    Ok(())
}

fn encode_live_option_a(export: &LiveExport) -> Result<Vec<u8>> {
    let community_id =
        export.community.get("id").and_then(Value::as_str).context("live community id")?;
    let authority = export.nip11.get("self").and_then(Value::as_str).context("live NIP-11 self")?;
    let authority = hex::decode(authority)?;
    ensure!(authority.len() == 32, "relay authority length");

    let mut output = Vec::new();
    output.extend_from_slice(b"TGNW");
    output.push(1);
    output.push(1);
    output.extend_from_slice(&0u16.to_be_bytes());
    output.extend_from_slice(&uuid_bytes(community_id)?);
    output.extend_from_slice(&[0x42; 32]);
    output.extend_from_slice(&authority);
    push_u32(&mut output, export.audit_prefix.len())?;
    for entry in &export.audit_prefix {
        encode_audit(&mut output, entry)?;
    }
    push_u32(&mut output, export.events.len())?;
    for row in &export.events {
        encode_event(&mut output, &row.event)?;
    }
    ensure!(output.len() <= 12_582_912, "live TGNW exceeds v1 byte cap");
    Ok(output)
}

fn marginal(label: &str, one: &Measurement, many: &Measurement) -> Result<Derived> {
    ensure!(many.count > one.count, "marginal benchmark requires increasing count");
    let denominator = (many.count - one.count) as u64;
    Ok(Derived {
        label: label.to_owned(),
        numerator: format!("{} - {}", many.label, one.label),
        denominator,
        cycles_per_operation: (many.cycles - one.cycles) / denominator,
        pgu_per_operation: (many.pgu - one.pgu) / denominator,
    })
}

fn default_live_export() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../..").join(
        "tests/fixtures/nostr/buzz/a362fecc2389955f942c9581bdfeba379ab115b3/live/live-export.json",
    )
}

fn write_results(path: &Path, results: &Results) -> Result<()> {
    let mut bytes = serde_json::to_vec_pretty(results)?;
    bytes.push(b'\n');
    std::fs::write(path, bytes).with_context(|| format!("writing {}", path.display()))
}

fn main() -> Result<()> {
    if std::env::var("SP1_PROVER").is_err() {
        std::env::set_var("SP1_PROVER", "mock");
    }
    sp1_sdk::utils::setup_logger();
    let mut args = std::env::args_os().skip(1);
    let live_path = args.next().map(PathBuf::from).unwrap_or_else(default_live_export);
    let output_path = args.next().map(PathBuf::from);
    let bundle_path = args.next().map(PathBuf::from);
    ensure!(
        args.next().is_none(),
        "usage: host [live-export.json] [results.json] [live-option-a.tgnw]"
    );

    let (schnorr_one, event_one) = generated_cases(1)?;
    let (schnorr_many, event_many) = generated_cases(100)?;
    let audit_one = generated_audit_cases(1)?;
    let audit_many = generated_audit_cases(100)?;
    let oa_one = generated_oa_cases(1)?;
    let oa_many = generated_oa_cases(100)?;
    let live = load_live(&live_path)?;
    let (schnorr_live, event_live) = live_cases(&live)?;
    let audit_live = live_audit_cases(&live)?;
    let oa_live = live_oa_cases(&live)?;
    let live_bundle = encode_live_option_a(&live)?;
    let live_data_commitment: [u8; 32] = Sha256::digest(&live_bundle).into();
    if let Some(path) = &bundle_path {
        std::fs::write(path, &live_bundle)
            .with_context(|| format!("writing {}", path.display()))?;
    }
    let client = ProverClient::from_env();
    let measurements = vec![
        run(&client, ELF_SCHNORR, "schnorr-prehash-N1", 1, &schnorr_one)?,
        run(&client, ELF_SCHNORR, "schnorr-prehash-N100", 100, &schnorr_many)?,
        run(&client, ELF_SCHNORR, "schnorr-prehash-live", schnorr_live.len(), &schnorr_live)?,
        run(&client, ELF_EVENT, "nostr-event-N1", 1, &event_one)?,
        run(&client, ELF_EVENT, "nostr-event-N100", 100, &event_many)?,
        run(&client, ELF_EVENT, "nostr-event-live", event_live.len(), &event_live)?,
        run(&client, ELF_AUDIT, "buzz-audit-N1", 1, &audit_one)?,
        run(&client, ELF_AUDIT, "buzz-audit-N100", 100, &audit_many)?,
        run(&client, ELF_AUDIT, "buzz-audit-live", audit_live.len(), &audit_live)?,
        run(&client, ELF_OA, "nip-oa-N1", 1, &oa_one)?,
        run(&client, ELF_OA, "nip-oa-N100", 100, &oa_many)?,
        run(&client, ELF_OA, "nip-oa-live", oa_live.len(), &oa_live)?,
        run(
            &client,
            ELF_ENVELOPE,
            "tgnw-option-a-live",
            1,
            &(live_bundle.clone(), live_data_commitment.to_vec()),
        )?,
    ];
    let derived = vec![
        marginal("schnorr-prehash", &measurements[0], &measurements[1])?,
        marginal("nostr-event", &measurements[3], &measurements[4])?,
        marginal("buzz-audit", &measurements[6], &measurements[7])?,
        marginal("nip-oa", &measurements[9], &measurements[10])?,
    ];
    for row in &derived {
        println!(
            "MARGINAL,{},{},{},{}",
            row.label, row.denominator, row.cycles_per_operation, row.pgu_per_operation
        );
    }
    let results = Results {
        format: "trustgraphs-nostr-sp1-bench-v1",
        sp1: "6.3.1",
        cargo_prove: "8252c29",
        live_event_count: event_live.len(),
        live_audit_count: audit_live.len(),
        live_oa_count: oa_live.len(),
        live_bundle_bytes: live_bundle.len(),
        live_data_commitment: hex::encode(live_data_commitment),
        measurements,
        derived,
    };
    if let Some(path) = output_path {
        write_results(&path, &results)?;
    }
    Ok(())
}
