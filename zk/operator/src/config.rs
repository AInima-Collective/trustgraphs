//! The operator's configuration file, exactly as `docs/build/run-a-prover.md` §2 documents it.
//!
//! Every key has a default except `rpc` and `registry`. That is deliberate: a missing key should
//! be a recorded decision, not a stall. What is NOT configurable is also
//! deliberate — anything absent from here, the operator does not do.

use alloy_primitives::{keccak256, Address, B256};
use anyhow::{Context, Result};
use operator_core::manifest::{Manifest, ManifestEntry};
use operator_core::policy::{LossBudget, Policy};
use operator_core::types::Program;
use operator_core::work::{CapabilityProfile, OPERATOR_CYCLE_LIMIT};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};

#[derive(Debug, Deserialize)]
pub struct Config {
    pub rpc: String,
    /// Optional sanitized public release manifest. RPC credentials remain in this TOML; chain
    /// identity and deployed contract coordinates come from the tracked JSON release record.
    #[serde(default)]
    pub release_manifest: Option<PathBuf>,
    /// Guest identities copied from the sanitized release manifest. They are checked against the
    /// ELFs embedded in the operator binary before any chain work or proving can begin.
    #[serde(skip)]
    release_programs: BTreeMap<Program, ReleaseProgramIdentity>,
    #[serde(default)]
    pub registry: Address,
    /// Checked against `eth_chainId` at startup, never trusted over it.
    #[serde(default)]
    pub chain_id: Option<u64>,

    /// How long one JSON-RPC round trip may take. See [`crate::chain::DEFAULT_RPC_TIMEOUT_SECONDS`]
    /// for why a finite value is not optional.
    #[serde(default)]
    rpc_timeout_seconds: Option<u64>,

    /// The block `registry` was deployed at. The `InstanceRegistered` scan starts here.
    ///
    /// Zero is correct on a fresh devnet and wrong everywhere else. Left at zero against a
    /// registry deployed at block 21,000,000 the daemon issues ~2,100 empty `eth_getLogs` calls
    /// before it can decide anything, and most public providers reject the range outright as an
    /// archive request — so the failure is not "slow", it is "no catalog, every tick". Startup
    /// says so out loud rather than letting it be discovered in production.
    #[serde(default)]
    pub registry_from_block: u64,

    #[serde(default)]
    pub manifest: Vec<ManifestEntry>,
    #[serde(default)]
    pub curated: Curated,
    #[serde(default)]
    pub paid: Paid,
    #[serde(default)]
    pub cadence: Cadence,
    #[serde(default)]
    pub gas: Gas,
    #[serde(default)]
    pub finality: Finality,
    #[serde(default)]
    pub prover: Prover,
    #[serde(default)]
    pub budget: Budget,
    /// Derived signer proofs are a distinct workload and liability envelope. They follow landed
    /// score checkpoints but have their own enable switch, finality depth, and rolling caps.
    #[serde(default)]
    pub signer_sync: SignerSync,
    #[serde(default)]
    pub ipfs: Ipfs,
    /// Recovery policy for checkpoint-critical TGWP prior manifests. These bytes are input data,
    /// not score publication blobs, so their cache and mirrors have a separate failure budget.
    #[serde(default)]
    pub weighted_manifests: WeightedManifests,
    #[serde(default)]
    pub ops: Ops,
}

/// Where to publish the score blob.
///
/// The chain carries the root and the CID, never the scores. Without this the daemon lands roots
/// nobody can read: the indexer fetches the blob by CID to build its member list, and a network
/// page over an unpublished root renders empty. An empty target set is accepted only so `--dry-run`
/// can inspect a chain without storage credentials; [`crate::run::run`] rejects it before enabling
/// a submitter.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Ipfs {
    /// Independent kubo or managed-pinning targets. Every target is verified through its reader
    /// gateway before it counts toward the publication minimum.
    #[serde(default)]
    pub targets: Vec<PinTarget>,
    /// How many independent targets must accept and serve the exact CID before a proof may submit.
    /// Defaults to all configured targets. Zero is valid only for targetless `--dry-run`.
    #[serde(default)]
    pub min_success: Option<usize>,
    /// Persistent retry cadence after a failed publication policy, in seconds.
    #[serde(default = "d_publication_retry")]
    pub retry_seconds: u64,
    /// Digest-verified strict Envelope0 recovery cache. These are prover inputs, not publication
    /// outputs, but they reuse the configured target gateways as independent readers.
    ///
    /// Unset means `envelope0` inside `[ops] state_dir`. Read it through
    /// [`Config::envelope0_cache_dir`], never directly: only that path applies the resolution.
    #[serde(default)]
    envelope0_cache_dir: Option<String>,
    /// Bounded parallelism across newest node bundles.
    #[serde(default = "d_envelope0_fetch_concurrency")]
    pub envelope0_fetch_concurrency: usize,
}

#[derive(Debug, Deserialize)]
pub struct WeightedManifests {
    /// Durable local cache. Active and pending versions are protected from eviction by callers.
    ///
    /// Unset means `weighted-manifests` inside `[ops] state_dir`. Read it through
    /// [`Config::weighted_cache_dir`].
    #[serde(default)]
    cache_dir: Option<String>,
    /// Raw-CID gateways. The canonical CID is appended to each string verbatim.
    #[serde(default)]
    pub mirrors: Vec<String>,
    #[serde(default = "d_weighted_cache_versions")]
    pub max_versions: usize,
    #[serde(default = "d_weighted_cache_bytes")]
    pub max_bytes: u64,
    #[serde(default = "d_weighted_retry")]
    pub retry_seconds: u64,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum PinTargetKind {
    /// A Kubo-compatible `/api/v0/add` endpoint. This remains the default for old configs.
    #[default]
    Kubo,
    /// Pinata's typed v3 file upload API.
    Pinata,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct PinTarget {
    pub name: String,
    #[serde(default)]
    pub kind: PinTargetKind,
    pub api: String,
    pub gateway: String,
    /// Name of the environment variable holding the managed service's bearer token. The name is
    /// safe to persist in the publication policy; the token itself never enters config or logs.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub token_env: Option<String>,
}

/// The free tier, and the whole of it. There is no unconditional one: a permissionless factory
/// plus an unconditional free tier is unbounded liability.
#[derive(Debug, Default, Deserialize)]
pub struct Curated {
    #[serde(default)]
    pub instances: Vec<B256>,
    /// Populate the curated subsidy set from the sanitized release manifest. A deployment profile
    /// may use this only when the manifest names exactly one deliberately recorded test network;
    /// an empty or broad catalog fails closed instead of silently changing who the operator funds.
    #[serde(default)]
    pub single_release_instance: bool,
}

#[derive(Debug, Default, Deserialize)]
pub struct Paid {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default)]
    pub vault: Option<Address>,
    /// Our payee. It goes in the JOURNAL, which is what makes it unsnipeable.
    #[serde(default)]
    pub recipient: Option<Address>,
}

#[derive(Debug, Deserialize)]
pub struct Cadence {
    #[serde(default = "d_tick")]
    pub tick_seconds: u64,
    #[serde(default = "d_subsidy")]
    pub subsidy_min_blocks: u64,
    #[serde(default = "d_concurrent")]
    pub max_concurrent: usize,
    /// Do not raise this. One in-flight proof per instance is what makes the request journal a
    /// sufficient record of money at risk.
    #[serde(default = "d_one")]
    pub max_per_instance: usize,
}

#[derive(Debug, Deserialize)]
pub struct Gas {
    #[serde(default = "d_basefee_gwei")]
    pub max_basefee_gwei: u64,
    #[serde(default = "d_priority_gwei")]
    pub priority_fee_gwei: f64,
    #[serde(default = "d_replacement")]
    pub replacement_after_s: u64,
    /// `eth_call` first; a revert is a hold, not a broadcast.
    #[serde(default = "d_true")]
    pub simulate_before_send: bool,
}

#[derive(Debug, Deserialize)]
pub struct Finality {
    #[serde(default = "d_confirmations")]
    pub confirmations: u64,
    #[serde(default = "d_true")]
    pub track_block_hash: bool,
}

#[derive(Debug, Deserialize)]
pub struct Prover {
    /// `network` | `cpu` | `mock`. Written into `SP1_PROVER` for the prover library.
    #[serde(default = "d_backend")]
    pub backend: String,
    #[serde(default = "d_true")]
    pub groth16: bool,
    #[serde(default = "d_timeout")]
    pub timeout_s: u64,
    /// Operator-local refusal envelope. This is policy, not a guest or vkey assertion.
    #[serde(default = "d_cycle_limit")]
    pub cycle_limit: u64,
    /// Versioned, published host resource envelope. Every field may be overridden independently.
    #[serde(default)]
    pub capability_profile: CapabilityProfile,
}

#[derive(Debug, Deserialize)]
pub struct Budget {
    #[serde(default = "d_per_instance_usd")]
    pub per_instance_usd_per_day: u64,
    #[serde(default = "d_global_usd")]
    pub global_usd_per_day: u64,
    /// What a billion guest cycles costs us, in cents. This is what turns a cycle estimate into
    /// the number the budget is denominated in.
    ///
    /// Deliberately a single crude constant rather than a live price feed: the budget's job is to
    /// stop a runaway, not to do accounting. Being 2x wrong moves the halt point by 2x; being
    /// ABSENT — which is what shipping without it meant — moves it to never.
    #[serde(default = "d_cents_per_gcycle")]
    pub cents_per_billion_cycles: u64,
    /// The rolling window the caps are measured over, in seconds.
    #[serde(default = "d_budget_window")]
    pub window_seconds: u64,
    /// Crude ETH/USD used to convert on-chain gas burn into the budget's cents (H-3). The same
    /// philosophy as `cents_per_billion_cycles`: a stop-the-runaway constant, not a price feed.
    /// Being 2x wrong moves the halt point by 2x; leaving gas out of the budget entirely — the
    /// pre-audit behavior — moved it to never.
    #[serde(default = "d_eth_usd")]
    pub eth_usd: u64,
    /// Page before the rolling global loss ceiling becomes a hard halt. This is deliberately a
    /// percentage of the configured cap so changing the deployment budget cannot leave a stale
    /// absolute alert threshold behind.
    #[serde(default = "d_budget_alert_percent")]
    pub global_alert_percent: u8,
}

#[derive(Debug, Deserialize)]
pub struct SignerSync {
    #[serde(default = "d_true")]
    pub enabled: bool,
    #[serde(default = "d_signer_confirmations")]
    pub confirmations: u64,
    #[serde(default = "d_true")]
    pub track_block_hash: bool,
    #[serde(default = "d_signer_per_instance_usd")]
    pub per_instance_usd_per_day: u64,
    #[serde(default = "d_signer_global_usd")]
    pub global_usd_per_day: u64,
    #[serde(default = "d_budget_window")]
    pub budget_window_seconds: u64,
}

#[derive(Debug, Deserialize)]
pub struct Ops {
    /// The one directory everything the daemon owns lives under: the request journal, the
    /// heartbeat, both recovery caches, and the per-checkpoint working files.
    ///
    /// Unset means `.trustgraph/operator` beside the config file. Set it and you are naming a
    /// location — see [`Config::ensure_state_dir`] for what the daemon then refuses to do.
    #[serde(default)]
    state_dir: Option<String>,
    /// True when the config file named a `state_dir`. Resolution fills the field in either way,
    /// so this is the only surviving record of whether a human chose the location — which is
    /// what decides whether a missing parent directory is created or refused.
    #[serde(skip)]
    state_dir_named: bool,
    /// Overrides `journal.jsonl` inside `state_dir`. Read through [`Config::journal_path`].
    #[serde(default)]
    journal_path: Option<String>,
    /// Overrides `status.json` inside `state_dir`. Read through [`Config::status_path`].
    #[serde(default)]
    status_path: Option<String>,
    /// `host:port` for the read-only health and heartbeat listener. Unset means no socket.
    ///
    /// What it serves is in [`crate::health`]: `/health`, `/ready`, and an allowlisted projection
    /// of the heartbeat. There is no route that changes anything, so exposing it costs nothing
    /// beyond publishing operating policy that is already meant to be public.
    #[serde(default)]
    pub listen: Option<String>,
    /// How stale the last completed tick may be before `/ready` reports failure.
    ///
    /// Defaults to three ticks, with a 90 second floor so a fast local cadence does not make the
    /// probe a hair trigger. Raise it above your longest proof if the daemon proves in-process
    /// (`prover.backend = "cpu"`): a platform that restarts on a failed readiness probe would
    /// otherwise restart the daemon mid-proof. The journal makes that safe — the restart
    /// re-attaches rather than re-requesting — but it is not free.
    #[serde(default)]
    ready_after_seconds: Option<u64>,
    /// Directory holding the prebuilt helper binaries the daemon shells out to
    /// (`input-exporter`, `envelope0-preflight`, `trustgraph-prover`). Unset means look next to
    /// the operator executable, then fall back to `cargo run` from a source checkout — which is
    /// the developer loop and the only mode that needs a Rust toolchain at runtime. See
    /// [`crate::tools`].
    #[serde(default)]
    pub tool_dir: Option<String>,
    /// Hard wall-clock deadline for one helper subprocess. A helper that outlives this budget is
    /// killed as a process group so a stalled RPC, compiler, or grandchild cannot wedge the tick
    /// loop forever.
    #[serde(default = "d_tool_timeout")]
    pub tool_timeout_seconds: u64,
    #[serde(default)]
    pub alert_webhook: Option<String>,
    #[serde(default)]
    pub log_format: LogFormat,
    /// Consecutive deterministic submit reverts before one immutable checkpoint is terminally
    /// abandoned. Transient/provider/fee/reorg failures do not consume attempts.
    #[serde(default = "d_submit_failure_threshold")]
    pub submit_failure_threshold: u32,
}

/// Console output is for a human by default. JSON remains available for log collectors and
/// scripts that need a stable, one-record-per-line shape.
#[derive(Clone, Copy, Debug, Default, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum LogFormat {
    #[default]
    Text,
    Json,
}

fn d_tick() -> u64 {
    60
}
fn d_subsidy() -> u64 {
    216_000
}
fn d_concurrent() -> usize {
    4
}
fn d_one() -> usize {
    1
}
fn d_basefee_gwei() -> u64 {
    40
}
fn d_priority_gwei() -> f64 {
    0.1
}
fn d_replacement() -> u64 {
    300
}
fn d_true() -> bool {
    true
}
fn d_confirmations() -> u64 {
    12
}
fn d_signer_confirmations() -> u64 {
    24
}
fn d_backend() -> String {
    "network".into()
}
fn d_timeout() -> u64 {
    3_600
}
fn d_cycle_limit() -> u64 {
    OPERATOR_CYCLE_LIMIT
}
fn d_per_instance_usd() -> u64 {
    25
}
fn d_global_usd() -> u64 {
    250
}
fn d_signer_per_instance_usd() -> u64 {
    5
}
fn d_signer_global_usd() -> u64 {
    50
}
fn d_cents_per_gcycle() -> u64 {
    100
}
fn d_budget_window() -> u64 {
    86_400
}
fn d_eth_usd() -> u64 {
    5_000
}
fn d_budget_alert_percent() -> u8 {
    80
}
fn d_publication_retry() -> u64 {
    300
}
fn d_envelope0_fetch_concurrency() -> usize {
    8
}
fn d_weighted_cache_versions() -> usize {
    128
}
fn d_weighted_cache_bytes() -> u64 {
    16 * 1024 * 1024
}
fn d_weighted_retry() -> u64 {
    300
}
/// The state directory a config that does not name one gets, relative to the config file.
const DEFAULT_STATE_DIR: &str = ".trustgraph/operator";
const JOURNAL_FILE: &str = "journal.jsonl";
const STATUS_FILE: &str = "status.json";
const ENVELOPE0_CACHE: &str = "envelope0";
const WEIGHTED_CACHE: &str = "weighted-manifests";
fn d_submit_failure_threshold() -> u32 {
    3
}
fn d_tool_timeout() -> u64 {
    900
}

impl Default for Cadence {
    fn default() -> Self {
        Self {
            tick_seconds: d_tick(),
            subsidy_min_blocks: d_subsidy(),
            max_concurrent: d_concurrent(),
            max_per_instance: d_one(),
        }
    }
}
impl Default for Gas {
    fn default() -> Self {
        Self {
            max_basefee_gwei: d_basefee_gwei(),
            priority_fee_gwei: d_priority_gwei(),
            replacement_after_s: d_replacement(),
            simulate_before_send: true,
        }
    }
}
impl Default for Finality {
    fn default() -> Self {
        Self { confirmations: d_confirmations(), track_block_hash: true }
    }
}
impl Default for Prover {
    fn default() -> Self {
        Self {
            backend: d_backend(),
            groth16: true,
            timeout_s: d_timeout(),
            cycle_limit: d_cycle_limit(),
            capability_profile: CapabilityProfile::default(),
        }
    }
}
impl Default for Budget {
    fn default() -> Self {
        Self {
            per_instance_usd_per_day: d_per_instance_usd(),
            global_usd_per_day: d_global_usd(),
            cents_per_billion_cycles: d_cents_per_gcycle(),
            window_seconds: d_budget_window(),
            eth_usd: d_eth_usd(),
            global_alert_percent: d_budget_alert_percent(),
        }
    }
}
impl Default for SignerSync {
    fn default() -> Self {
        Self {
            enabled: true,
            confirmations: d_signer_confirmations(),
            track_block_hash: true,
            per_instance_usd_per_day: d_signer_per_instance_usd(),
            global_usd_per_day: d_signer_global_usd(),
            budget_window_seconds: d_budget_window(),
        }
    }
}
impl Default for Ipfs {
    fn default() -> Self {
        Self {
            targets: Vec::new(),
            min_success: None,
            retry_seconds: d_publication_retry(),
            envelope0_cache_dir: None,
            envelope0_fetch_concurrency: d_envelope0_fetch_concurrency(),
        }
    }
}
impl Default for WeightedManifests {
    fn default() -> Self {
        Self {
            cache_dir: None,
            mirrors: Vec::new(),
            max_versions: d_weighted_cache_versions(),
            max_bytes: d_weighted_cache_bytes(),
            retry_seconds: d_weighted_retry(),
        }
    }
}
impl Default for Ops {
    fn default() -> Self {
        Self {
            listen: None,
            ready_after_seconds: None,
            state_dir: None,
            state_dir_named: false,
            journal_path: None,
            status_path: None,
            tool_dir: None,
            tool_timeout_seconds: d_tool_timeout(),
            alert_webhook: None,
            log_format: LogFormat::default(),
            submit_failure_threshold: d_submit_failure_threshold(),
        }
    }
}

/// `path` if it is already absolute, otherwise anchored at `base`.
fn absolutize(base: &Path, path: &Path) -> PathBuf {
    let joined = if path.is_absolute() { path.to_path_buf() } else { base.join(path) };
    // `./x`, `x` and `a/./x` all name the same file; only one of them reads well in a log line,
    // an error, or an alert a human is trying to act on at 3am. `..` is left alone on purpose:
    // resolving it lexically is wrong the moment a symlink is involved.
    let mut clean = PathBuf::new();
    for component in joined.components() {
        if component != std::path::Component::CurDir {
            clean.push(component);
        }
    }
    clean
}

/// Prove a directory is writable by writing to it. `access(2)`-style permission checks lie on
/// read-only mounts and on filesystems that are simply full.
fn writable(dir: &Path) -> Result<()> {
    let probe = dir.join(".operator-write-probe");
    std::fs::write(&probe, b"")?;
    let _ = std::fs::remove_file(&probe);
    Ok(())
}

impl Config {
    pub fn load(path: &Path) -> Result<Self> {
        let text = std::fs::read_to_string(path)
            .with_context(|| format!("read operator config {}", path.display()))?;
        let mut cfg: Config = toml::from_str(&text)
            .with_context(|| format!("parse operator config {}", path.display()))?;
        cfg.resolve_environment_references()?;
        // Every relative path in this file is relative to the FILE, never to whatever directory
        // the daemon happened to be started from. `release_manifest` has always worked this way;
        // now the journal, the heartbeat, both caches, the tool directory and every manifest
        // pointer do too, so `cd` stops being part of the deployment.
        let base = path.parent().unwrap_or_else(|| Path::new("."));
        let base = std::fs::canonicalize(base).unwrap_or_else(|_| base.to_path_buf());
        if let Some(manifest_path) = cfg.release_manifest.clone() {
            cfg.apply_release_manifest(&absolutize(&base, &manifest_path))?;
        }
        cfg.resolve_paths(&base);
        cfg.validate()?;
        cfg.ensure_state_dir()?;
        Ok(cfg)
    }

    pub fn release_program_identities(&self) -> &BTreeMap<Program, ReleaseProgramIdentity> {
        &self.release_programs
    }

    /// Resolve secret endpoint references only after reading the tracked profile. This keeps RPC,
    /// gateway and alert credentials out of git without templating a TOML file in a shell. The
    /// resolved values stay in memory and never enter the public status projection.
    fn resolve_environment_references(&mut self) -> Result<()> {
        self.rpc = resolve_env_reference(&self.rpc, "rpc")?;
        if let Some(webhook) = self.ops.alert_webhook.as_mut() {
            *webhook = resolve_env_reference(webhook, "ops.alert_webhook")?;
        }
        for target in &mut self.ipfs.targets {
            target.api =
                resolve_env_reference(&target.api, &format!("ipfs target {:?} api", target.name))?;
            target.gateway = resolve_env_reference(
                &target.gateway,
                &format!("ipfs target {:?} gateway", target.name),
            )?;
        }
        Ok(())
    }

    /// Rewrite every relative path in the parsed config as an absolute one under `base`.
    fn resolve_paths(&mut self, base: &Path) {
        let named = self.ops.state_dir.as_deref().map(str::trim).filter(|d| !d.is_empty());
        self.ops.state_dir_named = named.is_some();
        let state = match named {
            Some(dir) => absolutize(base, Path::new(dir)),
            None => base.join(DEFAULT_STATE_DIR),
        };
        self.ops.state_dir = Some(state.display().to_string());

        for slot in [
            &mut self.ops.journal_path,
            &mut self.ops.status_path,
            &mut self.ops.tool_dir,
            &mut self.ipfs.envelope0_cache_dir,
            &mut self.weighted_manifests.cache_dir,
        ] {
            *slot = slot
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(|value| absolutize(base, Path::new(value)).display().to_string());
        }

        // A manifest entry is a set of pointers to files beside the config, and it was the last
        // thing that still made the daemon's working directory matter.
        for entry in &mut self.manifest {
            for slot in [Some(&mut entry.params)]
                .into_iter()
                .flatten()
                .chain(entry.selection.as_mut())
                .chain(entry.witness_manifests.iter_mut())
            {
                if !slot.trim().is_empty() {
                    *slot = absolutize(base, Path::new(slot.as_str())).display().to_string();
                }
            }
        }
    }

    /// The per-request budget for chain reads.
    pub fn rpc_timeout(&self) -> std::time::Duration {
        std::time::Duration::from_secs(
            self.rpc_timeout_seconds.unwrap_or(crate::chain::DEFAULT_RPC_TIMEOUT_SECONDS),
        )
    }

    /// The hard deadline for input reconstruction and preflight subprocesses.
    pub fn tool_timeout(&self) -> std::time::Duration {
        std::time::Duration::from_secs(self.ops.tool_timeout_seconds)
    }

    /// How stale `/ready` tolerates the last completed tick being.
    pub fn ready_after_seconds(&self) -> u64 {
        self.ops.ready_after_seconds.unwrap_or_else(|| (3 * self.cadence.tick_seconds).max(90))
    }

    /// What `/ready` allows each phase of a tick, derived from the limits the daemon already
    /// enforces on itself. A readiness probe stricter than the daemon's own patience would make
    /// the probe, rather than the failure, the thing that takes the daemon down.
    pub fn health_budgets(&self) -> crate::health::Budgets {
        crate::health::Budgets {
            ticking: self.ready_after_seconds(),
            // The subprocess is killed at its configured deadline. Readiness allows another minute
            // for process-group termination, error reporting, and the tick's cleanup path.
            reconstructing: self.ops.tool_timeout_seconds.saturating_add(60),
            // The prover's own timeout, plus room to fail and report cleanly.
            proving: self.prover.timeout_s.saturating_add(120),
            // `send_watched` watches for a receipt for up to ten minutes and logs nothing while it
            // does. That silence is legitimate and must not read as a hang.
            sending: 720,
            publishing: 300,
            // Deriving seven guest vkeys, then the first chain reads.
            starting: 300,
        }
    }

    /// The one directory the daemon owns. Always absolute after [`Config::load`].
    pub fn state_dir(&self) -> PathBuf {
        match self.ops.state_dir.as_deref() {
            Some(dir) => PathBuf::from(dir),
            // Only a Config built directly from TOML (tests) reaches this. Keep it identical to
            // what `load` would have produced from the working directory.
            None => PathBuf::from(DEFAULT_STATE_DIR),
        }
    }

    /// The append-only money record. The one file whose loss costs real money: a lost journal
    /// means re-requesting proofs that were already paid for.
    pub fn journal_path(&self) -> PathBuf {
        self.under_state(self.ops.journal_path.as_deref(), JOURNAL_FILE)
    }

    /// The scrapable heartbeat.
    pub fn status_path(&self) -> PathBuf {
        self.under_state(self.ops.status_path.as_deref(), STATUS_FILE)
    }

    /// Digest-verified strict Envelope0 recovery cache.
    pub fn envelope0_cache_dir(&self) -> PathBuf {
        self.under_state(self.ipfs.envelope0_cache_dir.as_deref(), ENVELOPE0_CACHE)
    }

    /// Durable TGWP prior-manifest cache.
    pub fn weighted_cache_dir(&self) -> PathBuf {
        self.under_state(self.weighted_manifests.cache_dir.as_deref(), WEIGHTED_CACHE)
    }

    /// Per-instance, per-checkpoint working files: the reconstructed input, the held proof, and
    /// the params/selection files written out for the reconstruction tools.
    pub fn work_dir(&self, instance_id: B256) -> PathBuf {
        self.state_dir().join(format!("{instance_id:#x}"))
    }

    fn under_state(&self, configured: Option<&str>, leaf: &str) -> PathBuf {
        match configured {
            Some(path) => PathBuf::from(path),
            None => self.state_dir().join(leaf),
        }
    }

    /// Refuse to start rather than write the journal somewhere it will not survive.
    ///
    /// The daemon creates its state directory, but when a config NAMES one it does not create the
    /// tree above it. An absolute path whose parent is missing is exactly what an unmounted
    /// volume looks like, and happily creating `/data/trustgraph` on the container's own
    /// filesystem would put `journal.jsonl` on a disk that disappears at the next deploy — after
    /// which the daemon re-requests, and re-pays for, proofs it already has.
    fn ensure_state_dir(&self) -> Result<()> {
        let dir = self.state_dir();
        if self.ops.state_dir_named && !dir.is_dir() {
            if let Some(parent) = dir.parent() {
                anyhow::ensure!(
                    parent.is_dir(),
                    "[ops] state_dir is {} but {} does not exist. This is what an unmounted \
                     volume looks like: creating the directory anyway would put the request \
                     journal on a filesystem that disappears at the next deploy, and a lost \
                     journal means re-requesting proofs already paid for. Mount the volume, or \
                     point state_dir somewhere that exists.",
                    dir.display(),
                    parent.display()
                );
            }
        }
        std::fs::create_dir_all(&dir)
            .with_context(|| format!("[ops] state_dir {} could not be created", dir.display()))?;
        anyhow::ensure!(
            dir.is_dir(),
            "[ops] state_dir {} exists but is not a directory",
            dir.display()
        );
        writable(&dir)
            .with_context(|| format!("[ops] state_dir {} is not writable", dir.display()))?;

        // The journal may be configured out of the state directory. Whatever holds it is the
        // directory that actually has to be durable, so it gets the same treatment.
        if let Some(parent) = self.journal_path().parent().filter(|p| *p != dir.as_path()) {
            std::fs::create_dir_all(parent).with_context(|| {
                format!("[ops] journal_path directory {} could not be created", parent.display())
            })?;
            writable(parent).with_context(|| {
                format!("[ops] journal_path directory {} is not writable", parent.display())
            })?;
        }
        Ok(())
    }

    fn apply_release_manifest(&mut self, path: &Path) -> Result<()> {
        let text = std::fs::read_to_string(path)
            .with_context(|| format!("read release manifest {}", path.display()))?;
        let manifest: OperatorReleaseManifest = serde_json::from_str(&text)
            .with_context(|| format!("parse release manifest {}", path.display()))?;
        anyhow::ensure!(manifest.version == 1, "release manifest version must be 1");
        anyhow::ensure!(manifest.status == "deployed", "release manifest is not finalized");
        anyhow::ensure!(manifest.stage == "production", "release manifest stage is not production");
        anyhow::ensure!(
            manifest.chain == "sepolia" && manifest.chain_id == 11_155_111,
            "release manifest is not bound to Ethereum Sepolia (11155111)"
        );
        anyhow::ensure!(
            manifest.deployment_commit.as_deref().is_some_and(|value| is_hex(value, 40, false)),
            "release manifest deploymentCommit is missing or invalid"
        );
        anyhow::ensure!(
            manifest.first_deployment_block.is_some(),
            "release manifest firstDeploymentBlock is missing"
        );
        self.release_programs.clear();
        for (program, label, identity) in [
            (Program::Trustgraphs, "trust-graph", manifest.programs.trust_graph),
            (Program::Signer, "signer", manifest.programs.signer),
        ] {
            anyhow::ensure!(
                is_hex(&identity.elf_sha256, 64, true),
                "release manifest {label} ELF digest is missing or invalid"
            );
            anyhow::ensure!(
                is_hex(&identity.vkey, 64, true),
                "release manifest {label} vkey is missing or invalid"
            );
            self.release_programs.insert(
                program,
                ReleaseProgramIdentity {
                    elf_sha256: identity.elf_sha256.trim_start_matches("0x").to_ascii_lowercase(),
                    vkey: identity
                        .vkey
                        .parse()
                        .with_context(|| format!("parse release manifest {label} vkey"))?,
                },
            );
        }

        match self.chain_id {
            Some(configured) => anyhow::ensure!(
                configured == manifest.chain_id,
                "operator chain_id {configured} conflicts with release manifest chainId {}",
                manifest.chain_id
            ),
            None => self.chain_id = Some(manifest.chain_id),
        }

        let registry = manifest.contracts.instance_registry.required("instanceRegistry")?;
        if self.registry == Address::ZERO {
            self.registry = registry.0;
        } else {
            anyhow::ensure!(
                self.registry == registry.0,
                "operator registry conflicts with release manifest instanceRegistry"
            );
        }
        if self.registry_from_block == 0 {
            self.registry_from_block = registry.1;
        } else {
            anyhow::ensure!(
                self.registry_from_block == registry.1,
                "operator registry_from_block conflicts with release manifest instanceRegistry block"
            );
        }

        if self.paid.enabled {
            let vault = manifest.contracts.proving_vault.required("provingVault")?.0;
            match self.paid.vault {
                Some(configured) => anyhow::ensure!(
                    configured == vault,
                    "operator paid vault conflicts with release manifest provingVault"
                ),
                None => self.paid.vault = Some(vault),
            }
        }
        if self.curated.single_release_instance {
            anyhow::ensure!(
                self.curated.instances.is_empty(),
                "[curated] cannot combine explicit instances with single_release_instance"
            );
            anyhow::ensure!(
                manifest.instances.len() == 1,
                "[curated] single_release_instance requires exactly one tracked release instance, found {}. Complete the browser creation milestone and record only that instance before starting the subsidized operator",
                manifest.instances.len()
            );
            self.curated.instances = vec![manifest.instances[0].instance_id];
        }
        Ok(())
    }

    /// Reject what cannot work, at load time rather than at spend time.
    pub fn validate(&self) -> Result<()> {
        self.manifest_struct().validate()?;

        // `rpc` is the first thing every tick touches, so a bad one has to be caught here or the
        // operator dies on `eth_chainId` with reqwest's "relative URL without a base" — an error
        // that names neither the field nor the file. The way that happens in practice is a config
        // written by a shell heredoc whose `$RPC` was not set: `rpc = ""` parses fine as TOML and
        // is only wrong at the moment of use.
        let rpc = self.rpc.trim();
        anyhow::ensure!(
            !rpc.is_empty(),
            "`rpc` is empty. If this config was generated by a shell heredoc, the variable it \
             interpolated was unset — check the file, not the shell."
        );
        anyhow::ensure!(
            rpc.starts_with("http://") || rpc.starts_with("https://"),
            "`rpc` must be an absolute http(s) URL, got {rpc:?}. The JSON-RPC transport posts to \
             it directly and cannot resolve a relative or scheme-less address."
        );
        anyhow::ensure!(
            self.registry != Address::ZERO,
            "`registry` is the zero address: there is no instance directory to enumerate, so \
             every tick would find nothing and report success"
        );
        anyhow::ensure!(
            !self.curated.single_release_instance || self.release_manifest.is_some(),
            "[curated] single_release_instance requires release_manifest"
        );

        if self.paid.enabled {
            anyhow::ensure!(
                self.paid.vault.is_some_and(|v| v != Address::ZERO),
                "[paid] enabled but `vault` is missing or zero: there is nothing to claim from"
            );
            anyhow::ensure!(
                self.paid.recipient.is_some_and(|r| r != Address::ZERO),
                "[paid] enabled but `recipient` is missing or zero: the bounty would be committed \
                 to the zero address, which means 'no bounty' — set it or turn [paid] off"
            );
        }
        anyhow::ensure!(
            self.cadence.max_per_instance == 1,
            "cadence.max_per_instance must be 1: more than one in-flight proof per instance makes \
             the request journal an incomplete record of money at risk"
        );
        anyhow::ensure!(
            self.ops.submit_failure_threshold > 0,
            "ops.submit_failure_threshold must be at least 1"
        );
        anyhow::ensure!(
            self.ops.tool_timeout_seconds > 0,
            "ops.tool_timeout_seconds must be at least 1; helper processes may not wait forever"
        );
        if let Some(listen) = self.ops.listen.as_deref().map(str::trim) {
            anyhow::ensure!(
                !listen.is_empty(),
                "[ops] listen is empty. Remove the key to run without a health listener; an \
                 empty string is not a way to say 'no socket'."
            );
            anyhow::ensure!(
                listen.rsplit_once(':').is_some_and(|(_, port)| port.parse::<u16>().is_ok()),
                "[ops] listen must be host:port (for example \"0.0.0.0:8080\"), got {listen:?}"
            );
        }
        anyhow::ensure!(
            self.ready_after_seconds() > 0,
            "[ops] ready_after_seconds must be at least 1"
        );
        anyhow::ensure!(
            self.rpc_timeout_seconds.is_none_or(|seconds| seconds > 0),
            "`rpc_timeout_seconds` must be at least 1. There is no way to say 'wait forever': a \
             provider that accepts the connection and never answers would stop the daemon \
             permanently, with no tick, no alert and no recovery."
        );
        anyhow::ensure!(self.prover.cycle_limit > 0, "prover.cycle_limit must be at least 1");
        anyhow::ensure!(
            (1..100).contains(&self.budget.global_alert_percent),
            "budget.global_alert_percent must be between 1 and 99"
        );
        for (name, limit) in [
            ("max_raw_records", self.prover.capability_profile.max_raw_records),
            ("max_live_edges", self.prover.capability_profile.max_live_edges),
            ("max_unique_nodes", self.prover.capability_profile.max_unique_nodes),
            ("max_out_degree", self.prover.capability_profile.max_out_degree),
            ("max_witness_bytes", self.prover.capability_profile.max_witness_bytes),
            ("max_lane2_anchors", self.prover.capability_profile.max_lane2_anchors),
            ("max_signature_checks", self.prover.capability_profile.max_signature_checks),
            ("max_iterations", self.prover.capability_profile.max_iterations),
        ] {
            anyhow::ensure!(limit > 0, "prover.capability_profile.{name} must be at least 1");
        }
        anyhow::ensure!(
            self.signer_sync.budget_window_seconds > 0,
            "signer_sync.budget_window_seconds must be at least 1"
        );
        self.ipfs.validate()?;
        self.weighted_manifests.validate()?;
        Ok(())
    }

    pub fn manifest_struct(&self) -> Manifest {
        Manifest { entries: self.manifest.clone() }
    }

    /// The policy for one instance. Curation is the only thing that differs per instance.
    pub fn policy_for(
        &self,
        instance_id: B256,
        program: Program,
        supported: BTreeSet<Program>,
    ) -> Policy {
        let signer = program == Program::Signer;
        let curated = signer || self.curated.instances.contains(&instance_id);
        Policy {
            curated,
            // A vault is consulted only when there is a paid path AND this instance is not one we
            // subsidize. With `[paid]` off the operator is self-proving — it pays for everything
            // it proves — and demanding a vault would make it refuse to work at all.
            requires_vault: self.paid.enabled && !curated,
            // Our subsidy cadence is our budget decision. It binds what WE pay for, and nothing
            // else: a community self-proving with its own keys is not throttled by it.
            subsidy_min_blocks: if curated { self.cadence.subsidy_min_blocks } else { 0 },
            max_basefee_wei: u128::from(self.gas.max_basefee_gwei) * 1_000_000_000,
            confirmations: if signer {
                self.signer_sync.confirmations
            } else {
                self.finality.confirmations
            },
            cycle_limit: self.prover.cycle_limit,
            capability_profile: self.prover.capability_profile,
            supported_programs: supported,
            loss_budget: LossBudget {
                per_instance_cents_per_day: if signer {
                    self.signer_sync.per_instance_usd_per_day * 100
                } else {
                    self.budget.per_instance_usd_per_day * 100
                },
                global_cents_per_day: if signer {
                    self.signer_sync.global_usd_per_day * 100
                } else {
                    self.budget.global_usd_per_day * 100
                },
            },
            ..Policy::default()
        }
    }

    pub fn budget_window_for(&self, program: Program) -> u64 {
        if program == Program::Signer {
            self.signer_sync.budget_window_seconds
        } else {
            self.budget.window_seconds
        }
    }

    pub fn tracks_block_hash_for(&self, program: Program) -> bool {
        if program == Program::Signer {
            self.signer_sync.track_block_hash
        } else {
            self.finality.track_block_hash
        }
    }

    /// The payee that goes in the journal. Zero when we are not being paid, which is legitimate
    /// and means exactly that.
    pub fn recipient(&self) -> Address {
        if self.paid.enabled {
            self.paid.recipient.unwrap_or(Address::ZERO)
        } else {
            Address::ZERO
        }
    }
}

#[derive(Debug, Deserialize)]
struct OperatorReleaseManifest {
    version: u64,
    status: String,
    stage: String,
    chain: String,
    #[serde(rename = "chainId")]
    chain_id: u64,
    #[serde(rename = "deploymentCommit")]
    deployment_commit: Option<String>,
    #[serde(rename = "firstDeploymentBlock")]
    first_deployment_block: Option<u64>,
    contracts: OperatorReleaseContracts,
    programs: OperatorReleasePrograms,
    #[serde(default)]
    instances: Vec<OperatorReleaseInstance>,
}

#[derive(Debug, Deserialize)]
struct OperatorReleaseInstance {
    #[serde(rename = "instanceId")]
    instance_id: B256,
}

#[derive(Debug, Deserialize)]
struct OperatorReleasePrograms {
    #[serde(rename = "trustGraph")]
    trust_graph: OperatorReleaseProgram,
    signer: OperatorReleaseProgram,
}

#[derive(Debug, Deserialize)]
struct OperatorReleaseProgram {
    #[serde(rename = "elfSha256")]
    elf_sha256: String,
    vkey: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ReleaseProgramIdentity {
    pub elf_sha256: String,
    pub vkey: B256,
}

#[derive(Debug, Deserialize)]
struct OperatorReleaseContracts {
    #[serde(rename = "instanceRegistry")]
    instance_registry: OperatorDeploymentRecord,
    #[serde(rename = "provingVault")]
    proving_vault: OperatorDeploymentRecord,
}

#[derive(Debug, Deserialize)]
struct OperatorDeploymentRecord {
    address: Option<Address>,
    block: Option<u64>,
}

impl OperatorDeploymentRecord {
    fn required(&self, name: &str) -> Result<(Address, u64)> {
        let address =
            self.address.context(format!("release manifest {name} address is missing"))?;
        let block = self.block.context(format!("release manifest {name} block is missing"))?;
        anyhow::ensure!(address != Address::ZERO, "release manifest {name} address is zero");
        Ok((address, block))
    }
}

fn is_hex(value: &str, digits: usize, prefixed: bool) -> bool {
    let value = if prefixed {
        match value.strip_prefix("0x") {
            Some(value) => value,
            None => return false,
        }
    } else {
        value
    };
    value.len() == digits
        && value.bytes().all(|byte| byte.is_ascii_hexdigit())
        && value.bytes().any(|byte| byte != b'0')
}

fn resolve_env_reference(value: &str, field: &str) -> Result<String> {
    let Some(name) = value.strip_prefix("env:") else {
        return Ok(value.to_string());
    };
    anyhow::ensure!(
        valid_env_name(name),
        "{field} has invalid environment reference {value:?}; use env:UPPER_SNAKE_CASE"
    );
    let resolved = std::env::var(name)
        .with_context(|| format!("{field} references missing environment variable {name}"))?;
    anyhow::ensure!(!resolved.trim().is_empty(), "{field} environment variable {name} is empty");
    Ok(resolved)
}

fn valid_env_name(name: &str) -> bool {
    !name.is_empty()
        && name
            .bytes()
            .all(|byte| byte == b'_' || byte.is_ascii_uppercase() || byte.is_ascii_digit())
        && !name.as_bytes()[0].is_ascii_digit()
}

impl WeightedManifests {
    fn validate(&self) -> Result<()> {
        anyhow::ensure!(
            self.max_versions >= 2,
            "weighted_manifests.max_versions must hold active and pending versions (at least 2)"
        );
        anyhow::ensure!(
            self.max_bytes >= 2 * (18 + 2_048 * 28),
            "weighted_manifests.max_bytes must hold max-size active and pending TGWP manifests"
        );
        anyhow::ensure!(
            self.retry_seconds > 0,
            "weighted_manifests.retry_seconds must be at least 1"
        );
        let mut unique = BTreeSet::new();
        for mirror in &self.mirrors {
            anyhow::ensure!(
                mirror.starts_with("http://") || mirror.starts_with("https://"),
                "weighted manifest mirror must be an absolute http(s) raw-CID gateway, got {mirror:?}"
            );
            anyhow::ensure!(unique.insert(mirror), "duplicate weighted manifest mirror {mirror}");
        }
        Ok(())
    }
}

impl Ipfs {
    pub fn resolved_targets(&self) -> Vec<PinTarget> {
        self.targets.clone()
    }

    pub fn required_successes(&self) -> usize {
        let count = self.resolved_targets().len();
        self.min_success.unwrap_or(count)
    }

    /// Stable identity of the durability contract. A stricter or redirected config invalidates
    /// an old `Published` journal record and forces the held blob through the new policy.
    pub fn policy_hash(&self) -> B256 {
        let policy = serde_json::json!({
            "targets": self.resolved_targets(),
            "min_success": self.required_successes(),
        });
        keccak256(serde_json::to_vec(&policy).expect("publication policy is serializable"))
    }

    fn validate(&self) -> Result<()> {
        anyhow::ensure!(
            (1..=64).contains(&self.envelope0_fetch_concurrency),
            "[ipfs] envelope0_fetch_concurrency must be in 1..=64"
        );
        let targets = self.resolved_targets();
        let required = self.required_successes();
        if targets.is_empty() {
            anyhow::ensure!(
                required == 0,
                "[ipfs] min_success is {required}, but no publication targets are configured"
            );
            return Ok(());
        }
        anyhow::ensure!(
            required > 0 && required <= targets.len(),
            "[ipfs] min_success must be between 1 and the {} configured targets, got {required}",
            targets.len()
        );
        anyhow::ensure!(self.retry_seconds > 0, "[ipfs] retry_seconds must be at least 1");

        let mut names = BTreeSet::new();
        let mut apis = BTreeSet::new();
        let mut gateways = BTreeSet::new();
        for target in &targets {
            anyhow::ensure!(!target.name.trim().is_empty(), "[ipfs] target name cannot be empty");
            anyhow::ensure!(
                names.insert(target.name.clone()),
                "[ipfs] target name {:?} is duplicated",
                target.name
            );
            anyhow::ensure!(
                apis.insert(target.api.clone()),
                "[ipfs] target API {:?} is duplicated; duplicate URLs are not independent durability",
                target.api
            );
            anyhow::ensure!(
                gateways.insert(target.gateway.clone()),
                "[ipfs] target gateway {:?} is duplicated; duplicate read paths are not independent durability",
                target.gateway
            );
            for (field, value) in [("api", &target.api), ("gateway", &target.gateway)] {
                anyhow::ensure!(
                    value.starts_with("http://") || value.starts_with("https://"),
                    "[ipfs] target {:?} {field} must be an absolute http(s) URL",
                    target.name
                );
            }
            anyhow::ensure!(
                target.gateway.ends_with("/ipfs/"),
                "[ipfs] target {:?} gateway must end in /ipfs/ because readers append the CID verbatim",
                target.name
            );
            match target.kind {
                PinTargetKind::Kubo => anyhow::ensure!(
                    target.token_env.is_none(),
                    "[ipfs] kubo target {:?} cannot set token_env; use kind = \"pinata\" for bearer-authenticated uploads",
                    target.name
                ),
                PinTargetKind::Pinata => {
                    anyhow::ensure!(
                        target.api.starts_with("https://"),
                        "[ipfs] Pinata target {:?} API must use HTTPS",
                        target.name
                    );
                    anyhow::ensure!(
                        target
                            .token_env
                            .as_deref()
                            .is_some_and(valid_env_name),
                        "[ipfs] Pinata target {:?} must set token_env to an UPPER_SNAKE_CASE environment variable name (normally IPFS_PIN_API_KEY)",
                        target.name
                    );
                }
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod validate_tests {
    use super::{
        resolve_env_reference, CapabilityProfile, Config, LogFormat, ReleaseProgramIdentity,
        OPERATOR_CYCLE_LIMIT,
    };
    use alloy_primitives::{Address, B256};
    use operator_core::types::Program;
    use std::collections::BTreeSet;
    use std::path::PathBuf;

    fn parse(toml_src: &str) -> Result<Config, String> {
        let cfg: Config = toml::from_str(toml_src).map_err(|e| e.to_string())?;
        cfg.validate().map_err(|e| e.to_string())?;
        Ok(cfg)
    }

    const GOOD: &str = r#"
rpc      = "http://127.0.0.1:8545"
registry = "0x8D08973774F1Da59728e5a0f66453113A3E35A0F"
"#;

    #[test]
    fn a_minimal_config_is_accepted() {
        let cfg = parse(GOOD).unwrap();
        assert_eq!(cfg.prover.cycle_limit, OPERATOR_CYCLE_LIMIT);
        assert_eq!(cfg.prover.capability_profile, CapabilityProfile::default());
        assert_eq!(cfg.ops.log_format, LogFormat::Text);
        assert_eq!(cfg.budget.global_alert_percent, 80);
    }

    #[test]
    fn endpoint_environment_references_resolve_without_templating_secrets_into_toml() {
        assert_eq!(
            resolve_env_reference("https://rpc.invalid", "rpc").unwrap(),
            "https://rpc.invalid"
        );
        assert!(!resolve_env_reference("env:PATH", "rpc").unwrap().is_empty());
        let error = resolve_env_reference("env:not-valid", "rpc").unwrap_err().to_string();
        assert!(error.contains("UPPER_SNAKE_CASE"), "{error}");
    }

    #[test]
    fn log_format_is_explicit_and_rejects_typos() {
        let cfg = parse(&format!("{GOOD}\n[ops]\nlog_format = \"json\"\n")).unwrap();
        assert_eq!(cfg.ops.log_format, LogFormat::Json);

        let error = parse(&format!("{GOOD}\n[ops]\nlog_format = \"pretty\"\n")).unwrap_err();
        assert!(error.contains("unknown variant `pretty`"), "{error}");
    }

    #[test]
    fn finalized_release_manifest_supplies_chain_and_registry_without_rpc_secrets() {
        let directory = std::env::temp_dir()
            .join(format!("trustgraphs-operator-release-{}", std::process::id()));
        std::fs::create_dir_all(&directory).unwrap();
        let manifest_path = directory.join("sepolia.json");
        std::fs::write(
            &manifest_path,
            r#"{
              "version": 1,
              "status": "deployed",
              "stage": "production",
              "chain": "sepolia",
              "chainId": 11155111,
              "deploymentCommit": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
              "firstDeploymentBlock": 120,
              "contracts": {
                "instanceRegistry": {
                  "address": "0x1111111111111111111111111111111111111111",
                  "block": 123,
                  "txHash": "0x2222222222222222222222222222222222222222222222222222222222222222"
                },
                "provingVault": { "address": null, "block": null, "txHash": null }
              },
              "programs": {
                "trustGraph": {
                  "elfSha256": "0x3333333333333333333333333333333333333333333333333333333333333333",
                  "vkey": "0x4444444444444444444444444444444444444444444444444444444444444444"
                },
                "signer": {
                  "elfSha256": "0x6666666666666666666666666666666666666666666666666666666666666666",
                  "vkey": "0x7777777777777777777777777777777777777777777777777777777777777777"
                }
              },
              "instances": [{
                "instanceId": "0x5555555555555555555555555555555555555555555555555555555555555555"
              }]
            }"#,
        )
        .unwrap();
        let config_path: PathBuf = directory.join("operator.toml");
        std::fs::write(
            &config_path,
            "rpc = \"https://rpc.invalid\"\nrelease_manifest = \"sepolia.json\"\n\
             [curated]\nsingle_release_instance = true\n",
        )
        .unwrap();

        let cfg = Config::load(&config_path).unwrap();
        assert_eq!(cfg.chain_id, Some(11_155_111));
        assert_eq!(
            cfg.registry,
            "0x1111111111111111111111111111111111111111".parse::<Address>().unwrap()
        );
        assert_eq!(cfg.registry_from_block, 123);
        assert_eq!(cfg.rpc, "https://rpc.invalid");
        assert_eq!(cfg.curated.instances, vec![B256::from([0x55; 32])]);
        assert_eq!(
            cfg.release_program_identities()[&Program::Trustgraphs],
            ReleaseProgramIdentity { elf_sha256: "33".repeat(32), vkey: B256::from([0x44; 32]) }
        );
        assert_eq!(
            cfg.release_program_identities()[&Program::Signer],
            ReleaseProgramIdentity { elf_sha256: "66".repeat(32), vkey: B256::from([0x77; 32]) }
        );

        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn tracked_sepolia_profile_refuses_to_subsidize_until_one_instance_is_recorded() {
        let repository = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");
        let directory = std::env::temp_dir()
            .join(format!("trustgraphs-operator-sepolia-profile-{}", std::process::id()));
        std::fs::create_dir_all(&directory).unwrap();
        std::fs::copy(repository.join("deployments/sepolia.json"), directory.join("sepolia.json"))
            .unwrap();
        let profile = std::fs::read_to_string(repository.join("deployments/operator.sepolia.toml"))
            .unwrap()
            .replace("env:RPC_URL", "https://rpc.invalid")
            .replace("env:IPFS_PIN_API", "https://uploads.pinata.cloud/v3/files")
            .replace("env:IPFS_GATEWAY", "https://gateway.invalid/ipfs/")
            .replace("env:OPERATOR_ALERT_WEBHOOK", "https://alerts.invalid");
        let config_path = directory.join("operator.sepolia.toml");
        std::fs::write(&config_path, profile).unwrap();

        let error = Config::load(&config_path).unwrap_err().to_string();
        assert!(error.contains("exactly one tracked release instance, found 0"), "{error}");
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn cycle_and_partial_capability_profile_are_configurable_and_reach_policy() {
        let cfg = parse(&format!(
            "{GOOD}\n[prover]\ncycle_limit = 12000000000\n\
             [prover.capability_profile]\nmax_raw_records = 2400\nmax_unique_nodes = 4800\n"
        ))
        .unwrap();
        let policy = cfg.policy_for(
            B256::from([0x11; 32]),
            Program::Trustgraphs,
            BTreeSet::from([Program::Trustgraphs]),
        );
        assert_eq!(policy.cycle_limit, 12_000_000_000);
        assert_eq!(policy.capability_profile.max_raw_records, 2_400);
        assert_eq!(policy.capability_profile.max_unique_nodes, 4_800);
        assert_eq!(policy.capability_profile.max_live_edges, 1_800, "omitted key uses default");
    }

    #[test]
    fn zero_capacity_policy_is_rejected_at_config_load() {
        let cycle = parse(&format!("{GOOD}\n[prover]\ncycle_limit = 0\n")).unwrap_err();
        assert!(cycle.contains("prover.cycle_limit must be at least 1"), "{cycle}");

        let capability =
            parse(&format!("{GOOD}\n[prover.capability_profile]\nmax_raw_records = 0\n"))
                .unwrap_err();
        assert!(
            capability.contains("prover.capability_profile.max_raw_records must be at least 1"),
            "{capability}"
        );
    }

    #[test]
    fn signer_schedule_has_separate_finality_and_loss_caps() {
        let cfg = parse(GOOD).unwrap();
        let supported = BTreeSet::from([Program::Trustgraphs, Program::Signer]);
        let signer = cfg.policy_for(B256::from([0x51; 32]), Program::Signer, supported.clone());
        let scores = cfg.policy_for(B256::from([0x11; 32]), Program::Trustgraphs, supported);
        assert!(signer.curated);
        assert!(!signer.requires_vault);
        assert_eq!(signer.confirmations, 24);
        assert_eq!(signer.loss_budget.per_instance_cents_per_day, 500);
        assert_eq!(signer.loss_budget.global_cents_per_day, 5_000);
        assert_eq!(scores.confirmations, 12);
        assert_eq!(scores.loss_budget.per_instance_cents_per_day, 2_500);
        assert_eq!(scores.loss_budget.global_cents_per_day, 25_000);
    }

    #[test]
    fn the_global_budget_warning_threshold_is_configurable_but_precedes_the_halt() {
        let cfg = parse(&format!("{GOOD}\n[budget]\nglobal_alert_percent = 75\n")).unwrap();
        assert_eq!(cfg.budget.global_alert_percent, 75);
        let error = parse(&format!("{GOOD}\n[budget]\nglobal_alert_percent = 100\n")).unwrap_err();
        assert!(error.contains("between 1 and 99"), "{error}");
    }

    #[test]
    fn a_zero_submit_failure_threshold_is_rejected() {
        let err = parse(&format!("{GOOD}\n[ops]\nsubmit_failure_threshold = 0\n")).unwrap_err();
        assert!(err.contains("must be at least 1"), "{err}");
    }

    #[test]
    fn a_zero_helper_timeout_is_rejected() {
        let err = parse(&format!("{GOOD}\n[ops]\ntool_timeout_seconds = 0\n")).unwrap_err();
        assert!(err.contains("tool_timeout_seconds must be at least 1"), "{err}");
    }

    #[test]
    fn an_empty_rpc_is_rejected_at_load_with_the_reason() {
        // The exact shape a shell heredoc produces when its $RPC was unset. Left to run, this
        // died on the first `eth_chainId` with "relative URL without a base".
        let err = parse(&GOOD.replace("http://127.0.0.1:8545", "")).unwrap_err();
        assert!(err.contains("`rpc` is empty"), "{err}");
        assert!(err.contains("heredoc"), "the message must say where this comes from: {err}");
    }

    #[test]
    fn a_scheme_less_rpc_is_rejected() {
        let err = parse(&GOOD.replace("http://127.0.0.1:8545", "127.0.0.1:8545")).unwrap_err();
        assert!(err.contains("absolute http(s) URL"), "{err}");
    }

    #[test]
    fn a_zero_registry_is_rejected() {
        let err = parse(&GOOD.replace(
            "0x8D08973774F1Da59728e5a0f66453113A3E35A0F",
            "0x0000000000000000000000000000000000000000",
        ))
        .unwrap_err();
        assert!(err.contains("zero address"), "{err}");
    }

    #[test]
    fn paid_with_a_zero_recipient_is_rejected_not_silently_unpaid() {
        // `Some(ZERO)` used to pass: `is_some()` was true, and the bounty was then committed to
        // the zero address — a proof paid for and a fee that could never be claimed.
        let src = format!(
            "{GOOD}\n[paid]\nenabled = true\nvault = \"0x8D08973774F1Da59728e5a0f66453113A3E35A0F\"\n\
             recipient = \"0x0000000000000000000000000000000000000000\"\n"
        );
        let err = parse(&src).unwrap_err();
        assert!(err.contains("recipient"), "{err}");
    }

    #[test]
    fn paid_with_a_zero_vault_is_rejected() {
        let src = format!(
            "{GOOD}\n[paid]\nenabled = true\nvault = \"0x0000000000000000000000000000000000000000\"\n\
             recipient = \"0x8D08973774F1Da59728e5a0f66453113A3E35A0F\"\n"
        );
        let err = parse(&src).unwrap_err();
        assert!(err.contains("vault"), "{err}");
    }

    #[test]
    fn multiple_publication_targets_and_a_minimum_are_accepted() {
        let src = format!(
            "{GOOD}\n[ipfs]\nmin_success = 2\nretry_seconds = 60\n\
             [[ipfs.targets]]\nname = \"primary\"\napi = \"http://one:5001\"\ngateway = \"http://one:8080/ipfs/\"\n\
             [[ipfs.targets]]\nname = \"backup\"\napi = \"https://two.example\"\ngateway = \"https://two.example/ipfs/\"\n"
        );
        let cfg = parse(&src).unwrap();
        assert_eq!(cfg.ipfs.resolved_targets().len(), 2);
        assert_eq!(cfg.ipfs.required_successes(), 2);
    }

    #[test]
    fn a_typed_pinata_target_names_but_never_contains_its_secret() {
        let src = format!(
            "{GOOD}\n[ipfs]\nmin_success = 1\n\
             [[ipfs.targets]]\nname = \"pinata\"\nkind = \"pinata\"\n\
             api = \"https://uploads.pinata.cloud/v3/files\"\n\
             gateway = \"https://gateway.pinata.cloud/ipfs/\"\n\
             token_env = \"IPFS_PIN_API_KEY\"\n"
        );
        let cfg = parse(&src).unwrap();
        let policy = format!("{:#x}", cfg.ipfs.policy_hash());
        assert_eq!(cfg.ipfs.resolved_targets()[0].token_env.as_deref(), Some("IPFS_PIN_API_KEY"));
        assert!(!policy.contains("secret"));
    }

    #[test]
    fn pinata_requires_https_and_a_named_bearer_token_variable() {
        let missing = format!(
            "{GOOD}\n[ipfs]\n[[ipfs.targets]]\nname = \"pinata\"\nkind = \"pinata\"\n\
             api = \"https://uploads.pinata.cloud/v3/files\"\n\
             gateway = \"https://gateway.pinata.cloud/ipfs/\"\n"
        );
        let error = parse(&missing).unwrap_err();
        assert!(error.contains("token_env"), "{error}");

        let plaintext = missing
            .replace("https://uploads.pinata.cloud", "http://uploads.pinata.cloud")
            + "token_env = \"IPFS_PIN_API_KEY\"\n";
        let error = parse(&plaintext).unwrap_err();
        assert!(error.contains("must use HTTPS"), "{error}");

        let invalid_name = missing + "token_env = \"not-valid\"\n";
        let error = parse(&invalid_name).unwrap_err();
        assert!(error.contains("UPPER_SNAKE_CASE"), "{error}");
    }

    #[test]
    fn publication_gateways_must_have_the_raw_cid_suffix() {
        let src = format!(
            "{GOOD}\n[ipfs]\n[[ipfs.targets]]\nname = \"bad-reader\"\n\
             api = \"http://one:5001\"\ngateway = \"http://one:8080\"\n"
        );
        let error = parse(&src).unwrap_err();
        assert!(error.contains("end in /ipfs/"), "{error}");
    }

    #[test]
    fn retired_flat_ipfs_fields_are_rejected_instead_of_disabling_publication() {
        let src = format!(
            "{GOOD}\n[ipfs]\napi = \"http://127.0.0.1:5001\"\n\
             gateway = \"http://127.0.0.1:8080/ipfs/\"\n"
        );
        let err = parse(&src).unwrap_err();
        assert!(err.contains("unknown field `api`"), "{err}");
    }

    #[test]
    fn demo_config_generator_uses_a_required_publication_target() {
        let demo_task = include_str!("../../../taskfile/demo.yml");
        assert!(demo_task.contains("[[ipfs.targets]]"));
        assert!(demo_task.contains("min_success = 1"));
        assert!(!demo_task.contains("[ipfs]\n        api"));
    }

    #[test]
    fn publication_minimum_cannot_exceed_the_target_count() {
        let src = format!(
            "{GOOD}\n[ipfs]\nmin_success = 2\n\
             [[ipfs.targets]]\nname = \"only\"\napi = \"http://one:5001\"\ngateway = \"http://one:8080/ipfs/\"\n"
        );
        let err = parse(&src).unwrap_err();
        assert!(err.contains("between 1 and the 1 configured targets"), "{err}");
    }

    #[test]
    fn duplicate_publication_apis_are_not_counted_as_independent() {
        let src = format!(
            "{GOOD}\n[ipfs]\n\
             [[ipfs.targets]]\nname = \"one\"\napi = \"http://same:5001\"\ngateway = \"http://same:8080/ipfs/\"\n\
             [[ipfs.targets]]\nname = \"two\"\napi = \"http://same:5001\"\ngateway = \"http://other:8080/ipfs/\"\n"
        );
        let err = parse(&src).unwrap_err();
        assert!(err.contains("not independent durability"), "{err}");
    }
}

#[cfg(test)]
mod state_dir_tests {
    use super::Config;
    use std::path::{Path, PathBuf};

    const GOOD: &str = "rpc = \"http://127.0.0.1:8545\"\n\
                        registry = \"0x8D08973774F1Da59728e5a0f66453113A3E35A0F\"\n";

    /// Write a config into `dir` and load it the way `main` does.
    fn load_in(dir: &Path, body: &str) -> Result<Config, String> {
        let path = dir.join("operator.toml");
        std::fs::write(&path, body).unwrap();
        Config::load(&path).map_err(|e| format!("{e:#}"))
    }

    #[test]
    fn everything_the_daemon_owns_defaults_into_one_directory() {
        let home = tempfile::tempdir().unwrap();
        let cfg = load_in(home.path(), GOOD).unwrap();
        let state = home.path().join(".trustgraph/operator");
        assert_eq!(cfg.state_dir(), state);
        assert_eq!(cfg.journal_path(), state.join("journal.jsonl"));
        assert_eq!(cfg.status_path(), state.join("status.json"));
        assert_eq!(cfg.envelope0_cache_dir(), state.join("envelope0"));
        assert_eq!(cfg.weighted_cache_dir(), state.join("weighted-manifests"));
        assert_eq!(
            cfg.work_dir(alloy_primitives::B256::repeat_byte(0xab)),
            state.join(format!("{:#x}", alloy_primitives::B256::repeat_byte(0xab)))
        );
        assert!(state.is_dir(), "the state directory is created, not merely computed");
    }

    #[test]
    fn a_relative_path_follows_the_config_file_and_not_the_working_directory() {
        // The bug this closes: `--manifest-path zk/prover/Cargo.toml` and `./.trustgraph/...`
        // together meant the daemon silently required being started from the repo root, which is
        // a footgun anywhere and a data-loss bug on an ephemeral filesystem.
        let home = tempfile::tempdir().unwrap();
        let cfg = load_in(
            home.path(),
            &format!(
                "{GOOD}[ops]\nstate_dir = \"state\"\njournal_path = \"ledger/journal.jsonl\"\n"
            ),
        )
        .unwrap();
        assert_eq!(cfg.state_dir(), home.path().join("state"));
        assert_eq!(cfg.journal_path(), home.path().join("ledger/journal.jsonl"));
        assert_ne!(cfg.journal_path(), PathBuf::from("ledger/journal.jsonl"));
        assert!(
            home.path().join("ledger").is_dir(),
            "a journal outside the state directory still gets a directory that exists"
        );
    }

    #[test]
    fn the_config_directory_itself_is_a_usable_state_directory() {
        // `state_dir = "."` is the natural way to say "everything beside this file", and it is
        // what the local demo uses. It must not come out as `<dir>/.`.
        let home = tempfile::tempdir().unwrap();
        let cfg = load_in(home.path(), &format!("{GOOD}[ops]\nstate_dir = \".\"\n")).unwrap();
        assert_eq!(cfg.state_dir(), home.path());
        assert_eq!(cfg.journal_path(), home.path().join("journal.jsonl"));
    }

    #[test]
    fn an_absolute_path_is_left_exactly_as_written() {
        let home = tempfile::tempdir().unwrap();
        let elsewhere = tempfile::tempdir().unwrap();
        let cfg = load_in(
            home.path(),
            &format!("{GOOD}[ops]\nstate_dir = \"{}\"\n", elsewhere.path().display()),
        )
        .unwrap();
        assert_eq!(cfg.state_dir(), elsewhere.path());
    }

    #[test]
    fn a_named_state_directory_whose_volume_is_not_mounted_refuses_to_start() {
        // The failure this exists for: `/data` is a volume that did not mount, the daemon
        // cheerfully creates it on the container's own filesystem, and the request journal is
        // gone at the next deploy — after which it re-requests proofs it already paid for.
        let home = tempfile::tempdir().unwrap();
        let unmounted = home.path().join("not-mounted/trustgraph");
        let error = load_in(
            home.path(),
            &format!("{GOOD}[ops]\nstate_dir = \"{}\"\n", unmounted.display()),
        )
        .unwrap_err();
        assert!(error.contains("unmounted volume"), "{error}");
        assert!(!unmounted.exists(), "refusing must not create the directory it refused");
    }

    #[test]
    fn a_state_directory_that_is_a_file_is_rejected() {
        let home = tempfile::tempdir().unwrap();
        let occupied = home.path().join("occupied");
        std::fs::write(&occupied, b"not a directory").unwrap();
        let error =
            load_in(home.path(), &format!("{GOOD}[ops]\nstate_dir = \"{}\"\n", occupied.display()))
                .unwrap_err();
        assert!(error.contains("state_dir"), "{error}");
    }

    #[test]
    #[cfg(unix)]
    fn a_read_only_state_directory_is_refused_before_the_first_tick() {
        use std::os::unix::fs::PermissionsExt;
        let home = tempfile::tempdir().unwrap();
        let locked = home.path().join("locked");
        std::fs::create_dir(&locked).unwrap();
        std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o555)).unwrap();
        let error =
            load_in(home.path(), &format!("{GOOD}[ops]\nstate_dir = \"{}\"\n", locked.display()))
                .unwrap_err();
        // Restore before the assert so a failure still cleans up.
        std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o755)).unwrap();
        assert!(error.contains("not writable"), "{error}");
    }

    #[test]
    fn manifest_pointers_and_the_tool_directory_follow_the_config_file_too() {
        let home = tempfile::tempdir().unwrap();
        std::fs::write(home.path().join("params.json"), "{}").unwrap();
        let cfg = load_in(
            home.path(),
            &format!(
                "{GOOD}[ops]\ntool_dir = \"bin\"\n\
                 [[manifest]]\nprogram = \"trust-graph\"\n\
                 snapshot = \"0x8D08973774F1Da59728e5a0f66453113A3E35A0F\"\n\
                 eas = \"0x8D08973774F1Da59728e5a0f66453113A3E35A0F\"\n\
                 params = \"params.json\"\n"
            ),
        )
        .unwrap();
        assert_eq!(cfg.manifest[0].params, home.path().join("params.json").display().to_string());
        assert_eq!(
            cfg.ops.tool_dir.as_deref(),
            Some(home.path().join("bin").display().to_string().as_str())
        );
    }

    #[test]
    fn the_local_demo_keeps_its_whole_state_beside_its_config_and_serves_a_heartbeat() {
        // The demo is the only place the URL mode the frontend already supports actually gets
        // run, and `state_dir = "."` is what stops the demo writing a request journal into the
        // repository root where two runs — or a demo and an e2e — would share it.
        let demo = include_str!("../../../taskfile/demo.yml");
        assert!(demo.contains("state_dir  = \".\""), "the demo no longer names a state directory");
        assert!(demo.contains("listen     = \"127.0.0.1:{{.OPERATOR_PORT}}\""), "{demo}");
        assert!(
            !demo.contains("journal_path = \"{{.WORK}}"),
            "journal_path is now implied by state_dir; two ways to say it is one too many"
        );
    }

    #[test]
    fn a_config_that_names_nothing_still_creates_its_own_state_directory() {
        // The developer loop: a fresh checkout has no `.trustgraph` at all, and refusing to start
        // over a directory nobody asked about would be hostile.
        let home = tempfile::tempdir().unwrap();
        let nested = home.path().join("deep/nested/dir");
        std::fs::create_dir_all(&nested).unwrap();
        let cfg = load_in(&nested, GOOD).unwrap();
        assert!(cfg.state_dir().is_dir());
    }
}
