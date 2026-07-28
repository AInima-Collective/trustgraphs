//! Logs, heartbeat, alerts. The parts an on-call human reads at 3am.

use anyhow::Result;
use operator_core::types::Action;
use serde::Serialize;
use serde_json::json;
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

    pub fn action(&self, instance: &str, action: &Action) {
        self.event(
            "decision",
            json!({ "instance": instance, "action": serde_json::to_value(action).unwrap_or(json!(null)) }),
        );
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
    /// Work sitting in the ambiguous window, waiting on a human. Never auto-retried.
    pub unresolved: Vec<String>,
    pub alerts: Vec<String>,
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
