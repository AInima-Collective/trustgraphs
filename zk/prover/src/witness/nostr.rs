//! Buzz/Nostr operational pipeline for the production `nostr-workspace` program.
//!
//! Collection is deliberately separated from proving. `inspect` and `export` may read a scoped
//! Buzz database credential (by environment-variable name, never as a CLI value). `export`
//! verifies the exact canonical TGNW with the production envelope implementation and writes an
//! immutable archive. `anchor` reads only that archive and chain state. `assemble` reconstructs a
//! complete checkpoint log and emits a self-verified `GuestInput`; execute/prove need neither a
//! network nor credentials after that point.

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use std::str::FromStr;

use alloy_primitives::{keccak256, Address, B256, U256};
use alloy_sol_types::{sol, SolCall, SolEvent};
use anyhow::{anyhow, bail, ensure, Context, Result};
use chrono::{DateTime, SecondsFormat, Utc};
use clap::{Args, Subcommand, ValueEnum};
use nostr_envelope::nostr::audit::{self, AuditEntry};
use nostr_envelope::nostr::event::{decode_hex, NostrEvent};
use nostr_envelope::nostr::tgnw::{self, TgnwBundle};
use nostr_envelope::nostr::{
    community_node_id, estimated_pgu, nostr_node_id, verify, CommitmentVariant, NostrAnchor,
    NostrVerifyConfig,
};
use nostr_workspace_core::compute::{compute, GuestInput, HeadWitness, ENVELOPE_NOSTR};
use nostr_workspace_core::params::{params_hash, Params};
use pagerank_core::{encode, AnchorRecord, Binding};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use uuid::Uuid;
use zk_core::fold::fold;

pub const PINNED_BUZZ_SHA: &str = "a362fecc2389955f942c9581bdfeba379ab115b3";
pub const PINNED_PATCH_SHA256: &str =
    "3129e43e7b8967635bde8dd4a084613ef8628146dd1d1ba2f62e41ced4762a62";
pub const PINNED_SCHEMA_SHA256: &str =
    "1dc946eded958dbefd7174f840c37ea1bbe89e75b492ed58f29424378eebadd9";
pub const DEFAULT_ARCHIVE_DIR: &str =
    concat!(env!("CARGO_MANIFEST_DIR"), "/../../.trustgraph/nostr-witness-archive");
const SNAPSHOT_FORMAT: &str = "trustgraphs-buzz-live-db-export-v1";
const CORPUS_FORMAT: &str = "trustgraphs.nostr.buzz-source-corpus.v1";
const SELF_LOG_FORMAT: &str = "trustgraphs.nostr.self-log-recovery.v1";
const MANIFEST_FORMAT: &str = "trustgraphs.nostr.archive-manifest.v1";
const ASSEMBLY_FORMAT: &str = "trustgraphs.nostr.guest-input-manifest.v1";
const EXPECTED_MIGRATION_COUNT: usize = 31;
const COMMUNITY_NODE_KIND: u8 = 3;
const NOSTR_NODE_KIND: u8 = 2;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize, ValueEnum)]
#[serde(rename_all = "kebab-case")]
pub enum AccessPolicy {
    Public,
    #[default]
    MemberScoped,
    PrivateOperator,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, ValueEnum)]
pub enum ExportVariant {
    BuzzAudit,
    SelfLog,
}

#[derive(Clone, Debug, Args)]
pub struct CollectionArgs {
    /// Previously captured privileged Buzz snapshot or pinned source corpus.
    #[arg(long, conflicts_with = "database_url_env")]
    source: Option<PathBuf>,
    /// Name of the environment variable holding the PostgreSQL URL. The value is never logged.
    #[arg(long, conflicts_with = "source")]
    database_url_env: Option<String>,
    /// Community UUID required for live PostgreSQL collection.
    #[arg(long, requires = "database_url_env")]
    community: Option<String>,
    /// Relay HTTP base used for the before/after NIP-11 `self` key check in live mode.
    #[arg(long, default_value = "http://127.0.0.1:3000", requires = "database_url_env")]
    relay_url: String,
}

#[derive(Subcommand)]
pub enum Command {
    /// Read-only deployment/source checks. Performs no archive or anchor write.
    Inspect {
        #[command(flatten)]
        collection: CollectionArgs,
        /// Production params JSON (or an object containing a `params` field).
        #[arg(long)]
        params: PathBuf,
    },
    /// Build, production-verify, and immutably archive one canonical Option-A or Option-C TGNW.
    Export {
        #[command(flatten)]
        collection: CollectionArgs,
        #[arg(long)]
        params: PathBuf,
        #[arg(long, value_enum, default_value = "buzz-audit")]
        variant: ExportVariant,
        /// Option-C authority pubkey. Required when the source contains more than one self-log.
        #[arg(long)]
        authority: Option<String>,
        #[arg(long, default_value = DEFAULT_ARCHIVE_DIR)]
        archive_dir: PathBuf,
        #[arg(long, value_enum, default_value = "member-scoped")]
        access: AccessPolicy,
    },
    /// Rehash an immutable archive, preflight/simulate registry state, then submit envelope kind 2.
    Anchor {
        #[arg(long)]
        manifest: PathBuf,
        #[arg(long)]
        params: PathBuf,
        #[arg(long)]
        rpc: String,
        #[arg(long)]
        registry: String,
        /// Environment variable containing the 32-byte hex EVM relayer private key.
        #[arg(long)]
        private_key_env: String,
    },
    /// Reconstruct a complete checkpoint anchor log and selected archives into offline GuestInput.
    Assemble {
        #[arg(long)]
        rpc: String,
        #[arg(long)]
        snapshot: String,
        #[arg(long)]
        checkpoint: u64,
        #[arg(long)]
        params: PathBuf,
        /// Selected immutable manifest (repeatable). A/C overlap remains visible in the receipt.
        #[arg(long = "manifest", required = true)]
        manifests: Vec<PathBuf>,
        #[arg(long, default_value_t = 0)]
        from_block: u64,
        #[arg(long, default_value_t = 10_000)]
        chunk: u64,
        #[arg(long, default_value = "0x0000000000000000000000000000000000000000")]
        recipient: String,
        #[arg(long)]
        out: PathBuf,
    },
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct CommunityRow {
    id: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
struct Nip11 {
    #[serde(rename = "self")]
    self_key: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
struct Migration {
    version: i64,
    description: String,
    success: bool,
    checksum: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
struct WireEvent {
    id: String,
    pubkey: String,
    created_at: u64,
    kind: u32,
    tags: Vec<Vec<String>>,
    content: String,
    sig: String,
}

impl WireEvent {
    fn decode(&self) -> Result<NostrEvent> {
        Ok(NostrEvent {
            id: decode_hex(&self.id).map_err(|e| anyhow!("event id: {e:?}"))?,
            pubkey: decode_hex(&self.pubkey).map_err(|e| anyhow!("event pubkey: {e:?}"))?,
            created_at: self.created_at,
            kind: u16::try_from(self.kind).context("event kind exceeds u16")?,
            tags: self.tags.clone(),
            content: self.content.clone(),
            sig: hex::decode(&self.sig).context("event signature hex")?,
        })
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct EventRow {
    #[serde(default)]
    name: Option<String>,
    event: WireEvent,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct WireAuditEntry {
    community_id: String,
    seq: i64,
    hash: String,
    prev_hash: Option<String>,
    action: String,
    actor_pubkey: Option<String>,
    object_id: Option<String>,
    detail: Value,
    created_at: String,
}

impl WireAuditEntry {
    fn decode(&self) -> Result<AuditEntry> {
        ensure!(self.seq > 0, "audit seq is not positive");
        Ok(AuditEntry {
            sequence: self.seq as u64,
            hash: decode_hex(&self.hash).map_err(|e| anyhow!("audit hash: {e:?}"))?,
            previous_hash: self
                .prev_hash
                .as_deref()
                .map(decode_hex)
                .transpose()
                .map_err(|e| anyhow!("audit prevHash: {e:?}"))?,
            action: action_code(&self.action)?,
            actor_pubkey: self
                .actor_pubkey
                .as_deref()
                .map(decode_hex)
                .transpose()
                .map_err(|e| anyhow!("audit actor: {e:?}"))?,
            object_id: self.object_id.clone(),
            created_at: self.created_at.clone(),
            detail: canonical_json(&self.detail).context("canonical audit detail")?,
        })
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
struct SelfLogSpec {
    author: String,
    entry_event_ids: Vec<String>,
    head: String,
    count: u64,
    head_event_id: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct SourceDocument {
    format: String,
    buzz_sha: String,
    #[serde(default)]
    compatibility_patch_sha256: Option<String>,
    #[serde(default)]
    community: Option<CommunityRow>,
    #[serde(default)]
    community_id: Option<String>,
    #[serde(default)]
    instance_domain: Option<String>,
    #[serde(default)]
    nip11: Option<Nip11>,
    #[serde(default)]
    migrations: Vec<Migration>,
    events: Vec<EventRow>,
    #[serde(default)]
    audit_prefix: Vec<WireAuditEntry>,
    #[serde(default)]
    direct_event_rows: Vec<String>,
    #[serde(default)]
    self_logs: Vec<SelfLogSpec>,
}

impl SourceDocument {
    fn community_text(&self) -> Result<&str> {
        self.community_id
            .as_deref()
            .or_else(|| self.community.as_ref().map(|row| row.id.as_str()))
            .context("source has no community id")
    }
}

#[derive(Clone, Debug)]
struct Inspection {
    source_digest: [u8; 32],
    schema_digest: String,
    community_id: [u8; 16],
    relay_pubkey: [u8; 32],
    events: Vec<(Option<String>, NostrEvent)>,
    audit: Vec<AuditEntry>,
    direct_ids: Vec<[u8; 32]>,
    self_logs: Vec<SelfLogSpec>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArchiveManifest {
    pub format: String,
    pub manifest_version: u32,
    pub access_policy: AccessPolicy,
    pub buzz_sha: String,
    pub schema_sha256: String,
    pub source_sha256: String,
    pub params_hash: String,
    pub tgnw_version: u32,
    pub commitment_variant: CommitmentVariant,
    pub community_id: String,
    pub instance_domain: String,
    pub authority: String,
    pub node_id: String,
    pub head: String,
    pub count: u64,
    pub data_commitment: String,
    pub cid: String,
    pub bundle_bytes: u64,
    pub audit_entries: u64,
    pub event_count: u64,
    pub nip01_checks: u64,
    pub oa_checks: u64,
    pub estimated_pgu: u64,
    pub event_ids: Vec<String>,
    pub direct_event_ids: Vec<String>,
    pub verifier: String,
    pub bundle_file: String,
}

#[derive(Clone, Debug)]
struct VerifiedArchive {
    manifest: ArchiveManifest,
    bytes: Vec<u8>,
    bundle: TgnwBundle,
    path: PathBuf,
}

fn hx(bytes: &[u8]) -> String {
    format!("0x{}", hex::encode(bytes))
}

fn sha256(bytes: &[u8]) -> [u8; 32] {
    Sha256::digest(bytes).into()
}

fn raw_cid(digest: &[u8; 32]) -> String {
    zk_core::cid::cid_v1_raw(digest)
}

fn parse_uuid(value: &str) -> Result<[u8; 16]> {
    Ok(*Uuid::parse_str(value).context("community UUID")?.as_bytes())
}

fn action_code(name: &str) -> Result<u8> {
    (0..=10)
        .find(|code| audit::action_name(*code).ok() == Some(name))
        .ok_or_else(|| anyhow!("unknown Buzz audit action {name:?}"))
}

fn canonical_json_value(value: &Value, output: &mut String) -> Result<()> {
    match value {
        Value::Object(map) => {
            let mut fields: Vec<_> = map.iter().collect();
            fields.sort_unstable_by(|left, right| left.0.cmp(right.0));
            output.push('{');
            for (index, (key, value)) in fields.into_iter().enumerate() {
                if index != 0 {
                    output.push(',');
                }
                output.push_str(&serde_json::to_string(key)?);
                output.push(':');
                canonical_json_value(value, output)?;
            }
            output.push('}');
        }
        Value::Array(values) => {
            output.push('[');
            for (index, value) in values.iter().enumerate() {
                if index != 0 {
                    output.push(',');
                }
                canonical_json_value(value, output)?;
            }
            output.push(']');
        }
        scalar => output.push_str(&serde_json::to_string(scalar)?),
    }
    Ok(())
}

fn canonical_json(value: &Value) -> Result<String> {
    let mut output = String::new();
    canonical_json_value(value, &mut output)?;
    Ok(output)
}

/// Exact Option-C head fold used by the guest verifier. This duplicate is intentionally
/// host-local: adding an operational exporter must not perturb the already-frozen guest crate/ELF.
fn option_c_head(instance_domain: &[u8; 32], author: &[u8; 32], events: &[NostrEvent]) -> [u8; 32] {
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

fn load_params(path: &Path) -> Result<Params> {
    let bytes = std::fs::read(path).with_context(|| format!("read params {}", path.display()))?;
    let value: Value = serde_json::from_slice(&bytes).context("parse params JSON")?;
    let candidate = value.get("params").cloned().unwrap_or(value);
    let params: Params = serde_json::from_value(candidate).context(
        "decode Params (use the Rust serde shape, not the camelCase presentation in golden JSON)",
    )?;
    params.validate().map_err(|e| anyhow!("invalid production params: {e:?}"))?;
    Ok(params)
}

fn migration_digest(migrations: &[Migration]) -> Result<String> {
    ensure!(migrations.len() == EXPECTED_MIGRATION_COUNT, "Buzz schema migration count mismatch");
    let mut ordered = migrations.to_vec();
    ordered.sort_by_key(|migration| migration.version);
    let mut bytes = Vec::new();
    for (index, migration) in ordered.iter().enumerate() {
        ensure!(migration.version == (index + 1) as i64, "Buzz migration sequence gap");
        ensure!(migration.success, "Buzz migration {} was not successful", migration.version);
        bytes.extend_from_slice(
            format!(
                "{}:{}:{}:{}\n",
                migration.version, migration.description, migration.success, migration.checksum
            )
            .as_bytes(),
        );
    }
    Ok(hex::encode(sha256(&bytes)))
}

fn source_document(path: &Path) -> Result<(SourceDocument, [u8; 32])> {
    let bytes = std::fs::read(path).with_context(|| format!("read source {}", path.display()))?;
    let source = serde_json::from_slice(&bytes).context("decode Buzz source document")?;
    Ok((source, sha256(&bytes)))
}

fn inspect_document(
    source: &SourceDocument,
    source_digest: [u8; 32],
    params: &Params,
) -> Result<Inspection> {
    ensure!(source.buzz_sha == PINNED_BUZZ_SHA, "Buzz SHA mismatch");
    if let Some(patch) = &source.compatibility_patch_sha256 {
        ensure!(patch == PINNED_PATCH_SHA256, "Buzz compatibility patch digest mismatch");
    }
    ensure!(
        source.format == SNAPSHOT_FORMAT
            || source.format == CORPUS_FORMAT
            || source.format == SELF_LOG_FORMAT,
        "unsupported Buzz source format {:?}",
        source.format
    );

    let community_id = parse_uuid(source.community_text()?)?;
    ensure!(community_id == params.community_id, "source community differs from params");
    if let Some(domain) = &source.instance_domain {
        ensure!(
            decode_hex::<32>(domain).map_err(|e| anyhow!("instanceDomain: {e:?}"))?
                == params.instance_domain,
            "source instance domain differs from params"
        );
    }
    let relay_pubkey = match &source.nip11 {
        Some(nip11) => decode_hex(&nip11.self_key).map_err(|e| anyhow!("NIP-11 self: {e:?}"))?,
        None => params.relay_pubkey,
    };
    ensure!(relay_pubkey == params.relay_pubkey, "stale or wrong NIP-11 self relay key");

    let schema_digest = if source.format == SNAPSHOT_FORMAT {
        let digest = migration_digest(&source.migrations)?;
        ensure!(digest == PINNED_SCHEMA_SHA256, "Buzz database schema digest mismatch");
        digest
    } else {
        // The checked-in source corpus is generated by and pinned to the same compatibility
        // profile. Its own SHA plus the patch digest make fixture provenance immutable.
        format!("fixture-profile:{PINNED_PATCH_SHA256}")
    };

    ensure!(!source.events.is_empty(), "Nostr event snapshot is empty");
    let requires_audit = source.format != SELF_LOG_FORMAT;
    if requires_audit {
        ensure!(
            !source.audit_prefix.is_empty(),
            "audit is disabled or the audit worker has no rows"
        );
    } else {
        ensure!(!source.self_logs.is_empty(), "self-log recovery document has no log metadata");
    }
    let mut events = Vec::with_capacity(source.events.len());
    let mut by_id = BTreeMap::new();
    let mut by_name = BTreeMap::new();
    for row in &source.events {
        let event = row.event.decode()?;
        nostr_envelope::nostr::event::verify(&event).map_err(|e| {
            anyhow!("stored event {} failed NIP-01 verification: {e:?}", row.event.id)
        })?;
        ensure!(by_id.insert(event.id, event.kind).is_none(), "duplicate event row id");
        if let Some(name) = &row.name {
            ensure!(by_name.insert(name.clone(), event.id).is_none(), "duplicate event name");
        }
        events.push((row.name.clone(), event));
    }

    let mut audit_entries = Vec::with_capacity(source.audit_prefix.len());
    let mut audited_ids = BTreeSet::new();
    for row in &source.audit_prefix {
        ensure!(parse_uuid(&row.community_id)? == community_id, "cross-community audit row");
        let entry = row.decode()?;
        if entry.action == 0 {
            let object = entry.object_id.as_deref().context("EventCreated row has no objectId")?;
            let id = decode_hex(object).map_err(|e| anyhow!("audit event object id: {e:?}"))?;
            ensure!(audited_ids.insert(id), "duplicate EventCreated object id");
            let kind = by_id.get(&id).context("audit EventCreated object is absent from events")?;
            ensure!(entry.actor_pubkey.is_some(), "EventCreated row has no actor");
            let detail: Value = serde_json::from_str(&entry.detail)?;
            ensure!(
                detail.get("event_kind").and_then(Value::as_u64) == Some(u64::from(*kind)),
                "audit event_kind differs from stored event"
            );
        }
        audit_entries.push(entry);
    }
    if requires_audit {
        audit::verify_prefix(&community_id, &audit_entries)
            .map_err(|e| anyhow!("audit queue/worker health failed: {e:?}"))?;
    }

    let declared_direct = source
        .direct_event_rows
        .iter()
        .map(|value| {
            if let Ok(id) = decode_hex(value) {
                Ok(id)
            } else {
                by_name.get(value).copied().with_context(|| format!("unknown direct event {value}"))
            }
        })
        .collect::<Result<BTreeSet<[u8; 32]>>>()?;
    let actual_direct: BTreeSet<_> = if requires_audit {
        by_id.keys().copied().filter(|id| !audited_ids.contains(id)).collect()
    } else {
        BTreeSet::new()
    };
    if requires_audit {
        ensure!(
            declared_direct == actual_direct,
            "direct-event declaration does not match DB/audit coverage"
        );
        for id in &actual_direct {
            ensure!(
                matches!(by_id[id], 13_534 | 40_099 | 44_100),
                "unexpected unaudited persistent event kind {}",
                by_id[id]
            );
        }
    } else {
        ensure!(
            declared_direct.is_empty(),
            "self-log recovery document must not declare Buzz direct rows"
        );
    }
    ensure!(
        audit_entries.len() <= params.limits.audit_entries as usize,
        "audit prefix exceeds configured cap"
    );
    ensure!(events.len() <= params.limits.events as usize, "event snapshot exceeds configured cap");

    Ok(Inspection {
        source_digest,
        schema_digest,
        community_id,
        relay_pubkey,
        events,
        audit: audit_entries,
        direct_ids: actual_direct.into_iter().collect(),
        self_logs: source.self_logs.clone(),
    })
}

fn relay_self(relay_url: &str) -> Result<String> {
    let response = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()?
        .get(relay_url.trim_end_matches('/'))
        .header("accept", "application/nostr+json")
        .send()
        .context("fetch NIP-11 relay document")?
        .error_for_status()
        .context("NIP-11 relay status")?;
    let value: Value = response.json().context("decode NIP-11 relay document")?;
    value
        .get("self")
        .and_then(Value::as_str)
        .map(str::to_owned)
        .context("NIP-11 document has no self key")
}

fn collect_database(args: &CollectionArgs) -> Result<(SourceDocument, [u8; 32])> {
    let env_name = args.database_url_env.as_ref().context(
        "no collection source: pass --source or --database-url-env (the credential value is never a CLI argument)",
    )?;
    let database_url = std::env::var(env_name).with_context(|| {
        format!("database credential environment variable {env_name:?} is missing")
    })?;
    ensure!(!database_url.trim().is_empty(), "database credential is empty");
    let community_text = args.community.as_deref().context("--community is required in DB mode")?;
    let community = Uuid::parse_str(community_text).context("--community UUID")?;

    // The relay key is sampled on both sides of the REPEATABLE READ transaction. A deployment
    // rotating `self` during collection is rejected instead of producing a mixed-key archive.
    let relay_before = relay_self(&args.relay_url)?;
    let mut client = postgres::Client::connect(&database_url, postgres::NoTls)
        .context("connect to Buzz PostgreSQL")?;
    let mut tx = client
        .build_transaction()
        .isolation_level(postgres::IsolationLevel::RepeatableRead)
        .read_only(true)
        .start()
        .context("start consistent read-only Buzz snapshot")?;

    let event_rows = tx
        .query(
            "SELECT id, pubkey, created_at, kind, tags, content, sig \
             FROM events WHERE community_id = $1 ORDER BY received_at, id",
            &[&community],
        )
        .context("query Buzz events (selected schema mismatch?)")?;
    let mut events = Vec::with_capacity(event_rows.len());
    for row in event_rows {
        let created_at: DateTime<Utc> = row.get("created_at");
        let timestamp = created_at.timestamp();
        ensure!(timestamp >= 0, "negative Nostr event timestamp");
        let kind: i32 = row.get("kind");
        ensure!(kind >= 0, "negative Nostr kind");
        events.push(EventRow {
            name: None,
            event: WireEvent {
                id: hex::encode(row.get::<_, Vec<u8>>("id")),
                pubkey: hex::encode(row.get::<_, Vec<u8>>("pubkey")),
                created_at: timestamp as u64,
                kind: kind as u32,
                tags: serde_json::from_value(row.get("tags")).context("decode event tags")?,
                content: row.get("content"),
                sig: hex::encode(row.get::<_, Vec<u8>>("sig")),
            },
        });
    }

    let audit_rows = tx
        .query(
            "SELECT seq, hash, prev_hash, action, actor_pubkey, object_id, detail, created_at \
             FROM audit_log WHERE community_id = $1 ORDER BY seq",
            &[&community],
        )
        .context("query Buzz audit_log (audit disabled or selected schema mismatch?)")?;
    let mut audit_prefix = Vec::with_capacity(audit_rows.len());
    for row in audit_rows {
        let created_at: DateTime<Utc> = row.get("created_at");
        audit_prefix.push(WireAuditEntry {
            community_id: community.to_string(),
            seq: row.get("seq"),
            hash: hex::encode(row.get::<_, Vec<u8>>("hash")),
            prev_hash: row.get::<_, Option<Vec<u8>>>("prev_hash").map(hex::encode),
            action: row.get("action"),
            actor_pubkey: row.get::<_, Option<Vec<u8>>>("actor_pubkey").map(hex::encode),
            object_id: row.get("object_id"),
            detail: row.get::<_, Option<Value>>("detail").unwrap_or(Value::Null),
            created_at: created_at.to_rfc3339_opts(SecondsFormat::AutoSi, false),
        });
    }

    let migration_rows = tx
        .query(
            "SELECT version, description, success, checksum FROM _sqlx_migrations ORDER BY version",
            &[],
        )
        .context("query _sqlx_migrations")?;
    let migrations = migration_rows
        .into_iter()
        .map(|row| Migration {
            version: row.get("version"),
            description: row.get("description"),
            success: row.get("success"),
            checksum: hex::encode(row.get::<_, Vec<u8>>("checksum")),
        })
        .collect();
    tx.commit().context("finish Buzz snapshot")?;
    let relay_after = relay_self(&args.relay_url)?;
    ensure!(relay_before == relay_after, "NIP-11 self key changed during collection");

    let audit_ids: BTreeSet<String> =
        audit_prefix.iter().filter_map(|entry| entry.object_id.clone()).collect();
    let direct_event_rows = events
        .iter()
        .filter(|row| !audit_ids.contains(&row.event.id))
        .map(|row| row.event.id.clone())
        .collect();
    let source = SourceDocument {
        format: SNAPSHOT_FORMAT.to_owned(),
        buzz_sha: PINNED_BUZZ_SHA.to_owned(),
        compatibility_patch_sha256: Some(PINNED_PATCH_SHA256.to_owned()),
        community: Some(CommunityRow { id: community.to_string() }),
        community_id: None,
        instance_domain: None,
        nip11: Some(Nip11 { self_key: relay_before }),
        migrations,
        events,
        audit_prefix,
        direct_event_rows,
        self_logs: Vec::new(),
    };
    let bytes = serde_json::to_vec(&source)?;
    Ok((source, sha256(&bytes)))
}

fn collect(args: &CollectionArgs, params: &Params) -> Result<Inspection> {
    let (source, digest) = match &args.source {
        Some(path) => source_document(path)?,
        None => collect_database(args)?,
    };
    inspect_document(&source, digest, params)
}

fn auth_attempts(events: impl Iterator<Item = NostrEvent>) -> u64 {
    events
        .flat_map(|event| event.tags.into_iter())
        .filter(|tag| tag.first().map(String::as_str) == Some("auth"))
        .count() as u64
}

fn build_bundle(
    inspection: &Inspection,
    params: &Params,
    variant: ExportVariant,
    authority: Option<&str>,
) -> Result<(TgnwBundle, NostrAnchor)> {
    let bundle = match variant {
        ExportVariant::BuzzAudit => TgnwBundle {
            variant: CommitmentVariant::BuzzAuditV1,
            community_id: inspection.community_id,
            instance_domain: params.instance_domain,
            authority: inspection.relay_pubkey,
            audit: inspection.audit.clone(),
            events: inspection.events.iter().map(|(_, event)| event.clone()).collect(),
            head_event: None,
        },
        ExportVariant::SelfLog => {
            ensure!(
                !inspection.self_logs.is_empty(),
                "source has no Option-C self-log recovery metadata"
            );
            let selected = match authority {
                Some(authority) => {
                    let candidates = inspection
                        .self_logs
                        .iter()
                        .filter(|entry| entry.author == authority)
                        .collect::<Vec<_>>();
                    let max_count = candidates
                        .iter()
                        .map(|entry| entry.count)
                        .max()
                        .with_context(|| format!("no self-log for authority {authority}"))?;
                    let newest = candidates
                        .into_iter()
                        .filter(|entry| entry.count == max_count)
                        .collect::<Vec<_>>();
                    let selected = newest[0];
                    ensure!(
                        newest.iter().all(|entry| *entry == selected),
                        "equivocating self-log metadata for authority {authority} at count {max_count}"
                    );
                    selected
                }
                None if inspection.self_logs.len() == 1 => &inspection.self_logs[0],
                None => bail!("source has multiple self-logs; pass --authority"),
            };
            let author =
                decode_hex(&selected.author).map_err(|e| anyhow!("self-log authority: {e:?}"))?;
            let by_id: BTreeMap<_, _> =
                inspection.events.iter().map(|(_, event)| (hex::encode(event.id), event)).collect();
            let events = selected
                .entry_event_ids
                .iter()
                .map(|id| {
                    by_id
                        .get(id)
                        .cloned()
                        .cloned()
                        .with_context(|| format!("self-log entry {id} is missing"))
                })
                .collect::<Result<Vec<_>>>()?;
            let head_event = by_id
                .get(&selected.head_event_id)
                .cloned()
                .cloned()
                .context("self-log signed head event is missing")?;
            ensure!(selected.count == events.len() as u64, "self-log recovery count mismatch");
            let computed = option_c_head(&params.instance_domain, &author, &events);
            ensure!(hex::encode(computed) == selected.head, "self-log recovery head mismatch");
            TgnwBundle {
                variant: CommitmentVariant::SelfLogV1,
                community_id: inspection.community_id,
                instance_domain: params.instance_domain,
                authority: author,
                audit: Vec::new(),
                events,
                head_event: Some(head_event),
            }
        }
    };
    let bytes = tgnw::encode(&bundle).map_err(|e| anyhow!("encode canonical TGNW: {e:?}"))?;
    let head = match bundle.variant {
        CommitmentVariant::BuzzAuditV1 => {
            bundle.audit.last().map(|entry| entry.hash).unwrap_or([0; 32])
        }
        CommitmentVariant::SelfLogV1 => {
            option_c_head(&bundle.instance_domain, &bundle.authority, &bundle.events)
        }
    };
    let count = match bundle.variant {
        CommitmentVariant::BuzzAuditV1 => bundle.audit.len() as u64,
        CommitmentVariant::SelfLogV1 => bundle.events.len() as u64,
    };
    let node_id = match bundle.variant {
        CommitmentVariant::BuzzAuditV1 => community_node_id(&bundle.community_id),
        CommitmentVariant::SelfLogV1 => nostr_node_id(&bundle.authority),
    };
    let anchor = NostrAnchor {
        node_id,
        head: B256::from(head),
        count,
        data_commitment: B256::from(sha256(&bytes)),
    };
    Ok((bundle, anchor))
}

fn verify_config(params: &Params) -> NostrVerifyConfig {
    NostrVerifyConfig {
        community_id: params.community_id,
        instance_domain: params.instance_domain,
        relay_pubkey: params.relay_pubkey,
        allowed_variants: params.allowed_variants,
        limits: params.limits,
    }
}

fn archive_export(
    inspection: &Inspection,
    params: &Params,
    variant: ExportVariant,
    authority: Option<&str>,
    archive_root: &Path,
    access_policy: AccessPolicy,
) -> Result<PathBuf> {
    let (bundle, anchor) = build_bundle(inspection, params, variant, authority)?;
    let bytes = tgnw::encode(&bundle).map_err(|e| anyhow!("encode TGNW: {e:?}"))?;
    ensure!(
        bytes.len() <= params.limits.envelope_bytes as usize,
        "bundle exceeds configured byte cap"
    );
    let nip01_checks = bundle.events.len() as u64 + u64::from(bundle.head_event.is_some());
    let oa_checks =
        auth_attempts(bundle.events.clone().into_iter().chain(bundle.head_event.clone()));
    let estimate =
        estimated_pgu(bytes.len() as u64, bundle.audit.len() as u64, nip01_checks, oa_checks)
            .context("PGU estimate overflow")?;
    ensure!(nip01_checks <= u64::from(params.limits.nip01_signatures), "bundle exceeds NIP-01 cap");
    ensure!(oa_checks <= u64::from(params.limits.oa_signatures), "bundle exceeds NIP-OA cap");
    ensure!(estimate <= params.max_estimated_pgu, "bundle exceeds configured PGU cap");
    let verified = verify(&anchor, &verify_config(params), &bytes)
        .map_err(|e| anyhow!("production envelope verifier rejected export: {e:?}"))?;
    ensure!(verified.data_commitment == anchor.data_commitment, "verifier commitment mismatch");

    let community = Uuid::from_bytes(bundle.community_id).to_string();
    let directory =
        archive_root.join(community).join(anchor.count.to_string()).join(hex::encode(anchor.head));
    let bundle_path = directory.join("bundle.tgnw");
    let manifest_path = directory.join("manifest.json");
    let event_ids = bundle
        .events
        .iter()
        .chain(bundle.head_event.iter())
        .map(|event| hx(&event.id))
        .collect::<Vec<_>>();
    let manifest = ArchiveManifest {
        format: MANIFEST_FORMAT.to_owned(),
        manifest_version: 1,
        access_policy,
        buzz_sha: PINNED_BUZZ_SHA.to_owned(),
        schema_sha256: inspection.schema_digest.clone(),
        source_sha256: hx(&inspection.source_digest),
        params_hash: hx(params_hash(params).as_slice()),
        tgnw_version: 1,
        commitment_variant: bundle.variant,
        community_id: hx(&bundle.community_id),
        instance_domain: hx(&bundle.instance_domain),
        authority: hx(&bundle.authority),
        node_id: hx(anchor.node_id.as_slice()),
        head: hx(anchor.head.as_slice()),
        count: anchor.count,
        data_commitment: hx(anchor.data_commitment.as_slice()),
        cid: raw_cid(anchor.data_commitment.as_ref()),
        bundle_bytes: bytes.len() as u64,
        audit_entries: bundle.audit.len() as u64,
        event_count: bundle.events.len() as u64,
        nip01_checks,
        oa_checks,
        estimated_pgu: estimate,
        event_ids,
        direct_event_ids: bundle
            .events
            .iter()
            .filter(|event| inspection.direct_ids.contains(&event.id))
            .map(|event| hx(&event.id))
            .collect(),
        verifier: "nostr-envelope/TGNW-v1".to_owned(),
        bundle_file: "bundle.tgnw".to_owned(),
    };
    let mut manifest_bytes = serde_json::to_vec_pretty(&manifest)?;
    manifest_bytes.push(b'\n');

    if directory.exists() {
        let existing_bundle =
            std::fs::read(&bundle_path).context("read existing immutable bundle")?;
        let existing_manifest =
            std::fs::read(&manifest_path).context("read existing immutable manifest")?;
        ensure!(existing_bundle == bytes, "archive path already contains different TGNW bytes");
        ensure!(
            existing_manifest == manifest_bytes,
            "archive path already contains a different manifest"
        );
        return Ok(manifest_path);
    }
    std::fs::create_dir_all(&directory)
        .with_context(|| format!("create archive {}", directory.display()))?;
    // create_new is the repair/republish guard: replacing content requires deleting the unanchored
    // target deliberately, after which its digest/path must still reproduce exactly.
    let mut bundle_file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&bundle_path)
        .context("create immutable bundle")?;
    use std::io::Write;
    bundle_file.write_all(&bytes)?;
    bundle_file.sync_all()?;
    let mut manifest_file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&manifest_path)
        .context("create immutable manifest")?;
    manifest_file.write_all(&manifest_bytes)?;
    manifest_file.sync_all()?;
    Ok(manifest_path)
}

fn b256(value: &str, what: &str) -> Result<B256> {
    B256::from_str(value).with_context(|| format!("{what}: expected 0x-prefixed bytes32"))
}

fn verify_archive(path: &Path, params: &Params) -> Result<VerifiedArchive> {
    let manifest_bytes = std::fs::read(path)
        .with_context(|| format!("read immutable manifest {}", path.display()))?;
    let manifest: ArchiveManifest =
        serde_json::from_slice(&manifest_bytes).context("decode archive manifest")?;
    ensure!(
        manifest.format == MANIFEST_FORMAT && manifest.manifest_version == 1,
        "unsupported archive manifest"
    );
    ensure!(manifest.buzz_sha == PINNED_BUZZ_SHA, "manifest Buzz SHA mismatch");
    ensure!(
        manifest.params_hash == hx(params_hash(params).as_slice()),
        "manifest params hash mismatch"
    );
    ensure!(manifest.bundle_file == "bundle.tgnw", "unsafe/noncanonical bundle filename");
    let parent = path.parent().context("manifest has no parent directory")?;
    let bundle_path = parent.join(&manifest.bundle_file);
    let bytes = std::fs::read(&bundle_path)
        .with_context(|| format!("read archived TGNW {}", bundle_path.display()))?;
    ensure!(bytes.len() as u64 == manifest.bundle_bytes, "archived bundle length changed");
    let digest = sha256(&bytes);
    ensure!(hx(&digest) == manifest.data_commitment, "archived bundle digest changed");
    ensure!(raw_cid(&digest) == manifest.cid, "archived bundle CID changed");
    let bundle =
        tgnw::decode(&bytes, &params.limits).map_err(|e| anyhow!("decode archived TGNW: {e:?}"))?;
    ensure!(
        tgnw::encode(&bundle).map_err(|e| anyhow!("re-encode archive: {e:?}"))? == bytes,
        "archive is not canonical TGNW"
    );
    let anchor = NostrAnchor {
        node_id: b256(&manifest.node_id, "manifest nodeId")?,
        head: b256(&manifest.head, "manifest head")?,
        count: manifest.count,
        data_commitment: B256::from(digest),
    };
    verify(&anchor, &verify_config(params), &bytes)
        .map_err(|e| anyhow!("production verifier rejected archived TGNW: {e:?}"))?;
    ensure!(manifest.commitment_variant == bundle.variant, "manifest variant mismatch");
    ensure!(
        manifest.event_ids
            == bundle
                .events
                .iter()
                .chain(bundle.head_event.iter())
                .map(|event| hx(&event.id))
                .collect::<Vec<_>>(),
        "manifest event-id list changed"
    );
    Ok(VerifiedArchive { manifest, bytes, bundle, path: path.to_path_buf() })
}

sol! {
    function registered(bytes32 nodeId) external view returns (bool);
    function nodeKind(bytes32 nodeId) external view returns (uint8);
    function lastCount(bytes32 nodeId) external view returns (uint64);
    function anchorCount() external view returns (uint64);
    function maxTotalInputs() external view returns (uint64);
    function snapshot() external view returns (address);
    function hasRole(bytes32 role, address account) external view returns (bool);
    function accumulator() external view returns (address);
    function anchorRegistry() external view returns (address);
    function leafCount() external view returns (uint64);
    function checkpointParamsHash(uint256 checkpointId) external view returns (bytes32);
    function anchorCheckpoints(uint256 checkpointId) external view returns (bytes32 anchorAcc, uint64 anchorCount);
    struct Checkpoint { bytes32 acc; uint64 leafCount; uint64 blockNumber; }
    function getCheckpoint(uint256 id) external view returns (Checkpoint);
    function anchor(
        bytes32 nodeId,
        uint8 envelopeKind,
        bytes32 head,
        uint64 count,
        bytes32 dataCommitment,
        bytes headSignature
    ) external;
    event HeadAnchored(
        uint64 indexed foldIndex,
        bytes32 indexed nodeId,
        uint8 envelopeKind,
        bytes32 head,
        uint64 count,
        bytes32 dataCommitment,
        uint256 blockTimestamp
    );
}

#[derive(Clone, Debug)]
struct RpcLog {
    topics: Vec<B256>,
    data: Vec<u8>,
}

struct Rpc {
    client: reqwest::blocking::Client,
    url: String,
}

impl Rpc {
    fn new(url: String) -> Result<Self> {
        Ok(Self {
            client: reqwest::blocking::Client::builder()
                .timeout(std::time::Duration::from_secs(30))
                .build()?,
            url,
        })
    }

    fn request(&self, method: &str, params: Value) -> Result<Value> {
        let response: Value = self
            .client
            .post(&self.url)
            .json(&json!({"jsonrpc":"2.0","id":1,"method":method,"params":params}))
            .send()
            .with_context(|| format!("{method} request"))?
            .error_for_status()
            .with_context(|| format!("{method} HTTP status"))?
            .json()
            .with_context(|| format!("{method} JSON response"))?;
        if let Some(error) = response.get("error").filter(|value| !value.is_null()) {
            bail!("{method} RPC error: {error}");
        }
        response.get("result").cloned().context("RPC response has no result")
    }

    fn hex_u256(&self, method: &str, params: Value) -> Result<U256> {
        let result = self.request(method, params)?;
        let value = result.as_str().with_context(|| format!("{method} returned non-hex"))?;
        U256::from_str_radix(value.trim_start_matches("0x"), 16)
            .with_context(|| format!("decode {method} result"))
    }

    fn chain_id(&self) -> Result<u64> {
        self.hex_u256("eth_chainId", json!([]))?.try_into().context("chain id exceeds u64")
    }

    fn eth_call_from(&self, from: Option<Address>, to: Address, data: &[u8]) -> Result<Vec<u8>> {
        let mut tx = json!({"to": hx(to.as_slice()), "data": hx(data)});
        if let Some(from) = from {
            tx["from"] = json!(hx(from.as_slice()));
        }
        let result = self.request("eth_call", json!([tx, "latest"]))?;
        hex::decode(result.as_str().context("eth_call returned non-hex")?.trim_start_matches("0x"))
            .context("decode eth_call result")
    }

    fn eth_call(&self, to: Address, data: &[u8]) -> Result<Vec<u8>> {
        self.eth_call_from(None, to, data)
    }

    fn get_logs(
        &self,
        address: Address,
        topics: &[Option<B256>],
        from: u64,
        to: u64,
        chunk: u64,
    ) -> Result<Vec<RpcLog>> {
        ensure!(chunk > 0, "log chunk must be nonzero");
        let topics: Vec<Value> = topics
            .iter()
            .map(|topic| topic.map_or(Value::Null, |topic| json!(hx(topic.as_slice()))))
            .collect();
        let mut output = Vec::new();
        let mut start = from;
        while start <= to {
            let end = start.saturating_add(chunk - 1).min(to);
            let result = self.request(
                "eth_getLogs",
                json!([{
                    "address": hx(address.as_slice()),
                    "topics": topics,
                    "fromBlock": format!("0x{start:x}"),
                    "toBlock": format!("0x{end:x}")
                }]),
            )?;
            for log in result.as_array().context("eth_getLogs returned non-array")? {
                let raw_topics = log
                    .get("topics")
                    .and_then(Value::as_array)
                    .context("RPC log has no topics")?
                    .iter()
                    .map(|value| b256(value.as_str().unwrap_or_default(), "RPC log topic"))
                    .collect::<Result<Vec<_>>>()?;
                let data = hex::decode(
                    log.get("data")
                        .and_then(Value::as_str)
                        .context("RPC log has no data")?
                        .trim_start_matches("0x"),
                )?;
                output.push(RpcLog { topics: raw_topics, data });
            }
            if end == u64::MAX {
                break;
            }
            start = end + 1;
        }
        Ok(output)
    }

    fn latest_block(&self) -> Result<u64> {
        self.hex_u256("eth_blockNumber", json!([]))?.try_into().context("block number exceeds u64")
    }

    fn nonce(&self, address: Address) -> Result<U256> {
        self.hex_u256("eth_getTransactionCount", json!([hx(address.as_slice()), "pending"]))
    }

    fn gas_price(&self) -> Result<U256> {
        self.hex_u256("eth_gasPrice", json!([]))
    }

    fn estimate_gas(&self, from: Address, to: Address, data: &[u8]) -> Result<U256> {
        self.hex_u256(
            "eth_estimateGas",
            json!([{"from":hx(from.as_slice()),"to":hx(to.as_slice()),"data":hx(data)}]),
        )
    }

    fn send_raw(&self, raw: &[u8]) -> Result<B256> {
        let result = self.request("eth_sendRawTransaction", json!([hx(raw)]))?;
        b256(result.as_str().context("sendRawTransaction returned non-hash")?, "transaction hash")
    }

    fn wait_receipt(&self, transaction: B256) -> Result<Value> {
        for _ in 0..240 {
            let result =
                self.request("eth_getTransactionReceipt", json!([hx(transaction.as_slice())]))?;
            if !result.is_null() {
                ensure!(
                    result.get("status").and_then(Value::as_str) == Some("0x1"),
                    "anchor transaction reverted: {result}"
                );
                return Ok(result);
            }
            std::thread::sleep(std::time::Duration::from_millis(500));
        }
        bail!("timed out waiting for anchor transaction receipt")
    }
}

fn call_decode<C: SolCall>(rpc: &Rpc, address: Address, call: C) -> Result<C::Return> {
    let data = call.abi_encode();
    let result = rpc.eth_call(address, &data)?;
    C::abi_decode_returns(&result).context("decode contract call")
}

// Tiny canonical RLP implementation for a signed EIP-155 legacy transaction. Legacy transactions
// remain universally accepted and avoid coupling the witness-only feature to an Alloy provider
// stack. Gas price/nonce/limit all come from the preflighted RPC.
fn rlp_bytes(value: &[u8]) -> Vec<u8> {
    if value.len() == 1 && value[0] < 0x80 {
        return value.to_vec();
    }
    if value.len() < 56 {
        let mut out = vec![0x80 + value.len() as u8];
        out.extend_from_slice(value);
        return out;
    }
    let length = minimal_usize(value.len());
    let mut out = vec![0xb7 + length.len() as u8];
    out.extend_from_slice(&length);
    out.extend_from_slice(value);
    out
}

fn rlp_list(items: &[Vec<u8>]) -> Vec<u8> {
    let payload: Vec<u8> = items.iter().flatten().copied().collect();
    if payload.len() < 56 {
        let mut out = vec![0xc0 + payload.len() as u8];
        out.extend(payload);
        return out;
    }
    let length = minimal_usize(payload.len());
    let mut out = vec![0xf7 + length.len() as u8];
    out.extend(length);
    out.extend(payload);
    out
}

fn minimal_usize(value: usize) -> Vec<u8> {
    let bytes = value.to_be_bytes();
    bytes.iter().position(|byte| *byte != 0).map_or_else(Vec::new, |index| bytes[index..].to_vec())
}

fn minimal_u256(value: U256) -> Vec<u8> {
    let bytes = value.to_be_bytes::<32>();
    bytes.iter().position(|byte| *byte != 0).map_or_else(Vec::new, |index| bytes[index..].to_vec())
}

fn rlp_uint(value: U256) -> Vec<u8> {
    rlp_bytes(&minimal_u256(value))
}

fn signer(private_key_env: &str) -> Result<(k256::ecdsa::SigningKey, Address)> {
    let secret = std::env::var(private_key_env).with_context(|| {
        format!("anchor credential environment variable {private_key_env:?} is missing")
    })?;
    let bytes =
        hex::decode(secret.trim().trim_start_matches("0x")).context("anchor private key hex")?;
    ensure!(bytes.len() == 32, "anchor private key must be exactly 32 bytes");
    let key = k256::ecdsa::SigningKey::from_slice(&bytes).context("invalid anchor private key")?;
    let public = key.verifying_key().to_encoded_point(false);
    let digest = keccak256(&public.as_bytes()[1..]);
    Ok((key, Address::from_slice(&digest.as_slice()[12..])))
}

fn sign_legacy(
    key: &k256::ecdsa::SigningKey,
    chain_id: u64,
    nonce: U256,
    gas_price: U256,
    gas_limit: U256,
    to: Address,
    data: &[u8],
) -> Result<Vec<u8>> {
    let chain = U256::from(chain_id);
    let unsigned = rlp_list(&[
        rlp_uint(nonce),
        rlp_uint(gas_price),
        rlp_uint(gas_limit),
        rlp_bytes(to.as_slice()),
        rlp_uint(U256::ZERO),
        rlp_bytes(data),
        rlp_uint(chain),
        rlp_uint(U256::ZERO),
        rlp_uint(U256::ZERO),
    ]);
    let digest = keccak256(&unsigned);
    let (signature, recovery_id) = key
        .sign_prehash_recoverable(digest.as_slice())
        .context("sign EIP-155 anchor transaction")?;
    let signature = signature.to_bytes();
    let v = chain
        .checked_mul(U256::from(2))
        .and_then(|value| value.checked_add(U256::from(35 + recovery_id.to_byte())))
        .context("EIP-155 v overflow")?;
    Ok(rlp_list(&[
        rlp_uint(nonce),
        rlp_uint(gas_price),
        rlp_uint(gas_limit),
        rlp_bytes(to.as_slice()),
        rlp_uint(U256::ZERO),
        rlp_bytes(data),
        rlp_uint(v),
        rlp_bytes(&signature[..32]),
        rlp_bytes(&signature[32..]),
    ]))
}

fn expected_node_kind(variant: CommitmentVariant) -> u8 {
    match variant {
        CommitmentVariant::BuzzAuditV1 => COMMUNITY_NODE_KIND,
        CommitmentVariant::SelfLogV1 => NOSTR_NODE_KIND,
    }
}

fn count_is_idempotent(previous: u64, manifest_count: u64) -> Result<bool> {
    if previous > manifest_count {
        bail!("stale archive count {manifest_count}: registry already anchored {previous}");
    }
    Ok(previous == manifest_count)
}

fn anchored_records(
    rpc: &Rpc,
    registry: Address,
    from_block: u64,
    to_block: u64,
    chunk: u64,
) -> Result<Vec<(u64, AnchorRecord)>> {
    let logs = rpc.get_logs(
        registry,
        &[Some(HeadAnchored::SIGNATURE_HASH), None, None],
        from_block,
        to_block,
        chunk,
    )?;
    let mut indexed = Vec::with_capacity(logs.len());
    for log in logs {
        let event =
            HeadAnchored::decode_raw_log(log.topics, &log.data).context("decode HeadAnchored")?;
        let timestamp: u64 =
            event.blockTimestamp.try_into().context("anchor timestamp exceeds u64")?;
        indexed.push((
            event.foldIndex,
            AnchorRecord {
                node_id: event.nodeId,
                envelope_kind: event.envelopeKind,
                head: event.head,
                count: event.count,
                data_commitment: event.dataCommitment,
                block_timestamp: timestamp,
            },
        ));
    }
    indexed.sort_by_key(|(index, _)| *index);
    Ok(indexed)
}

fn run_anchor(
    manifest_path: &Path,
    params_path: &Path,
    rpc_url: String,
    registry: &str,
    key_env: &str,
) -> Result<()> {
    let params = load_params(params_path)?;
    let archive = verify_archive(manifest_path, &params)?;
    let registry: Address = registry.parse().context("--registry address")?;
    let rpc = Rpc::new(rpc_url)?;
    let (key, sender) = signer(key_env)?;
    let node_id = b256(&archive.manifest.node_id, "manifest nodeId")?;
    let head = b256(&archive.manifest.head, "manifest head")?;
    let commitment = b256(&archive.manifest.data_commitment, "manifest dataCommitment")?;

    let is_registered = call_decode(&rpc, registry, registeredCall { nodeId: node_id })?;
    ensure!(is_registered, "archive node is not registered");
    let kind = call_decode(&rpc, registry, nodeKindCall { nodeId: node_id })?;
    ensure!(
        kind == expected_node_kind(archive.bundle.variant),
        "registered node kind {kind} does not match archive variant"
    );
    let role = keccak256(b"ANCHORER_ROLE");
    ensure!(
        call_decode(&rpc, registry, hasRoleCall { role, account: sender })?,
        "signer lacks ANCHORER_ROLE"
    );
    let previous = call_decode(&rpc, registry, lastCountCall { nodeId: node_id })?;
    if count_is_idempotent(previous, archive.manifest.count)? {
        let latest = rpc.latest_block()?;
        let exact = anchored_records(&rpc, registry, 0, latest, 10_000)?
            .into_iter()
            .map(|(_, record)| record)
            .rev()
            .find(|record| record.node_id == node_id && record.count == previous)
            .is_some_and(|record| {
                record.envelope_kind == ENVELOPE_NOSTR
                    && record.head == head
                    && record.data_commitment == commitment
            });
        ensure!(exact, "registry count matches but anchored preimage differs");
        println!(
            "already anchored: count={} head={} (idempotent no-op)",
            archive.manifest.count, archive.manifest.head
        );
        return Ok(());
    }
    // The count comes only from the verified immutable manifest. We never increment/rewrite it to
    // clear a stale-count error.
    let current_anchors = call_decode(&rpc, registry, anchorCountCall {})?;
    let maximum = call_decode(&rpc, registry, maxTotalInputsCall {})?;
    let snapshot_address = call_decode(&rpc, registry, snapshotCall {})?;
    ensure!(snapshot_address != Address::ZERO, "anchor registry has no bound snapshot");
    let accumulator_address = call_decode(&rpc, snapshot_address, accumulatorCall {})?;
    let lane1 = call_decode(&rpc, accumulator_address, leafCountCall {})?;
    ensure!(
        u128::from(lane1) + u128::from(current_anchors) < u128::from(maximum),
        "combined input capacity exhausted before anchor spend"
    );

    let call = anchorCall {
        nodeId: node_id,
        envelopeKind: ENVELOPE_NOSTR,
        head,
        count: archive.manifest.count,
        dataCommitment: commitment,
        headSignature: Vec::<u8>::new().into(),
    };
    let data = call.abi_encode();
    rpc.eth_call_from(Some(sender), registry, &data).context("anchor simulation failed")?;
    let nonce = rpc.nonce(sender)?;
    let gas_price = rpc.gas_price()?;
    let estimate = rpc.estimate_gas(sender, registry, &data)?;
    let gas_limit = estimate
        .checked_mul(U256::from(12))
        .and_then(|value| value.checked_div(U256::from(10)))
        .context("gas limit overflow")?;
    let chain_id = rpc.chain_id()?;
    ensure!(
        chain_id == params.chain_id,
        "RPC chain id {chain_id} differs from params chain id {}",
        params.chain_id
    );
    let raw = sign_legacy(&key, chain_id, nonce, gas_price, gas_limit, registry, &data)?;
    let tx_hash = rpc.send_raw(&raw)?;
    let receipt = rpc.wait_receipt(tx_hash)?;
    println!("anchored: {}", hx(tx_hash.as_slice()));
    println!(
        "block:    {}",
        receipt.get("blockNumber").and_then(Value::as_str).unwrap_or("unknown")
    );
    Ok(())
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AssemblyManifest {
    format: String,
    checkpoint: u64,
    snapshot: String,
    anchor_registry: String,
    checkpoint_block: u64,
    anchor_acc: String,
    anchor_count: u64,
    params_hash: String,
    guest_input_sha256: String,
    source_manifests: Vec<String>,
    selected_commitments: Vec<String>,
    duplicate_event_ids: Vec<String>,
}

#[allow(clippy::too_many_arguments)]
fn run_assemble(
    rpc_url: String,
    snapshot_text: &str,
    checkpoint: u64,
    params_path: &Path,
    manifest_paths: &[PathBuf],
    from_block: u64,
    chunk: u64,
    recipient_text: &str,
    out: &Path,
) -> Result<()> {
    let params = load_params(params_path)?;
    let rpc = Rpc::new(rpc_url)?;
    let snapshot: Address = snapshot_text.parse().context("--snapshot address")?;
    let registry = call_decode(&rpc, snapshot, anchorRegistryCall {})?;
    ensure!(registry != Address::ZERO, "snapshot has no anchor registry");
    let accumulator = call_decode(&rpc, snapshot, accumulatorCall {})?;
    let checkpoint_data =
        call_decode(&rpc, accumulator, getCheckpointCall { id: U256::from(checkpoint) })?;
    ensure!(
        checkpoint_data.acc == B256::ZERO && checkpoint_data.leafCount == 0,
        "nostr-workspace requires the empty lane-1 checkpoint"
    );
    let frozen = call_decode(
        &rpc,
        snapshot,
        anchorCheckpointsCall { checkpointId: U256::from(checkpoint) },
    )?;
    let pinned_params = call_decode(
        &rpc,
        snapshot,
        checkpointParamsHashCall { checkpointId: U256::from(checkpoint) },
    )?;
    let local_params = params_hash(&params);
    ensure!(pinned_params == local_params, "checkpoint params hash differs from supplied params");

    let indexed = anchored_records(&rpc, registry, from_block, checkpoint_data.blockNumber, chunk)?;
    ensure!(
        indexed.len() as u64 == frozen.anchorCount,
        "incomplete HeadAnchored log: expected {}, found {}",
        frozen.anchorCount,
        indexed.len()
    );
    for (wanted, (actual, _)) in indexed.iter().enumerate() {
        ensure!(
            *actual == wanted as u64,
            "HeadAnchored gap: expected fold index {wanted}, found {actual}"
        );
    }
    let anchors: Vec<_> = indexed.into_iter().map(|(_, anchor)| anchor).collect();
    let mut acc = B256::ZERO;
    for anchor in &anchors {
        acc = fold(
            acc,
            zk_core::anchor::anchor_leaf(
                anchor.node_id,
                anchor.envelope_kind,
                anchor.head,
                anchor.count,
                anchor.data_commitment,
                anchor.block_timestamp,
            ),
        );
    }
    ensure!(acc == frozen.anchorAcc, "HeadAnchored log re-fold differs from checkpoint anchorAcc");
    ensure!(
        anchors.iter().all(|anchor| anchor.envelope_kind == ENVELOPE_NOSTR),
        "checkpoint contains a foreign envelope kind"
    );

    let anchored_commitments: BTreeSet<_> =
        anchors.iter().map(|anchor| anchor.data_commitment).collect();
    let mut archives = Vec::with_capacity(manifest_paths.len());
    let mut commitments = BTreeSet::new();
    for path in manifest_paths {
        let archive = verify_archive(path, &params)?;
        let commitment = b256(&archive.manifest.data_commitment, "manifest dataCommitment")?;
        ensure!(
            anchored_commitments.contains(&commitment),
            "selected archive is not in checkpoint anchor log"
        );
        ensure!(commitments.insert(commitment), "duplicate selected archive commitment");
        archives.push(archive);
    }

    let mut event_sources = BTreeMap::<String, usize>::new();
    for archive in &archives {
        for event_id in &archive.manifest.event_ids {
            *event_sources.entry(event_id.clone()).or_default() += 1;
        }
    }
    let duplicate_event_ids = event_sources
        .into_iter()
        .filter_map(|(event, count)| (count > 1).then_some(event))
        .collect::<Vec<_>>();
    let recipient: Address = recipient_text.parse().context("--recipient address")?;
    let chain_id = rpc.chain_id()?;
    ensure!(chain_id == params.chain_id, "RPC chain id differs from params");
    let input = GuestInput {
        params,
        anchors,
        witnesses: archives
            .iter()
            .map(|archive| HeadWitness { bytes: archive.bytes.clone() })
            .collect(),
        binding: Binding {
            recipient,
            instance_domain: encode::instance_domain(snapshot, chain_id),
        },
    };
    // This is the last networked step. Refuse to emit an input that would burn executor/prover
    // capacity: params, archive selection, rule Phi, work caps, and all signatures run here.
    compute(&input)
        .map_err(|e| anyhow!("assembled GuestInput failed native production compute: {e:?}"))?;
    let mut input_bytes = serde_json::to_vec_pretty(&input)?;
    input_bytes.push(b'\n');
    let input_digest = sha256(&input_bytes);
    if let Some(parent) = out.parent().filter(|parent| !parent.as_os_str().is_empty()) {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(out, &input_bytes)
        .with_context(|| format!("write GuestInput {}", out.display()))?;
    let receipt = AssemblyManifest {
        format: ASSEMBLY_FORMAT.to_owned(),
        checkpoint,
        snapshot: hx(snapshot.as_slice()),
        anchor_registry: hx(registry.as_slice()),
        checkpoint_block: checkpoint_data.blockNumber,
        anchor_acc: hx(frozen.anchorAcc.as_slice()),
        anchor_count: frozen.anchorCount,
        params_hash: hx(local_params.as_slice()),
        guest_input_sha256: hx(&input_digest),
        source_manifests: archives
            .iter()
            .map(|archive| archive.path.display().to_string())
            .collect(),
        selected_commitments: archives
            .iter()
            .map(|archive| archive.manifest.data_commitment.clone())
            .collect(),
        duplicate_event_ids,
    };
    let receipt_path = PathBuf::from(format!("{}.manifest.json", out.display()));
    let mut receipt_bytes = serde_json::to_vec_pretty(&receipt)?;
    receipt_bytes.push(b'\n');
    std::fs::write(&receipt_path, receipt_bytes)?;
    println!("guestInput: {}", out.display());
    println!("sha256:    {}", hx(&input_digest));
    println!("receipt:   {}", receipt_path.display());
    Ok(())
}

fn print_inspection(inspection: &Inspection, params: &Params) {
    println!("Buzz SHA:       {PINNED_BUZZ_SHA}");
    println!("schema:         {}", inspection.schema_digest);
    println!("community:      {}", Uuid::from_bytes(inspection.community_id));
    println!("relay self:     {}", hex::encode(inspection.relay_pubkey));
    println!("audit enabled:  yes ({} gap-free rows)", inspection.audit.len());
    println!("queue/worker:   healthy (complete persistent-event coverage)");
    println!(
        "database rows:  {} events, {} direct exceptions",
        inspection.events.len(),
        inspection.direct_ids.len()
    );
    println!(
        "caps:           audit {}/{}, events {}/{}, bytes <= {}, PGU <= {}",
        inspection.audit.len(),
        params.limits.audit_entries,
        inspection.events.len(),
        params.limits.events,
        params.limits.envelope_bytes,
        params.max_estimated_pgu
    );
    println!("anchor writes:  0");
}

pub fn run(command: Command) -> Result<()> {
    match command {
        Command::Inspect { collection, params } => {
            let params = load_params(&params)?;
            let inspection = collect(&collection, &params)?;
            // Build both variants that the source advertises so inspect checks cap/verification
            // readiness without persisting either archive.
            let (bundle, anchor) =
                build_bundle(&inspection, &params, ExportVariant::BuzzAudit, None)?;
            let bytes =
                tgnw::encode(&bundle).map_err(|e| anyhow!("encode inspection TGNW: {e:?}"))?;
            verify(&anchor, &verify_config(&params), &bytes).map_err(|e| {
                anyhow!("production verifier rejected inspected Option-A source: {e:?}")
            })?;
            let estimate = estimated_pgu(
                bytes.len() as u64,
                bundle.audit.len() as u64,
                bundle.events.len() as u64,
                auth_attempts(bundle.events.into_iter()),
            )
            .context("inspection work estimate overflow")?;
            ensure!(
                estimate <= params.max_estimated_pgu,
                "inspected source exceeds configured work cap"
            );
            print_inspection(&inspection, &params);
            Ok(())
        }
        Command::Export { collection, params, variant, authority, archive_dir, access } => {
            let params = load_params(&params)?;
            let inspection = collect(&collection, &params)?;
            let path = archive_export(
                &inspection,
                &params,
                variant,
                authority.as_deref(),
                &archive_dir,
                access,
            )?;
            let archive = verify_archive(&path, &params)?;
            println!("manifest:       {}", path.display());
            println!("dataCommitment: {}", archive.manifest.data_commitment);
            println!("cid:            {}", archive.manifest.cid);
            println!("head/count:     {} / {}", archive.manifest.head, archive.manifest.count);
            Ok(())
        }
        Command::Anchor { manifest, params, rpc, registry, private_key_env } => {
            run_anchor(&manifest, &params, rpc, &registry, &private_key_env)
        }
        Command::Assemble {
            rpc,
            snapshot,
            checkpoint,
            params,
            manifests,
            from_block,
            chunk,
            recipient,
            out,
        } => run_assemble(
            rpc, &snapshot, checkpoint, &params, &manifests, from_block, chunk, &recipient, &out,
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    static NEXT_TEMP: AtomicU64 = AtomicU64::new(0);

    fn fixture(name: &str) -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../tests/fixtures/nostr/buzz/a362fecc2389955f942c9581bdfeba379ab115b3")
            .join(name)
    }

    fn fixture_params() -> Params {
        crate::programs::nostr_workspace::sample_input().params
    }

    fn corpus() -> (SourceDocument, [u8; 32]) {
        source_document(&fixture("source-corpus.json")).unwrap()
    }

    fn temp_root(label: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!(
            "trustgraphs-nostr-{label}-{}-{}",
            std::process::id(),
            NEXT_TEMP.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir(&root).unwrap();
        root
    }

    #[test]
    fn rlp_known_shapes() {
        assert_eq!(hex::encode(rlp_bytes(&[])), "80");
        assert_eq!(hex::encode(rlp_bytes(&[0x7f])), "7f");
        assert_eq!(hex::encode(rlp_bytes(&[0x80])), "8180");
        assert_eq!(
            hex::encode(rlp_list(&[rlp_bytes(b"cat"), rlp_bytes(b"dog")])),
            "c88363617483646f67"
        );
    }

    #[test]
    fn pinned_schema_digest_matches_live_fixture() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join(
            "../../tests/fixtures/nostr/buzz/a362fecc2389955f942c9581bdfeba379ab115b3/live/live-export.json",
        );
        let (source, _) = source_document(&root).unwrap();
        assert_eq!(migration_digest(&source.migrations).unwrap(), PINNED_SCHEMA_SHA256);
    }

    #[test]
    fn pinned_corpus_reproduces_option_a_and_c_exactly() {
        let params = fixture_params();
        let (source, digest) = corpus();
        let inspection = inspect_document(&source, digest, &params).unwrap();
        let (a, _) = build_bundle(&inspection, &params, ExportVariant::BuzzAudit, None).unwrap();
        let (c, _) = build_bundle(&inspection, &params, ExportVariant::SelfLog, None).unwrap();
        assert_eq!(
            tgnw::encode(&a).unwrap(),
            std::fs::read(fixture("source-option-a.tgnw")).unwrap()
        );
        assert_eq!(
            tgnw::encode(&c).unwrap(),
            std::fs::read(fixture("source-option-c.tgnw")).unwrap()
        );
    }

    #[test]
    fn self_log_export_selects_newest_count_and_rejects_equivocation() {
        let params = fixture_params();
        let epoch_two = fixture("epoch2/source-corpus.json");
        let (mut source, digest) = source_document(&epoch_two).unwrap();
        let inspection = inspect_document(&source, digest, &params).unwrap();
        let authority = "462779ad4aad39514614751a71085f2f10e1c7a593e4e030efb5b8721ce55b0b";
        let (bundle, anchor) =
            build_bundle(&inspection, &params, ExportVariant::SelfLog, Some(authority)).unwrap();
        assert_eq!(anchor.count, 3);
        assert_eq!(
            tgnw::encode(&bundle).unwrap(),
            std::fs::read(fixture("epoch2/source-option-c.tgnw")).unwrap()
        );

        let newest = source.self_logs.iter().max_by_key(|entry| entry.count).unwrap().clone();
        let mut conflicting = newest;
        conflicting.head_event_id = source.self_logs[0].head_event_id.clone();
        source.self_logs.push(conflicting);
        let inspection = inspect_document(&source, digest, &params).unwrap();
        assert!(build_bundle(&inspection, &params, ExportVariant::SelfLog, Some(authority))
            .unwrap_err()
            .to_string()
            .contains("equivocating self-log metadata"));
    }

    #[test]
    fn option_c_recovery_needs_no_buzz_audit_rows() {
        let params = fixture_params();
        let (mut source, digest) = corpus();
        let selected: BTreeSet<_> = source.self_logs[0]
            .entry_event_ids
            .iter()
            .chain(std::iter::once(&source.self_logs[0].head_event_id))
            .cloned()
            .collect();
        source.format = SELF_LOG_FORMAT.to_owned();
        source.audit_prefix.clear();
        source.direct_event_rows.clear();
        source.events.retain(|row| selected.contains(&row.event.id));
        let inspection = inspect_document(&source, digest, &params).unwrap();
        let (bundle, _) = build_bundle(&inspection, &params, ExportVariant::SelfLog, None).unwrap();
        assert_eq!(
            tgnw::encode(&bundle).unwrap(),
            std::fs::read(fixture("source-option-c.tgnw")).unwrap()
        );
    }

    #[test]
    fn audit_gap_stale_key_partial_snapshot_and_caps_fail_closed() {
        let params = fixture_params();
        let (source, digest) = corpus();

        let mut gap = source.clone();
        gap.audit_prefix.remove(1);
        assert!(inspect_document(&gap, digest, &params).is_err());

        let mut stale_key = source.clone();
        stale_key.nip11 = Some(Nip11 { self_key: "11".repeat(32) });
        assert!(inspect_document(&stale_key, digest, &params).is_err());

        let mut partial = source.clone();
        partial.events.retain(|row| {
            row.event.id != source.audit_prefix[0].object_id.as_ref().unwrap().as_str()
        });
        assert!(inspect_document(&partial, digest, &params).is_err());

        let mut small = params.clone();
        small.limits.events = 1;
        assert!(inspect_document(&source, digest, &small).is_err());
    }

    #[test]
    fn missing_database_credential_fails_before_collection() {
        let params = fixture_params();
        let env_name = format!("TRUSTGRAPHS_MISSING_DB_CREDENTIAL_{}", std::process::id());
        std::env::remove_var(&env_name);
        let args = CollectionArgs {
            source: None,
            database_url_env: Some(env_name),
            community: Some("01915f7a-6b4c-7d2e-8f10-112233445566".to_owned()),
            relay_url: "http://127.0.0.1:1".to_owned(),
        };
        assert!(collect(&args, &params).unwrap_err().to_string().contains("credential"));
    }

    #[test]
    fn stale_counts_and_missing_anchor_credentials_fail_before_spend() {
        assert!(!count_is_idempotent(1, 2).unwrap());
        assert!(count_is_idempotent(2, 2).unwrap());
        assert!(count_is_idempotent(3, 2).is_err());
        let env_name = format!("TRUSTGRAPHS_MISSING_ANCHOR_KEY_{}", std::process::id());
        std::env::remove_var(&env_name);
        assert!(signer(&env_name).unwrap_err().to_string().contains("credential"));
    }

    #[test]
    fn archive_is_reproducible_redacted_and_tamper_evident() {
        let params = fixture_params();
        let (source, digest) = corpus();
        let inspection = inspect_document(&source, digest, &params).unwrap();
        let first = temp_root("archive-a");
        let second = temp_root("archive-b");
        let first_manifest = archive_export(
            &inspection,
            &params,
            ExportVariant::BuzzAudit,
            None,
            &first,
            AccessPolicy::MemberScoped,
        )
        .unwrap();
        let second_manifest = archive_export(
            &inspection,
            &params,
            ExportVariant::BuzzAudit,
            None,
            &second,
            AccessPolicy::MemberScoped,
        )
        .unwrap();
        let first_bytes = std::fs::read(&first_manifest).unwrap();
        let second_bytes = std::fs::read(&second_manifest).unwrap();
        assert_eq!(first_bytes, second_bytes);
        assert!(!String::from_utf8_lossy(&first_bytes).contains("Alice fixture post"));
        let first_bundle = first_manifest.parent().unwrap().join("bundle.tgnw");
        assert_eq!(
            std::fs::read(&first_bundle).unwrap(),
            std::fs::read(second_manifest.parent().unwrap().join("bundle.tgnw")).unwrap()
        );
        let mut changed = std::fs::read(&first_bundle).unwrap();
        let last = changed.len() - 1;
        changed[last] ^= 1;
        std::fs::write(&first_bundle, changed).unwrap();
        assert!(verify_archive(&first_manifest, &params).is_err());
        std::fs::remove_dir_all(first).unwrap();
        std::fs::remove_dir_all(second).unwrap();
    }
}
