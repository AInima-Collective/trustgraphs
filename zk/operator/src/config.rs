//! The operator's configuration file, exactly as `docs/OPERATOR.md` §2 documents it.
//!
//! Every key has a default except `rpc` and `registry`. That is deliberate: a missing key should
//! be a recorded decision, not a stall (GOAL ground rule 12). What is NOT configurable is also
//! deliberate — anything absent from here, the operator does not do.

use alloy_primitives::{Address, B256};
use anyhow::{Context, Result};
use operator_core::manifest::{Manifest, ManifestEntry};
use operator_core::policy::{LossBudget, Policy};
use operator_core::types::Program;
use serde::Deserialize;
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
    #[serde(default)]
    pub ops: Ops,
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
fn d_journal_path() -> String {
    "./.trustgraph/operator/journal.jsonl".into()
}
fn d_status_path() -> String {
    "./.trustgraph/operator/status.json".into()
}
fn d_log_format() -> String {
    "json".into()
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
        Self { per_instance_usd_per_day: d_per_instance_usd(), global_usd_per_day: d_global_usd() }
    }
}
impl Default for Ops {
    fn default() -> Self {
        Self {
            journal_path: d_journal_path(),
            status_path: d_status_path(),
            alert_webhook: None,
            log_format: d_log_format(),
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
        if self.paid.enabled {
            anyhow::ensure!(
                self.paid.vault.is_some(),
                "[paid] enabled but no `vault` address: there is nothing to claim from"
            );
            anyhow::ensure!(
                self.paid.recipient.is_some(),
                "[paid] enabled but no `recipient`: the bounty would be committed to the zero \
                 address, which means 'no bounty' — set it or turn [paid] off"
            );
        }
        anyhow::ensure!(
            self.cadence.max_per_instance == 1,
            "cadence.max_per_instance must be 1: more than one in-flight proof per instance makes \
             the request journal an incomplete record of money at risk"
        );
        Ok(())
    }

    pub fn manifest_struct(&self) -> Manifest {
        Manifest { entries: self.manifest.clone() }
    }

    /// The policy for one instance. Curation is the only thing that differs per instance.
    pub fn policy_for(&self, instance_id: B256, supported: BTreeSet<Program>) -> Policy {
        let curated = self.curated.instances.contains(&instance_id);
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
            confirmations: self.finality.confirmations,
            supported_programs: supported,
            loss_budget: LossBudget {
                per_instance_cents_per_day: self.budget.per_instance_usd_per_day * 100,
                global_cents_per_day: self.budget.global_usd_per_day * 100,
            },
            ..Policy::default()
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
