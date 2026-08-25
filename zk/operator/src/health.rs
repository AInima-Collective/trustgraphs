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
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::{mpsc, Arc, Mutex};
use std::time::{Duration, Instant};

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
    "global_budget_alert_percent",
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
const MAX_REQUEST_BYTES: usize = 8 * 1024;
const MAX_HEADER_BYTES: usize = 16 * 1024;
const MAX_HEADER_LINES: usize = 64;
const REQUEST_DEADLINE: Duration = Duration::from_secs(1);
const WRITE_TIMEOUT: Duration = Duration::from_secs(2);
const HEALTH_WORKERS: usize = 8;
const HEALTH_QUEUE: usize = 16;

/// What the daemon is doing right now.
///
/// Readiness has to know this, because "wedged" and "working" are indistinguishable from a single
/// timestamp. A proof can legitimately take an hour and a receipt watch ten minutes; a probe that
/// only knew when the last tick finished would call both of those dead, and a platform that
/// restarts on a failed probe would then restart the daemon in the middle of the one thing it is
/// there to do. The journal makes that survivable — the restart re-attaches rather than
/// re-requesting — but survivable is not free.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Phase {
    /// Startup: deriving guest vkeys and reading the chain for the first time.
    Starting,
    /// Between ticks, or inside one doing nothing but chain reads.
    Ticking,
    /// Running a reconstruction tool. On a source checkout this is a cold cargo build.
    Reconstructing,
    /// Inside the prover.
    Proving,
    /// Publishing a score blob to the configured targets.
    Publishing,
    /// Broadcast sent, watching for a receipt.
    Sending,
}

impl Phase {
    fn name(self) -> &'static str {
        match self {
            Self::Starting => "starting",
            Self::Ticking => "ticking",
            Self::Reconstructing => "reconstructing an input",
            Self::Proving => "proving",
            Self::Publishing => "publishing",
            Self::Sending => "watching for a receipt",
        }
    }
}

/// How long each phase may legitimately take. Everything except `ticking` is derived from a limit
/// the daemon already enforces on itself, so readiness cannot be stricter than the daemon's own
/// patience — which would make the probe, rather than the failure, the thing that takes it down.
#[derive(Clone, Copy, Debug)]
pub struct Budgets {
    /// From `[ops] ready_after_seconds`: how stale a completed tick may be.
    pub ticking: u64,
    /// A reconstruction subprocess. Generous because the source-checkout fallback compiles it.
    pub reconstructing: u64,
    /// `[prover] timeout_s`, plus room to fail cleanly.
    pub proving: u64,
    /// The receipt watch, plus room to fail cleanly.
    pub sending: u64,
    pub publishing: u64,
    pub starting: u64,
}

impl Budgets {
    fn of(&self, phase: Phase) -> u64 {
        match phase {
            Phase::Starting => self.starting,
            Phase::Ticking => self.ticking,
            Phase::Reconstructing => self.reconstructing,
            Phase::Proving => self.proving,
            Phase::Publishing => self.publishing,
            Phase::Sending => self.sending,
        }
    }
}

/// What the listener serves, updated by the tick loop.
pub struct Health {
    inner: Mutex<Inner>,
    budgets: Budgets,
}

struct Inner {
    /// Unix seconds of the last COMPLETED tick — the same number the heartbeat publishes, so
    /// `/ready` and the body can never disagree about when the daemon last did its job.
    tick_at: u64,
    phase: Phase,
    /// Unix seconds the daemon entered `phase`.
    phase_since: u64,
    body: Option<String>,
}

impl Health {
    pub fn new(budgets: Budgets) -> Arc<Self> {
        Arc::new(Self {
            inner: Mutex::new(Inner {
                tick_at: 0,
                phase: Phase::Starting,
                phase_since: unix_now(),
                body: None,
            }),
            budgets,
        })
    }

    /// Record what the daemon is about to spend time on.
    pub fn enter(&self, phase: Phase) {
        let mut inner = self.lock();
        inner.phase = phase;
        inner.phase_since = if phase == Phase::Ticking {
            // Ordinary tick work is measured from the last COMPLETED pass, never from the start
            // of the current attempt. The loop enters this phase at the top of every tick, so
            // anchoring to `now` would let a daemon whose chain reads time out and retry reset
            // its own clock once a cycle — reporting ready for the first seconds of each one,
            // indefinitely, while completing nothing. A monitor polling on any interval longer
            // than the budget would see a healthy daemon forever.
            inner.tick_at
        } else {
            unix_now()
        };
    }

    /// Run one operation under a non-ticking readiness budget and always restore ordinary tick
    /// accounting, including when the operation returns an error. This keeps early preflight and
    /// reconstruction paths from being forgotten when phases are added at a distant call site.
    pub fn during<T>(&self, phase: Phase, operation: impl FnOnce() -> T) -> T {
        debug_assert!(phase != Phase::Ticking);
        self.enter(phase);
        let _restore = RestoreTicking(self);
        operation()
    }

    /// Publish a completed tick. `status` is projected here, once, rather than on every request.
    pub fn publish(&self, status: &Status) {
        let body = heartbeat_body(status);
        let mut inner = self.lock();
        inner.tick_at = status.tick_at;
        inner.phase = Phase::Ticking;
        // The SAME instant the heartbeat publishes, not "now": `/ready` and the body must never
        // be able to disagree about when the daemon last did its job.
        inner.phase_since = status.tick_at;
        inner.body = Some(body);
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
        // A poisoned lock here means a request thread panicked mid-update. The heartbeat is not
        // worth taking the daemon down over; the worst case is one stale body.
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn ready(&self, now: u64) -> (bool, String) {
        let inner = self.lock();
        // Ready means "has done its job at least once and is not stuck", so a daemon still on its
        // first pass is not ready no matter what it is busy with. A container healthcheck should
        // carry a start period long enough to cover a first tick that proves.
        if inner.tick_at == 0 {
            return (false, format!("no tick has completed yet ({})", inner.phase.name()));
        }
        let phase = inner.phase;
        let budget = self.budgets.of(phase);
        let age = now.saturating_sub(inner.phase_since);
        (age <= budget, format!("{} for {age}s, limit {budget}s", phase.name()))
    }
}

struct RestoreTicking<'a>(&'a Health);

impl Drop for RestoreTicking<'_> {
    fn drop(&mut self) {
        self.0.enter(Phase::Ticking);
    }
}

/// Bind the listener and serve it on a background thread. Returns once the socket is bound, so a
/// bad address is a startup failure and not a surprise an hour later.
pub fn spawn(addr: &str, health: Arc<Health>) -> Result<std::net::SocketAddr> {
    let listener = TcpListener::bind(addr)
        .with_context(|| format!("[ops] listen address {addr} could not be bound"))?;
    let local = listener.local_addr()?;
    let (sender, receiver) = mpsc::sync_channel::<TcpStream>(HEALTH_QUEUE);
    let receiver = Arc::new(Mutex::new(receiver));
    for index in 0..HEALTH_WORKERS {
        let receiver = Arc::clone(&receiver);
        let health = Arc::clone(&health);
        std::thread::Builder::new().name(format!("health-worker-{index}")).spawn(move || loop {
            let stream = receiver.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).recv();
            let Ok(stream) = stream else { break };
            let _ = serve_one(stream, &health);
        })?;
    }
    std::thread::Builder::new().name("health-accept".into()).spawn(move || {
        for stream in listener.incoming().flatten() {
            // A bounded queue keeps anonymous clients from allocating unbounded threads or memory.
            // When it is full, dropping the socket fails fast and leaves the accept loop responsive.
            let _ = sender.try_send(stream);
        }
    })?;
    Ok(local)
}

fn serve_one(mut stream: TcpStream, health: &Health) -> std::io::Result<()> {
    stream.set_write_timeout(Some(WRITE_TIMEOUT))?;
    let Some(request_line) = read_request(&mut stream)? else { return Ok(()) };

    let (status, content_type, body) = respond(&request_line, health);
    // A HEAD gets the headers a GET would, and no body — including the Content-Length the GET
    // would have had, which is the whole point of asking.
    let head_only = request_line.split_whitespace().next() == Some("HEAD");
    let response = format!(
        "HTTP/1.1 {status}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\n\
         Cache-Control: no-store\r\nConnection: close\r\n\r\n{}",
        body.len(),
        if head_only { "" } else { body.as_str() }
    );
    stream.write_all(response.as_bytes())?;
    stream.flush()?;
    let _ = stream.shutdown(std::net::Shutdown::Both);
    Ok(())
}

/// Read one bounded HTTP header under an absolute deadline. Socket read timeouts are inactivity
/// timers: a client sending one byte just before each timeout can hold them forever. Nonblocking
/// reads plus an `Instant` make the deadline independent of traffic rate.
fn read_request(stream: &mut TcpStream) -> std::io::Result<Option<String>> {
    stream.set_nonblocking(true)?;
    let deadline = Instant::now() + REQUEST_DEADLINE;
    let mut bytes = Vec::with_capacity(1024);
    let mut chunk = [0u8; 1024];
    loop {
        if Instant::now() >= deadline {
            return Err(std::io::Error::new(
                std::io::ErrorKind::TimedOut,
                "health request exceeded its absolute deadline",
            ));
        }
        match stream.read(&mut chunk) {
            Ok(0) => break,
            Ok(count) => {
                bytes.extend_from_slice(&chunk[..count]);
                if bytes.len() > MAX_HEADER_BYTES {
                    return Err(std::io::Error::new(
                        std::io::ErrorKind::InvalidData,
                        "health request headers exceeded the byte limit",
                    ));
                }
                if bytes.windows(4).any(|window| window == b"\r\n\r\n")
                    || bytes.windows(2).any(|window| window == b"\n\n")
                {
                    break;
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                std::thread::sleep(Duration::from_millis(5));
            }
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => {}
            Err(error) => return Err(error),
        }
    }
    if bytes.is_empty() {
        return Ok(None);
    }
    let text = std::str::from_utf8(&bytes).map_err(|_| {
        std::io::Error::new(std::io::ErrorKind::InvalidData, "health request was not UTF-8")
    })?;
    let mut lines = text.lines();
    let request_line = lines.next().unwrap_or_default().trim_end_matches('\r');
    if request_line.len() > MAX_REQUEST_BYTES || lines.count() > MAX_HEADER_LINES {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "health request exceeded its line limits",
        ));
    }
    stream.set_nonblocking(false)?;
    Ok(Some(request_line.to_string()))
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
                global_budget_alert_percent: 80,
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

    fn budgets() -> Budgets {
        Budgets {
            ticking: 30,
            reconstructing: 900,
            proving: 3_600,
            sending: 720,
            publishing: 300,
            starting: 300,
        }
    }

    #[test]
    fn readiness_follows_the_last_completed_tick() {
        let health = Health::new(budgets());
        let mut status = sample();
        status.tick_at = 1_000_000;
        health.publish(&status);
        assert!(health.ready(1_000_020).0, "20s into a 30s tick budget is ready");
        let (ready, detail) = health.ready(1_000_031);
        assert!(!ready, "31s into a 30s tick budget is not");
        assert!(detail.contains("ticking for 31s"), "{detail}");
    }

    #[test]
    fn a_failing_tick_cannot_reset_its_own_readiness_clock() {
        // The daemon enters `Ticking` at the top of EVERY attempt, including the ones that go on
        // to fail. If that reset the clock, a permanently wedged daemon would report ready for
        // the first seconds of every retry — which is indistinguishable from healthy to anything
        // that polls less often than the budget.
        let health = Health::new(budgets());
        let mut status = sample();
        status.tick_at = 1_000_000;
        health.publish(&status);

        // Three failed attempts, each re-entering the phase, none completing.
        for _ in 0..3 {
            health.enter(Phase::Ticking);
            assert!(!health.ready(1_000_100).0, "a retry must not look like progress");
        }
        let (_, detail) = health.ready(1_000_100);
        assert!(
            detail.contains("ticking for 100s"),
            "the clock is the last COMPLETED tick: {detail}"
        );

        // A tick that actually completes moves it, and only then.
        status.tick_at = 1_000_100;
        health.publish(&status);
        assert!(health.ready(1_000_110).0);
    }

    #[test]
    fn scoped_reconstruction_uses_its_budget_and_restores_the_tick_clock() {
        let mut limits = budgets();
        limits.ticking = 1;
        let health = Health::new(limits);
        let now = unix_now();
        let mut status = sample();
        status.tick_at = now.saturating_sub(10);
        health.publish(&status);
        assert!(!health.ready(now).0, "the completed tick is deliberately stale");

        let reconstructing_was_ready = health.during(Phase::Reconstructing, || health.ready(now).0);
        assert!(reconstructing_was_ready, "legitimate reconstruction gets its own budget");
        assert!(!health.ready(now).0, "leaving the scope restores the stale completed-tick clock");
    }

    #[test]
    fn a_daemon_that_is_proving_is_working_rather_than_wedged() {
        // The failure this prevents: a probe with a tick-sized threshold calls an hour-long proof
        // dead, and a platform that restarts on a failed probe kills the daemon mid-proof.
        let health = Health::new(budgets());
        let mut status = sample();
        status.tick_at = 1_000_000;
        health.publish(&status);
        health.enter(Phase::Proving);
        let now = unix_now();
        assert!(health.ready(now + 600).0, "ten minutes into a proof is not a wedge");
        assert!(health.ready(now + 3_500).0, "so is fifty-eight minutes, under a 3600s limit");
        let (ready, detail) = health.ready(now + 3_601);
        assert!(!ready, "past the prover's own timeout, it is not working either");
        assert!(detail.contains("proving"), "{detail}");
    }

    #[test]
    fn a_receipt_watch_outlives_the_tick_budget_and_says_so() {
        // A trigger or submit watches for a receipt for up to ten minutes with no log line. That
        // silence is legitimate, and a probe must be able to tell it from a hang.
        let health = Health::new(budgets());
        let mut status = sample();
        status.tick_at = 1_000_000;
        health.publish(&status);
        health.enter(Phase::Sending);
        let now = unix_now();
        assert!(health.ready(now + 400).0, "still inside the receipt watch");
        let (ready, detail) = health.ready(now + 721);
        assert!(!ready);
        assert!(detail.contains("receipt"), "{detail}");
    }

    #[test]
    fn startup_is_not_ready_until_a_tick_has_completed() {
        let health = Health::new(budgets());
        let (ready, detail) = health.ready(unix_now());
        assert!(!ready, "nothing has ticked yet");
        assert!(detail.contains("starting"), "{detail}");
        health.enter(Phase::Proving);
        assert!(!health.ready(unix_now()).0, "busy on the first pass is still not ready");
    }

    #[test]
    fn the_routing_table_is_three_routes_and_nothing_else() {
        let health = Health::new(budgets());
        health.publish(&sample());
        assert_eq!(respond("GET /health HTTP/1.1", &health).0, "200 OK");
        assert_eq!(respond("GET /status?nocache=1 HTTP/1.1", &health).0, "200 OK");
        assert_eq!(respond("GET /journal.jsonl HTTP/1.1", &health).0, "404 Not Found");
        assert_eq!(respond("GET / HTTP/1.1", &health).0, "404 Not Found");
        assert_eq!(respond("GET /../operator.toml HTTP/1.1", &health).0, "404 Not Found");
    }

    #[test]
    fn there_is_no_way_to_ask_the_daemon_to_do_anything() {
        let health = Health::new(budgets());
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
        let health = Health::new(budgets());
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

        // A HEAD gets the GET's headers and none of its body.
        let head = {
            let mut stream = TcpStream::connect(addr).unwrap();
            stream.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
            write!(stream, "HEAD /status HTTP/1.1\r\nHost: localhost\r\n\r\n").unwrap();
            let mut response = String::new();
            stream.read_to_string(&mut response).unwrap();
            response
        };
        assert!(head.contains("Content-Length: "), "{head}");
        assert!(!head.contains("head_block"), "a HEAD must not carry the body: {head}");

        assert!(get("/ready").starts_with("HTTP/1.1 200 OK"));
        let status_response = get("/status");
        assert!(status_response.contains("application/json"), "{status_response}");
        assert!(status_response.contains("\"head_block\":9100200"), "{status_response}");
        assert!(get("/journal.jsonl").starts_with("HTTP/1.1 404"));
    }

    #[test]
    fn a_slow_client_cannot_starve_a_health_probe() {
        let health = Health::new(budgets());
        let mut status = sample();
        status.tick_at = unix_now();
        health.publish(&status);
        let addr = spawn("127.0.0.1:0", health).expect("binds");

        let mut slow = TcpStream::connect(addr).unwrap();
        slow.write_all(b"G").unwrap();
        std::thread::sleep(Duration::from_millis(50));

        let started = Instant::now();
        let mut probe = TcpStream::connect(addr).unwrap();
        probe.set_read_timeout(Some(Duration::from_secs(2))).unwrap();
        probe.write_all(b"GET /health HTTP/1.1\r\nHost: localhost\r\n\r\n").unwrap();
        let mut response = String::new();
        probe.read_to_string(&mut response).unwrap();
        assert!(response.starts_with("HTTP/1.1 200 OK"), "{response}");
        assert!(started.elapsed() < REQUEST_DEADLINE, "the slow socket serialized the listener");
        drop(slow);
    }

    #[test]
    fn incomplete_requests_are_closed_on_an_absolute_deadline() {
        let health = Health::new(budgets());
        let addr = spawn("127.0.0.1:0", health).expect("binds");
        let mut slow = TcpStream::connect(addr).unwrap();
        slow.set_read_timeout(Some(Duration::from_secs(3))).unwrap();
        slow.write_all(b"G").unwrap();

        let started = Instant::now();
        let mut response = Vec::new();
        let _ = slow.read_to_end(&mut response);
        assert!(
            started.elapsed() < Duration::from_secs(2),
            "a trickling client outlived the absolute deadline"
        );
    }

    #[test]
    fn an_address_that_cannot_be_bound_fails_at_startup() {
        let error = spawn("256.256.256.256:9", Health::new(budgets())).unwrap_err();
        assert!(format!("{error:#}").contains("could not be bound"), "{error:#}");
    }
}
