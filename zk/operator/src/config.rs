//! The operator's configuration file, exactly as `docs/build/run-a-prover.md` §2 documents it.
//!
//! Every key has a default except `rpc` and `registry`. That is deliberate: a missing key should
//! be a recorded decision, not a stall (GOAL ground rule 12). What is NOT configurable is also
//! deliberate — anything absent from here, the operator does not do.

use alloy_primitives::{keccak256, Address, B256};
use anyhow::{Context, Result};
use operator_core::manifest::{Manifest, ManifestEntry};
use operator_core::policy::{LossBudget, Policy};
use operator_core::types::Program;
use operator_core::work::{CapabilityProfile, OPERATOR_CYCLE_LIMIT};
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

#[derive(Debug, Deserialize)]
pub struct Config {
    pub rpc: String,
    /// Optional sanitized public release manifest. RPC credentials remain in this TOML; chain
    /// identity and deployed contract coordinates come from the tracked JSON release record.
    #[serde(default)]
    pub release_manifest: Option<PathBuf>,
    #[serde(default)]
    pub registry: Address,
    /// Checked against `eth_chainId` at startup, never trusted over it.
    #[serde(default)]
    pub chain_id: Option<u64>,

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
/// page over an unpublished root renders empty. Unset means "we are not publishing", which is
/// legitimate only if something else does.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Ipfs {
    /// Independent kubo/pinning targets. Every target is verified through its reader gateway.
    #[serde(default)]
    pub targets: Vec<PinTarget>,
    /// How many independent targets must accept and serve the exact CID before a proof may submit.
    /// Defaults to all configured targets. Zero is valid only when no publication target exists.
    #[serde(default)]
    pub min_success: Option<usize>,
    /// Persistent retry cadence after a failed publication policy, in seconds.
    #[serde(default = "d_publication_retry")]
    pub retry_seconds: u64,
    /// Digest-verified strict Envelope0 recovery cache. These are prover inputs, not publication
    /// outputs, but they reuse the configured target gateways as independent readers.
    #[serde(default = "d_envelope0_cache_dir")]
    pub envelope0_cache_dir: String,
    /// Bounded parallelism across newest node bundles.
    #[serde(default = "d_envelope0_fetch_concurrency")]
    pub envelope0_fetch_concurrency: usize,
}

#[derive(Debug, Deserialize)]
pub struct WeightedManifests {
    /// Durable local cache. Active and pending versions are protected from eviction by callers.
    #[serde(default = "d_weighted_cache_dir")]
    pub cache_dir: String,
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

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct PinTarget {
    pub name: String,
    pub api: String,
    pub gateway: String,
}

/// The free tier, and the whole of it. There is no unconditional one: a permissionless factory
/// plus an unconditional free tier is unbounded liability.
#[derive(Debug, Default, Deserialize)]
pub struct Curated {
    #[serde(default)]
    pub instances: Vec<B256>,
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
    #[serde(default = "d_journal_path")]
    pub journal_path: String,
    #[serde(default = "d_status_path")]
    pub status_path: String,
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
fn d_publication_retry() -> u64 {
    300
}
fn d_envelope0_cache_dir() -> String {
    "./.trustgraph/operator/envelope0".into()
}
fn d_envelope0_fetch_concurrency() -> usize {
    8
}
fn d_weighted_cache_dir() -> String {
    "./.trustgraph/operator/weighted-manifests".into()
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
fn d_journal_path() -> String {
    "./.trustgraph/operator/journal.jsonl".into()
}
fn d_status_path() -> String {
    "./.trustgraph/operator/status.json".into()
}
fn d_submit_failure_threshold() -> u32 {
    3
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
            envelope0_cache_dir: d_envelope0_cache_dir(),
            envelope0_fetch_concurrency: d_envelope0_fetch_concurrency(),
        }
    }
}
impl Default for WeightedManifests {
    fn default() -> Self {
        Self {
            cache_dir: d_weighted_cache_dir(),
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
            journal_path: d_journal_path(),
            status_path: d_status_path(),
            alert_webhook: None,
            log_format: LogFormat::default(),
            submit_failure_threshold: d_submit_failure_threshold(),
        }
    }
}

impl Config {
    pub fn load(path: &Path) -> Result<Self> {
        let text = std::fs::read_to_string(path)
            .with_context(|| format!("read operator config {}", path.display()))?;
        let mut cfg: Config = toml::from_str(&text)
            .with_context(|| format!("parse operator config {}", path.display()))?;
        if let Some(manifest_path) = cfg.release_manifest.clone() {
            let manifest_path = if manifest_path.is_absolute() {
                manifest_path
            } else {
                path.parent().unwrap_or_else(|| Path::new(".")).join(manifest_path)
            };
            cfg.apply_release_manifest(&manifest_path)?;
        }
        cfg.validate()?;
        Ok(cfg)
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
        anyhow::ensure!(
            is_hex(&manifest.programs.trust_graph.elf_sha256, 64, true),
            "release manifest trust-graph ELF digest is missing or invalid"
        );
        anyhow::ensure!(
            is_hex(&manifest.programs.trust_graph.vkey, 64, true),
            "release manifest trust-graph vkey is missing or invalid"
        );

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
        anyhow::ensure!(self.prover.cycle_limit > 0, "prover.cycle_limit must be at least 1");
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
}

#[derive(Debug, Deserialize)]
struct OperatorReleasePrograms {
    #[serde(rename = "trustGraph")]
    trust_graph: OperatorReleaseProgram,
}

#[derive(Debug, Deserialize)]
struct OperatorReleaseProgram {
    #[serde(rename = "elfSha256")]
    elf_sha256: String,
    vkey: String,
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

impl WeightedManifests {
    fn validate(&self) -> Result<()> {
        anyhow::ensure!(!self.cache_dir.trim().is_empty(), "weighted_manifests.cache_dir is empty");
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
        anyhow::ensure!(
            !self.envelope0_cache_dir.trim().is_empty(),
            "[ipfs] envelope0_cache_dir cannot be empty"
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
        }
        Ok(())
    }
}

#[cfg(test)]
mod validate_tests {
    use super::{CapabilityProfile, Config, LogFormat, OPERATOR_CYCLE_LIMIT};
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
                }
              }
            }"#,
        )
        .unwrap();
        let config_path: PathBuf = directory.join("operator.toml");
        std::fs::write(
            &config_path,
            "rpc = \"https://rpc.invalid\"\nrelease_manifest = \"sepolia.json\"\n",
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
    fn a_zero_submit_failure_threshold_is_rejected() {
        let err = parse(&format!("{GOOD}\n[ops]\nsubmit_failure_threshold = 0\n")).unwrap_err();
        assert!(err.contains("must be at least 1"), "{err}");
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
