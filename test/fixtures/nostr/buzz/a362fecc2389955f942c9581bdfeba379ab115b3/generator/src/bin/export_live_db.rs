use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use std::str::FromStr;

use anyhow::{bail, ensure, Context, Result};
use buzz_audit::{compute_hash, AuditAction, AuditEntry};
use chrono::{DateTime, SecondsFormat, Utc};
use nostr::Event;
use reqwest::header::ACCEPT;
use serde::Serialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use sqlx::postgres::PgPoolOptions;
use sqlx::{PgPool, Row};
use uuid::Uuid;

const BUZZ_SHA: &str = "a362fecc2389955f942c9581bdfeba379ab115b3";
const PATCH_SHA256: &str = "3129e43e7b8967635bde8dd4a084613ef8628146dd1d1ba2f62e41ced4762a62";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LiveExport {
    format: &'static str,
    buzz_sha: &'static str,
    compatibility_patch_sha256: &'static str,
    rust_nostr: &'static str,
    source_corpus_sha256: String,
    seed_report_sha256: String,
    community: Value,
    nip11: Value,
    channel: Value,
    relay_members: Vec<Value>,
    channel_members: Vec<Value>,
    migrations: Vec<Value>,
    serializer_vectors: Vec<Value>,
    submitted_inputs: Vec<Value>,
    seed_report: Value,
    events: Vec<ExportedEvent>,
    audit_prefix: Vec<ExportedAuditEntry>,
    audit_event_coverage: Vec<Value>,
    direct_event_rows: Vec<String>,
    observations: Value,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ExportedEvent {
    event: Event,
    nip01_preimage: String,
    nip01_preimage_hex: String,
    received_at: String,
    channel_id: Option<Uuid>,
    deleted_at: Option<String>,
    d_tag: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ExportedAuditEntry {
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

fn digest_hex(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

fn timestamp(value: DateTime<Utc>) -> String {
    value.to_rfc3339_opts(SecondsFormat::Micros, true)
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
    .context("serializing DB event NIP-01 preimage")
}

fn required_array<'a>(value: &'a Value, field: &str) -> Result<&'a Vec<Value>> {
    value
        .get(field)
        .and_then(Value::as_array)
        .with_context(|| format!("source corpus field {field:?} must be an array"))
}

async fn export_events(pool: &PgPool, community_id: Uuid) -> Result<Vec<ExportedEvent>> {
    let rows = sqlx::query(
        "SELECT id, pubkey, created_at, kind, tags, content, sig, received_at, \
                channel_id, deleted_at, d_tag \
         FROM events WHERE community_id = $1 ORDER BY received_at, id",
    )
    .bind(community_id)
    .fetch_all(pool)
    .await
    .context("querying live Buzz event rows")?;

    let mut output = Vec::with_capacity(rows.len());
    for row in rows {
        let created_at: DateTime<Utc> = row.try_get("created_at")?;
        let kind: i32 = row.try_get("kind")?;
        let wire = json!({
            "id": hex::encode(row.try_get::<Vec<u8>, _>("id")?),
            "pubkey": hex::encode(row.try_get::<Vec<u8>, _>("pubkey")?),
            "created_at": u64::try_from(created_at.timestamp()).context("negative event timestamp")?,
            "kind": u16::try_from(kind).context("event kind outside u16")?,
            "tags": row.try_get::<Value, _>("tags")?,
            "content": row.try_get::<String, _>("content")?,
            "sig": hex::encode(row.try_get::<Vec<u8>, _>("sig")?),
        });
        let event: Event =
            serde_json::from_value(wire).context("decoding DB row as Nostr event")?;
        event.verify().context("verifying DB event signature")?;
        let preimage = nip01_preimage(&event)?;
        ensure!(
            digest_hex(preimage.as_bytes()) == event.id.to_hex(),
            "DB event NIP-01 digest does not match stored id"
        );
        output.push(ExportedEvent {
            event,
            nip01_preimage_hex: hex::encode(preimage.as_bytes()),
            nip01_preimage: preimage,
            received_at: timestamp(row.try_get("received_at")?),
            channel_id: row.try_get("channel_id")?,
            deleted_at: row.try_get::<Option<DateTime<Utc>>, _>("deleted_at")?.map(timestamp),
            d_tag: row.try_get("d_tag")?,
        });
    }
    Ok(output)
}

async fn export_audit(pool: &PgPool, community_id: Uuid) -> Result<Vec<ExportedAuditEntry>> {
    let rows = sqlx::query(
        "SELECT seq, hash, prev_hash, action, actor_pubkey, object_id, detail, created_at \
         FROM audit_log WHERE community_id = $1 ORDER BY seq",
    )
    .bind(community_id)
    .fetch_all(pool)
    .await
    .context("querying live Buzz audit prefix")?;

    let mut output = Vec::with_capacity(rows.len());
    let mut previous: Option<Vec<u8>> = None;
    for (index, row) in rows.into_iter().enumerate() {
        let seq: i64 = row.try_get("seq")?;
        ensure!(seq == (index + 1) as i64, "live audit sequence gap at {seq}");
        let stored_prev: Option<Vec<u8>> = row.try_get("prev_hash")?;
        ensure!(stored_prev == previous, "live audit previous-hash mismatch at {seq}");
        let action_text: String = row.try_get("action")?;
        let action = AuditAction::from_str(&action_text).map_err(anyhow::Error::msg)?;
        let hash: Vec<u8> = row.try_get("hash")?;
        let actor_pubkey: Option<Vec<u8>> = row.try_get("actor_pubkey")?;
        let object_id: Option<String> = row.try_get("object_id")?;
        let detail: Value = row.try_get::<Option<Value>, _>("detail")?.unwrap_or(Value::Null);
        let created_at: DateTime<Utc> = row.try_get("created_at")?;
        let entry = AuditEntry {
            community_id,
            seq,
            hash: hash.clone(),
            prev_hash: stored_prev.clone(),
            action,
            actor_pubkey: actor_pubkey.clone(),
            object_id: object_id.clone(),
            detail: detail.clone(),
            created_at,
        };
        ensure!(
            compute_hash(&entry).context("computing source Buzz audit hash")?.as_slice()
                == hash.as_slice(),
            "live audit hash mismatch at {seq}"
        );
        output.push(ExportedAuditEntry {
            community_id,
            seq,
            hash: hex::encode(&hash),
            prev_hash: stored_prev.as_ref().map(hex::encode),
            action: action_text,
            actor_pubkey: actor_pubkey.as_ref().map(hex::encode),
            object_id,
            detail,
            created_at: created_at.to_rfc3339(),
        });
        previous = Some(hash);
    }
    Ok(output)
}

async fn export_single_value(pool: &PgPool, query: &'static str, id: Uuid) -> Result<Value> {
    let row = sqlx::query(query).bind(id).fetch_one(pool).await?;
    row.try_get("value").context("decoding exported JSON value")
}

async fn export_values(pool: &PgPool, query: &'static str, id: Uuid) -> Result<Vec<Value>> {
    sqlx::query(query)
        .bind(id)
        .fetch_all(pool)
        .await?
        .into_iter()
        .map(|row| row.try_get("value").map_err(anyhow::Error::from))
        .collect()
}

fn write_export(output: &Path, export: &LiveExport) -> Result<()> {
    let mut bytes = serde_json::to_vec_pretty(export).context("serializing live DB export")?;
    bytes.push(b'\n');
    std::fs::write(output, bytes)
        .with_context(|| format!("writing live DB export {}", output.display()))
}

#[tokio::main]
async fn main() -> Result<()> {
    let mut args = std::env::args_os().skip(1);
    let source_path = args
        .next()
        .map(PathBuf::from)
        .context("usage: export_live_db <live-source-corpus> <seed-report> <output> [relay-url]")?;
    let seed_path = args
        .next()
        .map(PathBuf::from)
        .context("usage: export_live_db <live-source-corpus> <seed-report> <output> [relay-url]")?;
    let output_path = args
        .next()
        .map(PathBuf::from)
        .context("usage: export_live_db <live-source-corpus> <seed-report> <output> [relay-url]")?;
    let relay_url = args
        .next()
        .and_then(|value| value.into_string().ok())
        .unwrap_or_else(|| "http://127.0.0.1:33300".to_owned());
    ensure!(args.next().is_none(), "unexpected extra export_live_db argument");

    let source_bytes = std::fs::read(&source_path)
        .with_context(|| format!("reading {}", source_path.display()))?;
    let source: Value =
        serde_json::from_slice(&source_bytes).context("parsing live source corpus")?;
    let seed_bytes =
        std::fs::read(&seed_path).with_context(|| format!("reading {}", seed_path.display()))?;
    let seed_report: Value =
        serde_json::from_slice(&seed_bytes).context("parsing live seed report")?;
    let community_id = Uuid::parse_str(
        source
            .get("communityId")
            .and_then(Value::as_str)
            .context("live source corpus communityId")?,
    )?;
    let channel_id = Uuid::parse_str(
        source.get("channelId").and_then(Value::as_str).context("live source corpus channelId")?,
    )?;
    let submitted_names: BTreeSet<&str> = required_array(&seed_report, "receipts")?
        .iter()
        .filter_map(|receipt| receipt.get("name").and_then(Value::as_str))
        .collect();
    let submitted_inputs: Vec<Value> = required_array(&source, "events")?
        .iter()
        .filter(|input| {
            input
                .get("name")
                .and_then(Value::as_str)
                .is_some_and(|name| submitted_names.contains(name))
        })
        .cloned()
        .collect();
    ensure!(
        submitted_inputs.len() == submitted_names.len(),
        "seed report and live source corpus event names differ"
    );

    let database_url = std::env::var("DATABASE_URL").context("DATABASE_URL is required")?;
    let pool = PgPoolOptions::new()
        .max_connections(2)
        .connect(&database_url)
        .await
        .context("connecting to live Buzz database")?;

    let events = export_events(&pool, community_id).await?;
    let audit_prefix = export_audit(&pool, community_id).await?;
    ensure!(!events.is_empty(), "live Buzz event table is empty");
    ensure!(!audit_prefix.is_empty(), "live Buzz audit prefix is empty");
    let event_ids: BTreeSet<String> = events.iter().map(|row| row.event.id.to_hex()).collect();
    ensure!(event_ids.len() == events.len(), "duplicate event row in live export");
    let audit_ids: BTreeSet<String> =
        audit_prefix.iter().filter_map(|row| row.object_id.clone()).collect();
    let audit_event_coverage: Vec<Value> = audit_prefix
        .iter()
        .filter_map(|row| {
            row.object_id.as_ref().map(|id| {
                json!({
                    "seq": row.seq,
                    "eventId": id,
                    "source": if event_ids.contains(id) { "database" } else { "missing" },
                })
            })
        })
        .collect();
    if audit_event_coverage
        .iter()
        .any(|entry| entry.get("source").and_then(Value::as_str) == Some("missing"))
    {
        bail!("an audit EventCreated object is absent from the live DB export");
    }
    let direct_event_rows: Vec<String> = event_ids.difference(&audit_ids).cloned().collect();

    let community = export_single_value(
        &pool,
        "SELECT json_build_object(\
            'id', id, 'host', host, 'createdAt', to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"'), \
            'archivedAt', archived_at, 'deletionState', deletion_state, \
            'deletionFenceGeneration', deletion_fence_generation, 'deletedAt', deleted_at) AS value \
         FROM communities WHERE id = $1",
        community_id,
    )
    .await
    .context("exporting community row")?;
    let channel = export_single_value(
        &pool,
        "SELECT json_build_object(\
            'id', id, 'communityId', community_id, 'name', name, \
            'channelType', channel_type::text, 'visibility', visibility::text, \
            'description', description, 'createdBy', encode(created_by, 'hex'), \
            'createdAt', to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"')) AS value \
         FROM channels WHERE community_id = $1",
        community_id,
    )
    .await
    .context("exporting channel row")?;
    ensure!(
        channel.get("id").and_then(Value::as_str) == Some(channel_id.to_string().as_str()),
        "exported channel does not match source corpus"
    );
    let relay_members = export_values(
        &pool,
        "SELECT json_build_object(\
            'communityId', community_id, 'pubkey', pubkey, 'role', role, 'addedBy', added_by, \
            'createdAt', to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"'), \
            'updatedAt', to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"')) AS value \
         FROM relay_members WHERE community_id = $1 ORDER BY role, pubkey",
        community_id,
    )
    .await?;
    let channel_members = export_values(
        &pool,
        "SELECT json_build_object(\
            'communityId', community_id, 'channelId', channel_id, \
            'pubkey', encode(pubkey, 'hex'), 'role', role::text, \
            'joinedAt', to_char(joined_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"'), \
            'removedAt', removed_at, 'hiddenAt', hidden_at) AS value \
         FROM channel_members WHERE community_id = $1 ORDER BY channel_id, pubkey",
        community_id,
    )
    .await?;
    let migrations = sqlx::query(
        "SELECT version, description, success, checksum FROM _sqlx_migrations ORDER BY version",
    )
    .fetch_all(&pool)
    .await?
    .into_iter()
    .map(|row| {
        Ok(json!({
            "version": row.try_get::<i64, _>("version")?,
            "description": row.try_get::<String, _>("description")?,
            "success": row.try_get::<bool, _>("success")?,
            "checksum": hex::encode(row.try_get::<Vec<u8>, _>("checksum")?),
        }))
    })
    .collect::<Result<Vec<Value>>>()?;

    let response = reqwest::Client::new()
        .get(relay_url.trim_end_matches('/'))
        .header(ACCEPT, "application/nostr+json")
        .send()
        .await
        .context("fetching live NIP-11 document")?;
    ensure!(response.status().is_success(), "live NIP-11 request failed");
    let nip11: Value = response.json().await.context("parsing live NIP-11 document")?;
    let relay_pubkey = nip11.get("self").and_then(Value::as_str).context("live NIP-11 self key")?;
    ensure!(relay_pubkey.len() == 64, "live NIP-11 self is not a hex pubkey");
    let roster_rows: Vec<&ExportedEvent> =
        events.iter().filter(|row| row.event.kind.as_u16() == 13_534).collect();
    ensure!(roster_rows.len() == 1, "expected one live relay roster row");
    ensure!(
        roster_rows[0].event.pubkey.to_hex() == relay_pubkey,
        "live roster signer differs from NIP-11 self"
    );

    let mut kind_counts = BTreeMap::<u16, usize>::new();
    for row in &events {
        *kind_counts.entry(row.event.kind.as_u16()).or_default() += 1;
    }
    let observations = json!({
        "databaseEventCount": events.len(),
        "auditRowCount": audit_prefix.len(),
        "auditHead": audit_prefix.last().map(|row| row.hash.as_str()),
        "directEventRowCount": direct_event_rows.len(),
        "softDeletedEventCount": events.iter().filter(|row| row.deleted_at.is_some()).count(),
        "kindCounts": kind_counts,
        "submittedInputCount": submitted_inputs.len(),
        "relayRosterBypassesAudit": direct_event_rows.contains(&roster_rows[0].event.id.to_hex()),
    });
    let export = LiveExport {
        format: "trustgraphs-buzz-live-db-export-v1",
        buzz_sha: BUZZ_SHA,
        compatibility_patch_sha256: PATCH_SHA256,
        rust_nostr: "0.44.7",
        source_corpus_sha256: digest_hex(&source_bytes),
        seed_report_sha256: digest_hex(&seed_bytes),
        community,
        nip11,
        channel,
        relay_members,
        channel_members,
        migrations,
        serializer_vectors: required_array(&source, "serializerVectors")?.clone(),
        submitted_inputs,
        seed_report,
        events,
        audit_prefix,
        audit_event_coverage,
        direct_event_rows,
        observations,
    };
    write_export(&output_path, &export)?;
    println!(
        "exported {} DB events and {} audit rows to {}",
        export.events.len(),
        export.audit_prefix.len(),
        output_path.display()
    );
    Ok(())
}
