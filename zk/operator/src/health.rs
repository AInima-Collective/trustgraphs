//! A read-only listener, so something other than a human with shell access can ask whether the
//! daemon is alive.
//!
//! `status.json` has always been a scrapable heartbeat, but only for a reader on the same disk.
//! A container healthcheck cannot read it, an uptime check cannot read it, and the frontend's
//! `OPERATOR_STATUS_URL` mode — already written, already sanitizing — had no server to point at.
//!
//! Three properties, all deliberate (GOAL D3):
//!
//! - **Off by default.** No `[ops] listen`, no socket.
//! - **Read-only.** Three routes, all GET. There is no way to trigger, halt, resolve or configure
//!   anything over the network. The daemon's only inputs remain the chain and its config file.
//! - **Projected, not forwarded.** The body is an allowlist of `status.json`, not `status.json`.
//!   That is not belt-and-braces: an `alert` string can quote a transport error, and a transport
//!   error can quote the RPC URL, and an RPC URL can carry an API key. The file is for the
//!   operator; this is for everyone else.
//!
//! The allowlist is the same one `packages/frontend/app/api/operator-status/[instanceId]/route.ts`
//! enforces on the way in, so the boundary holds on both sides instead of one of them trusting
//! the other.

use crate::ops::Status;
use anyhow::{Context, Result};
use serde_json::{Map, Value};
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::{Arc, Mutex};
use std::time::Duration;

/// Top-level heartbeat fields a reader outside the box may see.
const TOP_KEYS: &[&str] = &["chain_id", "head_block", "tick_at"];

/// Per-instance fields. Note what is absent and why: `newest_anchor_count`, `input_work`,
/// `limiting_capacity` and the `envelope0_*` measurements are operator telemetry, not public
/// facts about the instance, and they are exactly the kind of field that grows a URL later.
const INSTANCE_KEYS: &[&str] =
    &["instance_id", "name", "program", "snapshot", "curated", "action", "blocks_since_root"];

/// Operating policy a community can audit. Adding a field here is a deliberate publication
/// decision; adding one to `PublicSettings` alone publishes nothing.
const SETTINGS_KEYS: &[&str] = &[
    "paid_enabled",
    "paid_vault",
    "paid_recipient",
    "tick_seconds",
    "subsidy_min_blocks",
    "max_concurrent",
    "max_per_instance",
    "max_basefee_gwei",
    "replacement_after_s",
    "simulate_before_send",
    "submit_failure_threshold",
    "confirmations",
    "track_block_hash",
    "prover_backend",
    "groth16",
    "proof_timeout_s",
    "per_instance_usd_per_day",
    "global_usd_per_day",
    "budget_window_seconds",
    "publishes_scores",
    "verifies_score_readback",
    "publication_target_count",
    "publication_min_success",
    "publication_retry_seconds",
    "signer_sync_enabled",
    "signer_confirmations",
    "signer_track_block_hash",
    "signer_per_instance_usd_per_day",
    "signer_global_usd_per_day",
    "signer_budget_window_seconds",
];

/// Request line cap. A health endpoint has no use for a long URL, and an unbounded read from an
/// anonymous socket is the one way a read-only server can still be a liability.
const MAX_REQUEST_BYTES: u64 = 8 * 1024;
const SOCKET_TIMEOUT: Duration = Duration::from_secs(5);

/// What the listener serves, updated by the tick loop.
pub struct Health {
    inner: Mutex<Inner>,
    /// How stale the last completed tick may be before `/ready` reports failure.
    ready_after_seconds: u64,
}

#[derive(Default)]
struct Inner {
    /// Unix seconds of the last COMPLETED tick — the same number the heartbeat publishes, so
    /// `/ready` and the body can never disagree about when the daemon last did its job.
    tick_at: u64,
    body: Option<String>,
}

impl Health {
    pub fn new(ready_after_seconds: u64) -> Arc<Self> {
        Arc::new(Self { inner: Mutex::new(Inner::default()), ready_after_seconds })
    }

    /// Publish a completed tick. `status` is projected here, once, rather than on every request.
    pub fn publish(&self, status: &Status) {
        let body = heartbeat_body(status);
        let mut inner = self.lock();
        inner.tick_at = status.tick_at;
        inner.body = Some(body);
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
        // A poisoned lock here means a request thread panicked mid-update. The heartbeat is not
        // worth taking the daemon down over; the worst case is one stale body.
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn ready(&self, now: u64) -> (bool, String) {
        let inner = self.lock();
        if inner.tick_at == 0 {
            return (false, "no tick has completed yet".to_string());
        }
        let age = now.saturating_sub(inner.tick_at);
        (
            age <= self.ready_after_seconds,
            format!("last tick {age}s ago, threshold {}s", self.ready_after_seconds),
        )
    }
}

/// Bind the listener and serve it on a background thread. Returns once the socket is bound, so a
/// bad address is a startup failure and not a surprise an hour later.
pub fn spawn(addr: &str, health: Arc<Health>) -> Result<std::net::SocketAddr> {
    let listener = TcpListener::bind(addr)
        .with_context(|| format!("[ops] listen address {addr} could not be bound"))?;
    let local = listener.local_addr()?;
    std::thread::Builder::new().name("health".into()).spawn(move || {
        // Deliberately serial. A read-only endpoint that a healthcheck polls has no need for
        // concurrency, and a thread per connection is how a three-route server becomes a way to
        // exhaust the box.
        for stream in listener.incoming().flatten() {
            let _ = serve_one(stream, &health);
        }
    })?;
    Ok(local)
}

fn serve_one(mut stream: TcpStream, health: &Health) -> std::io::Result<()> {
    stream.set_read_timeout(Some(SOCKET_TIMEOUT))?;
    stream.set_write_timeout(Some(SOCKET_TIMEOUT))?;

    let mut reader = BufReader::new(stream.try_clone()?);
    let mut request_line = String::new();
    if reader.by_ref().take(MAX_REQUEST_BYTES).read_line(&mut request_line)? == 0 {
        return Ok(());
    }
    // Headers are read and discarded so the client sees a complete exchange rather than a reset,
    // but nothing in them is ever consulted: there is no auth, no content negotiation and no
    // behaviour to influence.
    let mut header = String::new();
    while reader.by_ref().take(MAX_REQUEST_BYTES).read_line(&mut header)? > 0 {
        if header.trim().is_empty() {
            break;
        }
        header.clear();
    }

    let (status, content_type, body) = respond(&request_line, health);
    let response = format!(
        "HTTP/1.1 {status}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\n\
         Cache-Control: no-store\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    stream.write_all(response.as_bytes())?;
    stream.flush()?;
    let _ = stream.shutdown(std::net::Shutdown::Both);
    Ok(())
}

/// The whole routing table. Anything not named here is 404, including anything that would need a
/// request body to mean something.
fn respond(request_line: &str, health: &Health) -> (&'static str, &'static str, String) {
    let mut parts = request_line.split_whitespace();
    let method = parts.next().unwrap_or_default();
    let target = parts.next().unwrap_or_default();
    let path = target.split(['?', '#']).next().unwrap_or_default();

    if method != "GET" && method != "HEAD" {
        return ("405 Method Not Allowed", "text/plain", "this endpoint is read-only\n".into());
    }

    match path {
        // The process is up and answering. Says nothing about whether it is working.
        "/health" => ("200 OK", "text/plain", "ok\n".into()),
        "/ready" => {
            let now = unix_now();
            match health.ready(now) {
                (true, detail) => ("200 OK", "text/plain", format!("{detail}\n")),
                (false, detail) => ("503 Service Unavailable", "text/plain", format!("{detail}\n")),
            }
        }
        "/status" => match health.lock().body.clone() {
            Some(body) => ("200 OK", "application/json", body),
            None => (
                "503 Service Unavailable",
                "application/json",
                "{\"error\":\"no tick has completed yet\"}".into(),
            ),
        },
        _ => ("404 Not Found", "text/plain", "not found\n".into()),
    }
}

fn unix_now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// Project the heartbeat down to the allowlist.
///
/// Picking named keys, rather than dropping named ones, is what makes this safe to leave alone:
/// a field added to `Status` in a year is invisible here until somebody decides to publish it.
pub fn heartbeat_body(status: &Status) -> String {
    let raw = serde_json::to_value(status).unwrap_or(Value::Null);
    let Some(raw) = raw.as_object() else { return "{}".to_string() };

    let mut out = pick(raw, TOP_KEYS);
    let instances: Vec<Value> = raw
        .get("instances")
        .and_then(Value::as_array)
        .map(|entries| {
            entries
                .iter()
                .filter_map(Value::as_object)
                .map(|entry| Value::Object(pick(entry, INSTANCE_KEYS)))
                .collect()
        })
        .unwrap_or_default();
    out.insert("instances".into(), Value::Array(instances));
    let settings = raw
        .get("settings")
        .and_then(Value::as_object)
        .map(|s| pick(s, SETTINGS_KEYS))
        .unwrap_or_default();
    out.insert("settings".into(), Value::Object(settings));
    serde_json::to_string(&Value::Object(out)).unwrap_or_else(|_| "{}".into())
}

fn pick(source: &Map<String, Value>, keys: &[&str]) -> Map<String, Value> {
    keys.iter()
        .filter_map(|key| source.get(*key).map(|value| ((*key).to_string(), value.clone())))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ops::{InstanceStatus, PublicSettings};
    use operator_core::types::{Action, IdleReason, Program};

    fn sample() -> Status {
        Status {
            chain_id: 11_155_111,
            head_block: 9_100_200,
            tick_at: 1_700_000_000,
            instances: vec![InstanceStatus {
                instance_id: format!("{:#x}", alloy_primitives::B256::repeat_byte(0x11)),
                name: "Gitcoin Stewards".into(),
                program: Program::Trustgraphs.name().to_string(),
                snapshot: format!("{:#x}", alloy_primitives::Address::repeat_byte(0x22)),
                curated: true,
                action: Action::Idle(IdleReason::Quiet),
                blocks_since_root: Some(42),
                newest_anchor_count: 7,
                input_work: 11,
                input_capacity: 2_048,
                limiting_capacity: operator_core::CapacityUsage {
                    ceiling: operator_core::capacity::CapacityCeiling::CycleLimit,
                    observed: 1,
                    limit: 2,
                    input_work: 11,
                    profile_version: 1,
                },
                envelope0_fetch_latency_ms: Some(120),
                envelope0_exact_readers: Some(2),
                envelope0_validation_failed: false,
                unprovable_age_blocks: None,
            }],
            settings: PublicSettings {
                capability_profile: operator_core::CapabilityProfile::default(),
                cost_model_version: operator_core::work::COST_MODEL_VERSION,
                cycle_limit: 1_000,
                protocol_max_total_inputs: 2_048,
                paid_enabled: true,
                paid_vault: Some(format!("{:#x}", alloy_primitives::Address::repeat_byte(0x33))),
                paid_recipient: Some(format!("{:#x}", alloy_primitives::Address::repeat_byte(4))),
                tick_seconds: 60,
                subsidy_min_blocks: 216_000,
                max_concurrent: 4,
                max_per_instance: 1,
                max_basefee_gwei: 40,
                replacement_after_s: 120,
                simulate_before_send: true,
                confirmations: 3,
                track_block_hash: true,
                prover_backend: "network".into(),
                groth16: true,
                proof_timeout_s: 3_600,
                per_instance_usd_per_day: 25,
                global_usd_per_day: 250,
                budget_window_seconds: 86_400,
                publishes_scores: true,
                verifies_score_readback: true,
                publication_target_count: 2,
                publication_min_success: 2,
                publication_retry_seconds: 300,
                weighted_manifest_mirror_count: 1,
                weighted_manifest_cache_max_versions: 128,
                weighted_manifest_cache_max_bytes: 16 * 1024 * 1024,
                weighted_manifest_retry_seconds: 300,
                submit_failure_threshold: 3,
                signer_sync_enabled: true,
                signer_confirmations: 5,
                signer_track_block_hash: true,
                signer_per_instance_usd_per_day: 5,
                signer_global_usd_per_day: 50,
                signer_budget_window_seconds: 86_400,
            },
            // Both of these are the reason the body is a projection rather than the file.
            unresolved: vec!["0xdeadbeef/7 requested 2026-08-24".into()],
            alerts: vec![
                "tick failed: error sending request for url (https://sepolia.example/v2/SECRET-KEY)"
                    .into(),
            ],
        }
    }

    #[test]
    fn the_body_carries_what_the_frontend_reads() {
        let body: Value = serde_json::from_str(&heartbeat_body(&sample())).unwrap();
        assert_eq!(body["chain_id"], 11_155_111);
        assert_eq!(body["head_block"], 9_100_200);
        assert_eq!(body["tick_at"], 1_700_000_000u64);
        assert_eq!(body["instances"][0]["name"], "Gitcoin Stewards");
        assert_eq!(body["instances"][0]["curated"], true);
        assert_eq!(body["instances"][0]["blocks_since_root"], 42);
        assert_eq!(body["instances"][0]["action"]["action"], "idle");
        assert_eq!(body["instances"][0]["action"]["idle"], "quiet");
        assert_eq!(body["settings"]["prover_backend"], "network");
        assert_eq!(body["settings"]["signer_sync_enabled"], true);
    }

    #[test]
    fn every_key_the_frontend_adapter_asks_for_is_actually_published() {
        // The two allowlists are maintained in different languages. A rename on this side would
        // otherwise show up as a silently blank operator panel rather than as a failure.
        let body: Value = serde_json::from_str(&heartbeat_body(&sample())).unwrap();
        for key in SETTINGS_KEYS {
            assert!(body["settings"].get(key).is_some(), "settings.{key} is missing");
        }
        for key in INSTANCE_KEYS {
            assert!(body["instances"][0].get(key).is_some(), "instance.{key} is missing");
        }
        for key in TOP_KEYS {
            assert!(body.get(key).is_some(), "{key} is missing");
        }
    }

    #[test]
    fn nothing_a_reader_must_not_see_survives_the_projection() {
        let body = heartbeat_body(&sample());
        // An alert quotes the transport error, the transport error quotes the URL, and the URL
        // carries the provider key. This is the specific leak the projection exists to stop.
        assert!(!body.contains("SECRET-KEY"), "{body}");
        assert!(!body.contains("sepolia.example"), "{body}");
        assert!(!body.contains("alerts"), "{body}");
        // Unresolved requests are money waiting on a human, and name checkpoints nobody outside
        // the operator has any business enumerating.
        assert!(!body.contains("unresolved"), "{body}");
        assert!(!body.contains("0xdeadbeef"), "{body}");
        // Operator telemetry stays operator telemetry.
        assert!(!body.contains("envelope0"), "{body}");
        assert!(!body.contains("capability_profile"), "{body}");
    }

    #[test]
    fn a_field_added_to_the_heartbeat_is_not_published_by_accident() {
        // Simulated by asking the projection for a key that exists in `Status` and is not on any
        // allowlist. If this ever passes trivially, the projection has stopped being a whitelist.
        let raw: Value = serde_json::to_value(sample()).unwrap();
        assert!(raw.get("alerts").is_some(), "the fixture must contain the field being excluded");
        let body: Value = serde_json::from_str(&heartbeat_body(&sample())).unwrap();
        assert!(body.get("alerts").is_none());
    }

    #[test]
    fn readiness_follows_the_last_completed_tick() {
        let health = Health::new(30);
        assert!(!health.ready(1_000_000).0, "nothing has ticked yet");
        let mut status = sample();
        status.tick_at = 1_000_000;
        health.publish(&status);
        assert!(health.ready(1_000_020).0, "20s old with a 30s threshold is ready");
        let (ready, detail) = health.ready(1_000_031);
        assert!(!ready, "31s old with a 30s threshold is not");
        assert!(detail.contains("31s ago"), "{detail}");
    }

    #[test]
    fn the_routing_table_is_three_routes_and_nothing_else() {
        let health = Health::new(30);
        health.publish(&sample());
        assert_eq!(respond("GET /health HTTP/1.1", &health).0, "200 OK");
        assert_eq!(respond("GET /status?nocache=1 HTTP/1.1", &health).0, "200 OK");
        assert_eq!(respond("GET /journal.jsonl HTTP/1.1", &health).0, "404 Not Found");
        assert_eq!(respond("GET / HTTP/1.1", &health).0, "404 Not Found");
        assert_eq!(respond("GET /../operator.toml HTTP/1.1", &health).0, "404 Not Found");
    }

    #[test]
    fn there_is_no_way_to_ask_the_daemon_to_do_anything() {
        let health = Health::new(30);
        for line in [
            "POST /status HTTP/1.1",
            "PUT /health HTTP/1.1",
            "DELETE /ready HTTP/1.1",
            "PATCH /status HTTP/1.1",
        ] {
            assert_eq!(respond(line, &health).0, "405 Method Not Allowed", "{line}");
        }
    }

    #[test]
    fn a_bound_listener_answers_over_a_real_socket() {
        let health = Health::new(30);
        let mut status = sample();
        status.tick_at = unix_now();
        health.publish(&status);
        let addr = spawn("127.0.0.1:0", health).expect("binds");

        let get = |path: &str| -> String {
            let mut stream = TcpStream::connect(addr).unwrap();
            stream.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
            write!(stream, "GET {path} HTTP/1.1\r\nHost: localhost\r\n\r\n").unwrap();
            let mut response = String::new();
            stream.read_to_string(&mut response).unwrap();
            response
        };
        assert!(get("/health").starts_with("HTTP/1.1 200 OK"));
        assert!(get("/ready").starts_with("HTTP/1.1 200 OK"));
        let status_response = get("/status");
        assert!(status_response.contains("application/json"), "{status_response}");
        assert!(status_response.contains("\"head_block\":9100200"), "{status_response}");
        assert!(get("/journal.jsonl").starts_with("HTTP/1.1 404"));
    }

    #[test]
    fn an_address_that_cannot_be_bound_fails_at_startup() {
        let error = spawn("256.256.256.256:9", Health::new(30)).unwrap_err();
        assert!(format!("{error:#}").contains("could not be bound"), "{error:#}");
    }
}
