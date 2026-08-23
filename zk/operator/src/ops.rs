//! Logs, heartbeat, alerts. The parts an on-call human reads at 3am.

use anyhow::Result;
use operator_core::policy::BudgetBreach;
use operator_core::types::{Action, HoldReason, IdleReason, SkipReason};
use serde::Serialize;
use serde_json::json;
use std::collections::BTreeMap;
use std::path::Path;

/// Structured JSON to stdout, one object per line. `log_format = "text"` gets a human line
/// instead; nothing else is supported, because a third format is a third thing to keep correct.
pub struct Logger {
    pub json: bool,
}

impl Logger {
    pub fn event(&self, event: &str, fields: serde_json::Value) {
        if self.json {
            let mut obj = json!({ "event": event });
            if let (Some(o), Some(f)) = (obj.as_object_mut(), fields.as_object()) {
                for (k, v) in f {
                    o.insert(k.clone(), v.clone());
                }
            }
            println!("{obj}");
        } else {
            println!("{event}  {fields}");
        }
    }

    pub fn action(&self, instance: &str, name: &str, program: &str, action: &Action) {
        self.event(
            "decision",
            json!({
                "instance": instance,
                "name": name,
                "program": program,
                "action": serde_json::to_value(action).unwrap_or(json!(null)),
            }),
        );
    }
}

/// What the log has already said, so it is not said again every tick.
///
/// The log narrates changes; the heartbeat file carries steady state. Without this, a healthy
/// daemon prints the same skip and idle lines every tick and the one line that matters scrolls
/// away. Per-run on purpose: a restart re-announces everything once, which is what a fresh
/// reader wants.
#[derive(Default)]
pub struct Narration {
    said: BTreeMap<String, String>,
}

impl Narration {
    /// True when `value` differs from what was last said on this channel — and records it.
    pub fn changed(&mut self, key: &str, value: &str) -> bool {
        if self.said.get(key).map(String::as_str) == Some(value) {
            return false;
        }
        self.said.insert(key.to_string(), value.to_string());
        true
    }

    /// Forget a channel. True when there was something to forget, so the caller can log the
    /// recovery; a relapse afterwards is a change again and re-logs.
    pub fn clear(&mut self, key: &str) -> bool {
        self.said.remove(key).is_some()
    }
}

/// An action's identity for change-logging: the state the daemon is in, not the numbers inside
/// it. `AwaitFinality`'s rising confirmation count, a wiggling basefee, or a rolling spend must
/// not re-announce the same state every tick — but a new checkpoint id or a different hold is a
/// genuine transition.
pub fn action_key(action: &Action) -> String {
    match action {
        Action::Idle(IdleReason::Quiet) => "idle/quiet".into(),
        Action::Idle(IdleReason::EpochNotElapsed { boundary, .. }) => {
            format!("idle/epoch_not_elapsed/{boundary}")
        }
        Action::Idle(IdleReason::SubsidyCadence { boundary, .. }) => {
            format!("idle/subsidy_cadence/{boundary}")
        }
        Action::Idle(IdleReason::Proving { checkpoint_id }) => {
            format!("idle/proving/{checkpoint_id}")
        }
        Action::Idle(IdleReason::Superseded { checkpoint_id }) => {
            format!("idle/superseded/{checkpoint_id}")
        }
        Action::Idle(IdleReason::PublicationBackoff { checkpoint_id, .. }) => {
            format!("idle/publication_backoff/{checkpoint_id}")
        }
        Action::Idle(IdleReason::AwaitingNewInputs { checkpoint_id }) => {
            format!("idle/awaiting_new_inputs/{checkpoint_id}")
        }
        Action::Trigger => "trigger".into(),
        Action::AwaitFinality { checkpoint_id, .. } => format!("await_finality/{checkpoint_id}"),
        Action::Prove { checkpoint_id } => format!("prove/{checkpoint_id}"),
        Action::Publish { checkpoint_id } => format!("publish/{checkpoint_id}"),
        Action::Submit { checkpoint_id } => format!("submit/{checkpoint_id}"),
        Action::Hold(HoldReason::Paused) => "hold/paused".into(),
        Action::Hold(HoldReason::Basefee { .. }) => "hold/basefee".into(),
        Action::Hold(HoldReason::VerifierRotated { on_chain, expected }) => {
            format!("hold/verifier_rotated/{on_chain:#x}/{expected:#x}")
        }
        Action::Hold(HoldReason::RotationPending) => "hold/rotation_pending".into(),
        Action::Hold(HoldReason::LossBudget(BudgetBreach::Instance { .. })) => {
            "hold/loss_budget/instance".into()
        }
        Action::Hold(HoldReason::LossBudget(BudgetBreach::Global { .. })) => {
            "hold/loss_budget/global".into()
        }
        Action::Hold(HoldReason::RequestOutcomeUnknown { checkpoint_id }) => {
            format!("hold/request_outcome_unknown/{checkpoint_id}")
        }
        Action::Hold(HoldReason::Unfunded { reason }) => format!("hold/unfunded/{reason}"),
        Action::Hold(HoldReason::InputUnavailable { stage, checkpoint_id }) => {
            format!("hold/input_unavailable/{stage:?}/{checkpoint_id:?}")
        }
        Action::Skip(SkipReason::UnsupportedProgram(p)) => {
            format!("skip/unsupported_program/{}", p.name())
        }
        Action::Skip(SkipReason::CapabilityExceeded { dimension, .. }) => {
            format!("skip/capability/{dimension:?}")
        }
        Action::Skip(SkipReason::TooLarge { .. }) => "skip/too_large".into(),
        Action::Skip(SkipReason::ParamsMismatch { on_chain, reconstructed }) => {
            format!("skip/params_mismatch/{on_chain:#x}/{reconstructed:#x}")
        }
        Action::Skip(SkipReason::UnpinnedCheckpoint { checkpoint_id }) => {
            format!("skip/unpinned_checkpoint/{checkpoint_id}")
        }
        Action::Skip(SkipReason::Undescribable) => "skip/undescribable".into(),
    }
}

/// The heartbeat file. Written every tick, so "is it alive and what is it doing?" is one `cat`.
#[derive(Serialize)]
pub struct Status {
    pub chain_id: u64,
    pub head_block: u64,
    /// Unix seconds, supplied by the caller.
    pub tick_at: u64,
    pub instances: Vec<InstanceStatus>,
    /// Deliberately public, non-secret operating policy. The frontend may publish this verbatim;
    /// RPC/IPFS URLs, keys, webhook URLs and local paths never enter the shape.
    pub settings: PublicSettings,
    /// Work sitting in the ambiguous window, waiting on a human. Never auto-retried.
    pub unresolved: Vec<String>,
    pub alerts: Vec<String>,
}

/// The allowlisted part of the daemon configuration that a community can safely audit.
///
/// This is embedded in the heartbeat instead of teaching a web process to parse `operator.toml`.
/// The latter contains RPC and webhook endpoints and is therefore the wrong security boundary,
/// even if today's UI promises to ignore them.
#[derive(Serialize)]
pub struct PublicSettings {
    pub capability_profile: operator_core::CapabilityProfile,
    pub cost_model_version: u16,
    pub cycle_limit: u64,
    pub protocol_max_total_inputs: u64,
    pub paid_enabled: bool,
    pub paid_vault: Option<String>,
    pub paid_recipient: Option<String>,
    pub tick_seconds: u64,
    pub subsidy_min_blocks: u64,
    pub max_concurrent: usize,
    pub max_per_instance: usize,
    pub max_basefee_gwei: u64,
    pub replacement_after_s: u64,
    pub simulate_before_send: bool,
    pub confirmations: u64,
    pub track_block_hash: bool,
    pub prover_backend: String,
    pub groth16: bool,
    pub proof_timeout_s: u64,
    pub per_instance_usd_per_day: u64,
    pub global_usd_per_day: u64,
    pub budget_window_seconds: u64,
    pub publishes_scores: bool,
    pub verifies_score_readback: bool,
    pub publication_target_count: usize,
    pub publication_min_success: usize,
    pub publication_retry_seconds: u64,
    pub weighted_manifest_mirror_count: usize,
    pub weighted_manifest_cache_max_versions: usize,
    pub weighted_manifest_cache_max_bytes: u64,
    pub weighted_manifest_retry_seconds: u64,
    pub submit_failure_threshold: u32,
    pub signer_sync_enabled: bool,
    pub signer_confirmations: u64,
    pub signer_track_block_hash: bool,
    pub signer_per_instance_usd_per_day: u64,
    pub signer_global_usd_per_day: u64,
    pub signer_budget_window_seconds: u64,
}

#[derive(Serialize)]
pub struct InstanceStatus {
    pub instance_id: String,
    pub name: String,
    pub program: String,
    pub snapshot: String,
    pub curated: bool,
    pub action: Action,
    /// Blocks since the last applied root, or `null` if none has ever landed. The number a
    /// staleness alert watches.
    pub blocks_since_root: Option<u64>,
    pub newest_anchor_count: u64,
    pub input_work: u64,
    pub input_capacity: u64,
    /// The configured gate nearest exhaustion for this instance. This publishes which of the
    /// profile, cycle, or instance ingress ceilings actually binds instead of only paging at 80%.
    pub limiting_capacity: operator_core::CapacityUsage,
    pub envelope0_fetch_latency_ms: Option<u64>,
    pub envelope0_exact_readers: Option<usize>,
    pub envelope0_validation_failed: bool,
    /// Age of an instance specifically held because committed input bytes are unavailable.
    pub unprovable_age_blocks: Option<u64>,
}

pub fn write_status(path: &Path, status: &Status) -> Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(path, serde_json::to_string_pretty(status)?)?;
    Ok(())
}

/// Fire-and-forget alert. A webhook that is down must not take the operator with it, so the error
/// is logged and swallowed — the alert already failed; failing the tick as well would turn a
/// notification outage into a proving outage.
pub fn alert(logger: &Logger, webhook: Option<&str>, text: &str) {
    logger.event("alert", json!({ "text": text }));
    let Some(url) = webhook else { return };
    let client = reqwest::blocking::Client::new();
    if let Err(e) = client
        .post(url)
        .json(&json!({ "text": text }))
        .timeout(std::time::Duration::from_secs(10))
        .send()
    {
        logger.event("alert_delivery_failed", json!({ "error": e.to_string() }));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn narration_says_each_thing_once_until_it_changes() {
        let mut n = Narration::default();
        assert!(n.changed("skip/0xabc", "read failed"));
        assert!(!n.changed("skip/0xabc", "read failed"), "steady state repeats silently");
        assert!(n.changed("skip/0xabc", "params mismatch"), "a different reason is news");
        assert!(n.clear("skip/0xabc"), "clearing a said thing reports the recovery");
        assert!(!n.clear("skip/0xabc"), "clearing silence is not a recovery");
        assert!(n.changed("skip/0xabc", "params mismatch"), "a relapse after recovery is news");
    }

    /// The wiggly numbers inside a state must not make every tick look like a transition.
    #[test]
    fn action_key_ignores_progress_but_not_identity() {
        let a = Action::AwaitFinality { checkpoint_id: 7, confirmations: 1, required: 5 };
        let b = Action::AwaitFinality { checkpoint_id: 7, confirmations: 2, required: 5 };
        assert_eq!(action_key(&a), action_key(&b), "confirmations rising is not a new state");
        let c = Action::AwaitFinality { checkpoint_id: 8, confirmations: 0, required: 5 };
        assert_ne!(action_key(&a), action_key(&c), "a new checkpoint is");

        let x = Action::Hold(HoldReason::Basefee { basefee_wei: 10, cap_wei: 5 });
        let y = Action::Hold(HoldReason::Basefee { basefee_wei: 11, cap_wei: 5 });
        assert_eq!(action_key(&x), action_key(&y), "a wiggling basefee is one hold");
        assert_ne!(action_key(&x), action_key(&Action::Idle(IdleReason::Quiet)));

        let g = Action::Hold(HoldReason::LossBudget(BudgetBreach::Global {
            spent_cents: 100,
            cap_cents: 50,
        }));
        let g2 = Action::Hold(HoldReason::LossBudget(BudgetBreach::Global {
            spent_cents: 120,
            cap_cents: 50,
        }));
        let i = Action::Hold(HoldReason::LossBudget(BudgetBreach::Instance {
            spent_cents: 100,
            cap_cents: 50,
        }));
        assert_eq!(action_key(&g), action_key(&g2), "a rolling spend is one breach");
        assert_ne!(action_key(&g), action_key(&i), "which budget broke matters");
    }
}
