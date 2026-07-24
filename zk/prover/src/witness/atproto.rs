//! Host-side lane-2 (atproto) witness assembly (MULTI_PROGRAM_PLATFORM §7, HYPERCERTS_ATPROTO_PLAN §7).
//!
//! Given a set of registered DIDs, this materializes a self-contained, offline-reproducible
//! witness bundle: the repo CAR at its current commit + the DID's PLC audit log, both archived
//! at observation time (old commits are not re-servable — deletion in atproto is trace-free, so
//! archival is a soundness-adjacent duty, not a convenience). The manifest records the head digest
//! (the value the AnchorRegistry anchors) and content hashes so `execute`/`prove` run offline.
//!
//! The JSON→dag-cbor conversion for PLC ops is the SAME one pinned by the genesis-hash == DID check
//! inside `envelopes::atproto::plc::verify_chain`: the host cannot smuggle a non-canonical encoding
//! because the DID hash and every `prev` CID pin the exact bytes. We reuse the `envelopes` crate
//! verbatim so the assembled witness is byte-checked against the very code the guest runs.

use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use anyhow::{anyhow, bail, Context, Result};
use envelopes::atproto::{self, plc::PlcOpWitness, AtprotoWitness};
use ipld_core::ipld::Ipld;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;

/// Default relay entry point; getRepo here 302-redirects to the owning PDS host (M1 finding) —
/// reqwest follows it automatically.
pub const DEFAULT_RELAY_URL: &str = "https://bsky.network";
/// Default PLC directory; a mirror can be substituted with `--plc-url`.
pub const DEFAULT_PLC_URL: &str = "https://plc.directory";
/// Default archive/bundle root, under the repo's gitignored generated-output directory
/// (resolved from this crate's manifest dir so it lands there from any CWD).
pub const DEFAULT_ARCHIVE_DIR: &str =
    concat!(env!("CARGO_MANIFEST_DIR"), "/../../.trustgraph/hypercerts/witness-archive");

/// Where the CAR + PLC log for a DID were sourced from (recorded in the manifest for auditability).
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WitnessSource {
    /// The relay/PDS entry URL the getRepo request started at.
    pub relay_url: String,
    /// The final URL after following redirects (the actual serving PDS host).
    pub pds_url: String,
    /// The PLC directory (or mirror) the audit log came from.
    pub plc_url: String,
}

/// One DID's manifest entry: the anchor-able head digest + content hashes + archive paths, enough
/// to re-run verification fully offline from the bundle.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WitnessEntry {
    pub did: String,
    /// Repo revision (commit `rev`) decoded from the archived CAR.
    pub rev: String,
    /// sha2-256 of the commit block — the anchored head (`0x`-hex). This is what you'd anchor.
    pub head_sha256: String,
    /// CAR path, relative to the bundle/archive root.
    pub car_path: String,
    pub car_sha256: String,
    /// PLC log path (raw directory JSON), relative to the bundle/archive root.
    pub plc_path: String,
    pub plc_sha256: String,
    /// Observation time (unix seconds).
    pub fetched_at: u64,
    pub source: WitnessSource,
}

/// The bundle manifest: everything `execute`/`prove` need, offline.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Bundle {
    pub version: u32,
    pub entries: Vec<WitnessEntry>,
}

/// Config for one `assemble` run.
pub struct FetchConfig {
    pub relay_url: String,
    pub plc_url: String,
    pub archive_dir: PathBuf,
}

impl Default for FetchConfig {
    fn default() -> Self {
        FetchConfig {
            relay_url: DEFAULT_RELAY_URL.to_string(),
            plc_url: DEFAULT_PLC_URL.to_string(),
            archive_dir: PathBuf::from(DEFAULT_ARCHIVE_DIR),
        }
    }
}

fn now_unix() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

fn http_client() -> Result<reqwest::blocking::Client> {
    reqwest::blocking::Client::builder()
        .user_agent("trustgraph-prover/witness-atproto")
        .timeout(std::time::Duration::from_secs(120))
        // reqwest follows up to 10 redirects by default — needed for the getRepo 302 to the PDS.
        .build()
        .context("build http client")
}

fn hex0x(bytes: &[u8]) -> String {
    format!("0x{}", hex::encode(bytes))
}

// --- PLC log: directory JSON → dag-cbor PlcOpWitness ------------------------------------------

/// JSON → Ipld for PLC ops. Strings/lists/maps/null/bool/ints only (a PLC op's `sig` is base64
/// text and `prev` is a CID *string* — there are no byte or float fields). This is the exact
/// conversion whose correctness is pinned by the genesis-hash == DID check in `verify_chain`.
fn json_to_ipld(v: &serde_json::Value) -> Result<Ipld> {
    Ok(match v {
        serde_json::Value::Null => Ipld::Null,
        serde_json::Value::Bool(b) => Ipld::Bool(*b),
        serde_json::Value::Number(n) => {
            let i = n.as_i64().ok_or_else(|| anyhow!("non-integer number in PLC op: {n}"))?;
            Ipld::Integer(i as i128)
        }
        serde_json::Value::String(s) => Ipld::String(s.clone()),
        serde_json::Value::Array(a) => {
            Ipld::List(a.iter().map(json_to_ipld).collect::<Result<Vec<_>>>()?)
        }
        serde_json::Value::Object(o) => {
            let mut m = BTreeMap::new();
            for (k, val) in o {
                m.insert(k.clone(), json_to_ipld(val)?);
            }
            Ipld::Map(m)
        }
    })
}

/// Parse an RFC3339 timestamp to whole unix seconds (proper parse — no year-only hack).
fn rfc3339_to_unix(s: &str) -> Result<u64> {
    let dt = chrono::DateTime::parse_from_rfc3339(s)
        .with_context(|| format!("parse createdAt RFC3339: {s}"))?;
    let secs = dt.timestamp();
    u64::try_from(secs).map_err(|_| anyhow!("negative createdAt: {s}"))
}

/// Parse a raw PLC audit-log JSON (the `GET /{did}/log/audit` response) into the witnessed
/// `PlcOpWitness` list, returning the DID as well. Used both when assembling and when replaying a
/// bundle from disk — one canonicalization path, no drift.
pub fn parse_plc_log(raw_json: &[u8]) -> Result<(String, Vec<PlcOpWitness>)> {
    let val: serde_json::Value =
        serde_json::from_slice(raw_json).context("PLC audit log is not valid JSON")?;
    let arr = val.as_array().ok_or_else(|| anyhow!("PLC audit log is not a JSON array"))?;
    if arr.is_empty() {
        bail!("PLC audit log is empty");
    }
    let mut did = String::new();
    let mut ops = Vec::with_capacity(arr.len());
    for entry in arr {
        did = entry["did"].as_str().ok_or_else(|| anyhow!("PLC entry missing did"))?.to_string();
        let op_ipld = json_to_ipld(&entry["operation"])?;
        let op_bytes =
            serde_ipld_dagcbor::to_vec(&op_ipld).context("re-encode PLC op to dag-cbor")?;
        let created_at = rfc3339_to_unix(
            entry["createdAt"].as_str().ok_or_else(|| anyhow!("PLC entry missing createdAt"))?,
        )?;
        let nullified = entry["nullified"].as_bool().unwrap_or(false);
        ops.push(PlcOpWitness { op_bytes, created_at, nullified });
    }
    Ok((did, ops))
}

// --- CAR: rev + head extraction ---------------------------------------------------------------

/// Decode the archived CAR's commit block and return `(rev, head_sha256)`. The head is the sha2-256
/// digest of the commit block (the value the AnchorRegistry anchors); `rev` keys the archive.
pub fn car_rev_and_head(car: &[u8]) -> Result<(String, [u8; 32])> {
    let parsed = atproto::carset::Car::parse(car).map_err(|e| anyhow!("CAR parse: {e}"))?;
    let root = *parsed.roots.first().ok_or_else(|| anyhow!("CAR has no root"))?;
    let commit_bytes = parsed.get(&root).ok_or_else(|| anyhow!("CAR missing root block"))?;
    let head: [u8; 32] = Sha256::digest(commit_bytes).into();
    let cf =
        atproto::commit::decode_commit(commit_bytes).map_err(|e| anyhow!("commit decode: {e}"))?;
    Ok((cf.rev, head))
}

// --- network fetch ----------------------------------------------------------------------------

/// Fetch the full repo CAR via `com.atproto.sync.getRepo`. Returns `(car_bytes, final_url)`.
/// The default relay 302-redirects to the owning PDS host; the client follows it.
fn fetch_repo_car(
    client: &reqwest::blocking::Client,
    relay_url: &str,
    did: &str,
) -> Result<(Vec<u8>, String)> {
    let url =
        format!("{}/xrpc/com.atproto.sync.getRepo?did={}", relay_url.trim_end_matches('/'), did);
    let resp = client.get(&url).send().with_context(|| format!("getRepo GET {url}"))?;
    let final_url = resp.url().to_string();
    let resp = resp.error_for_status().with_context(|| format!("getRepo status for {did}"))?;
    let bytes = resp.bytes().context("read getRepo body")?.to_vec();
    if bytes.is_empty() {
        bail!("getRepo returned empty body for {did}");
    }
    Ok((bytes, final_url))
}

/// Fetch the DID's PLC audit log (`GET /{did}/log/audit`). Returns the raw JSON bytes.
fn fetch_plc_log(client: &reqwest::blocking::Client, plc_url: &str, did: &str) -> Result<Vec<u8>> {
    let url = format!("{}/{}/log/audit", plc_url.trim_end_matches('/'), did);
    let resp = client.get(&url).send().with_context(|| format!("PLC GET {url}"))?;
    let resp = resp.error_for_status().with_context(|| format!("PLC status for {did}"))?;
    Ok(resp.bytes().context("read PLC body")?.to_vec())
}

// --- assemble ---------------------------------------------------------------------------------

/// Fetch, archive, and manifest one DID. Writes `<did>/<rev>.car` and
/// `<did>/plc-<fetch-unixtime>.json` under the archive dir, returning the manifest entry.
fn assemble_one(
    client: &reqwest::blocking::Client,
    cfg: &FetchConfig,
    did: &str,
) -> Result<WitnessEntry> {
    let fetched_at = now_unix();

    let (car, pds_url) = fetch_repo_car(client, &cfg.relay_url, did)?;
    let plc_raw = fetch_plc_log(client, &cfg.plc_url, did)?;

    // Validate the PLC log parses/canonicalizes before we commit it to the archive.
    let (plc_did, _ops) = parse_plc_log(&plc_raw)?;
    if plc_did != did {
        bail!("PLC log DID {plc_did} does not match requested {did}");
    }

    let (rev, head) = car_rev_and_head(&car)?;

    // Archive keyed <did>/<rev>.car + <did>/plc-<fetch-unixtime>.json.
    let did_dir = cfg.archive_dir.join(did);
    std::fs::create_dir_all(&did_dir)
        .with_context(|| format!("create archive dir {}", did_dir.display()))?;
    let car_rel = format!("{did}/{rev}.car");
    let plc_rel = format!("{did}/plc-{fetched_at}.json");
    std::fs::write(cfg.archive_dir.join(&car_rel), &car).context("write archived CAR")?;
    std::fs::write(cfg.archive_dir.join(&plc_rel), &plc_raw).context("write archived PLC log")?;

    Ok(WitnessEntry {
        did: did.to_string(),
        rev,
        head_sha256: hex0x(&head),
        car_path: car_rel,
        car_sha256: hex0x(&Sha256::digest(&car)),
        plc_path: plc_rel,
        plc_sha256: hex0x(&Sha256::digest(&plc_raw)),
        fetched_at,
        source: WitnessSource {
            relay_url: cfg.relay_url.clone(),
            pds_url,
            plc_url: cfg.plc_url.clone(),
        },
    })
}

/// Assemble a witness bundle for `dids`: fetch + archive each, write `manifest.json` at the archive
/// root, and return `(manifest_path, bundle)`. `execute`/`prove` are reproducible offline from here.
/// With `keep_going`, a DID that fails (wrong PDS, takendown, …) is warned about and excluded from
/// the manifest instead of aborting the bundle.
pub fn assemble(dids: &[String], cfg: &FetchConfig, keep_going: bool) -> Result<(PathBuf, Bundle)> {
    std::fs::create_dir_all(&cfg.archive_dir)
        .with_context(|| format!("create archive dir {}", cfg.archive_dir.display()))?;
    let client = http_client()?;

    let mut entries = Vec::with_capacity(dids.len());
    for did in dids {
        match assemble_one(&client, cfg, did) {
            Ok(entry) => entries.push(entry),
            Err(e) if keep_going => eprintln!("skip {did}: {e:#}"),
            Err(e) => return Err(e),
        }
    }
    if entries.is_empty() {
        anyhow::bail!("no DID could be assembled — every fetch failed");
    }

    let bundle = Bundle { version: 1, entries };
    let manifest_path = cfg.archive_dir.join("manifest.json");
    std::fs::write(&manifest_path, serde_json::to_vec_pretty(&bundle)?)
        .context("write manifest.json")?;
    Ok((manifest_path, bundle))
}

// --- offline self-check -----------------------------------------------------------------------

/// Reconstruct the `AtprotoWitness` for one manifest entry by RELOADING the archived files (the
/// offline path `execute`/`prove` take), re-running the exact JSON→dag-cbor canonicalization.
pub fn witness_from_entry(root: &Path, entry: &WitnessEntry) -> Result<(AtprotoWitness, [u8; 32])> {
    let car = std::fs::read(root.join(&entry.car_path))
        .with_context(|| format!("read archived CAR {}", entry.car_path))?;
    let plc_raw = std::fs::read(root.join(&entry.plc_path))
        .with_context(|| format!("read archived PLC log {}", entry.plc_path))?;
    let (did, plc_ops) = parse_plc_log(&plc_raw)?;
    let (_rev, head) = car_rev_and_head(&car)?;
    Ok((AtprotoWitness { did, car, plc_ops }, head))
}

/// A handful of common atproto collections, walked purely to demonstrate the assembled witness
/// verifies end-to-end and to surface record counts. Record SEMANTICS are per-program; this is a
/// soundness self-check of assembly, not the program's edge set.
pub const SELF_CHECK_COLLECTIONS: &[&str] =
    &["app.bsky.graph.follow", "app.bsky.actor.profile", "app.bsky.graph.block"];

/// Run `envelopes::atproto::verify` over a reloaded bundle entry (identity binding, CAR content-
/// addressing, head match, commit signature, full PLC chain, MST range walks). Returns per-
/// collection record counts. This is the proof that assembly produced a witness the guest accepts.
pub fn self_check(root: &Path, entry: &WitnessEntry) -> Result<Vec<(String, usize)>> {
    let (witness, head) = witness_from_entry(root, entry)?;
    let node_id = atproto::did_node_id(&witness.did);
    // `now` drives only the 72h-provisional key rule; the observation time is the honest choice.
    let now = entry.fetched_at;
    let mut counts = Vec::new();
    for c in SELF_CHECK_COLLECTIONS {
        let recs = atproto::verify(node_id, head.into(), now, &[c], &witness)
            .map_err(|e| anyhow!("envelope verify failed for {}: {e:?}", entry.did))?;
        counts.push((c.to_string(), recs.len()));
    }
    Ok(counts)
}
