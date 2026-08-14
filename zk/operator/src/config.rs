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
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;
use std::path::Path;

#[derive(Debug, Deserialize)]
pub struct Config {
    pub rpc: String,
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
pub struct Ipfs {
    /// Legacy single-target kubo RPC API. Kept so existing self-hosted configs continue to load;
    /// production should use `targets` with `min_success >= 2`.
    #[serde(default)]
    pub api: Option<String>,
    /// Legacy reader gateway paired with `api`. Both or neither must be present: accepting bytes
    /// without reading them back is no longer enough to satisfy a publication policy.
    #[serde(default)]
    pub gateway: Option<String>,
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
    #[serde(default = "d_log_format")]
    pub log_format: String,
    /// Consecutive deterministic submit reverts before one immutable checkpoint is terminally
    /// abandoned. Transient/provider/fee/reorg failures do not consume attempts.
    #[serde(default = "d_submit_failure_threshold")]
    pub submit_failure_threshold: u32,
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
fn d_journal_path() -> String {
    "./.trustgraph/operator/journal.jsonl".into()
}
fn d_status_path() -> String {
    "./.trustgraph/operator/status.json".into()
}
fn d_log_format() -> String {
    "json".into()
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
        Self { backend: d_backend(), groth16: true, timeout_s: d_timeout() }
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
            api: None,
            gateway: None,
            targets: Vec::new(),
            min_success: None,
            retry_seconds: d_publication_retry(),
        }
    }
}
impl Default for Ops {
    fn default() -> Self {
        Self {
            journal_path: d_journal_path(),
            status_path: d_status_path(),
            alert_webhook: None,
            log_format: d_log_format(),
            submit_failure_threshold: d_submit_failure_threshold(),
        }
    }
}

impl Config {
    pub fn load(path: &Path) -> Result<Self> {
        let text = std::fs::read_to_string(path)
            .with_context(|| format!("read operator config {}", path.display()))?;
        let cfg: Config = toml::from_str(&text)
            .with_context(|| format!("parse operator config {}", path.display()))?;
        cfg.validate()?;
        Ok(cfg)
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
        anyhow::ensure!(
            self.signer_sync.budget_window_seconds > 0,
            "signer_sync.budget_window_seconds must be at least 1"
        );
        self.ipfs.validate()?;
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

impl Ipfs {
    pub fn resolved_targets(&self) -> Vec<PinTarget> {
        if let (Some(api), Some(gateway)) = (&self.api, &self.gateway) {
            vec![PinTarget {
                name: "legacy".to_string(),
                api: api.clone(),
                gateway: gateway.clone(),
            }]
        } else {
            self.targets.clone()
        }
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
        let legacy_any = self.api.is_some() || self.gateway.is_some();
        anyhow::ensure!(
            !legacy_any || self.targets.is_empty(),
            "[ipfs] legacy `api`/`gateway` cannot be mixed with [[ipfs.targets]]"
        );
        anyhow::ensure!(
            self.api.is_some() == self.gateway.is_some(),
            "[ipfs] legacy `api` and `gateway` must be configured together so every pin is read back"
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
    use super::Config;
    use alloy_primitives::B256;
    use operator_core::types::Program;
    use std::collections::BTreeSet;

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
        assert!(parse(GOOD).is_ok());
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

    #[test]
    fn legacy_ipfs_requires_api_and_gateway_together() {
        let err = parse(&format!("{GOOD}\n[ipfs]\napi = \"http://one:5001\"\n")).unwrap_err();
        assert!(err.contains("configured together"), "{err}");
    }
}
