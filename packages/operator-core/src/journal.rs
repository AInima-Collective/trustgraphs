//! The append-only request journal: "don't pay twice after a crash", and nothing else.
//!
//! The contracts are the scheduler's database. This file exists for exactly one gap the contracts
//! cannot close: between deciding to request a proof and learning the request's id, a crash leaves
//! no on-chain trace of the money already committed.
//!
//! The sequence is **fsync an intent → make the request → append the id**:
//!
//! | on restart we find | it means | what we do |
//! |---|---|---|
//! | intent + id | the request is ours and we hold its handle | re-attach and poll |
//! | no intent | nothing was requested | proceed normally |
//! | intent, no id | **ambiguous** | resolve by lookup; if that fails, `RequestOutcomeUnknown` |
//!
//! ## The ambiguous window, measured
//!
//! A request id cannot be journaled before the request that mints it, so the window is structural.
//! What decides whether it is rare or routine is whether the backend can answer "what happened to
//! the thing I was about to ask for?". Measured against **sp1-sdk 6.3.1**:
//!
//! - There is **no client-supplied idempotency key**. `NetworkClient::request_proof` takes no
//!   caller nonce; the `nonce` in the signed body is `self.get_nonce()`, fetched server-side
//!   immediately before signing. The public builder (`NetworkProveBuilder::request()`) exposes no
//!   idempotency knob at all.
//! - But there is a natural one that round-trips: **`public_values_hash`**. `request_proof` takes
//!   it (`client.rs:645`), and the `ProofRequest` record returned by both
//!   `get_proof_request_details` and `get_filtered_proof_requests` carries it back. For this
//!   operator it is fully determined *before* the request, because ground rule 4 computes the
//!   journal natively first. It is therefore a content-addressed request key we did not have to
//!   invent — and it distinguishes checkpoints, since the journal commits the checkpoint's
//!   accumulator state.
//! - **Status lookup by requester exists**: `get_filtered_proof_requests(version,
//!   fulfillment_status, execution_status, minimum_deadline, vk_hash, requester, fulfiller, from,
//!   to, limit, page, …)`.
//!
//! So the resolution is: filter on `requester = us`, `vk_hash = our program`, `from = intent time
//! − slack`, and match `public_values_hash`. **`RequestOutcomeUnknown` is rare, not routine** — it
//! survives only for index lag, or a request created but not yet visible.
//!
//! One trap worth writing down, because it silently disarms all of the above: the SDK attaches
//! `public_values_hash` only when it simulates (`prover.rs:820-848`), and it skips simulation when
//! **both** `cycle_limit` and `gas_limit` are set. Our config sets `cycle_limit`. So the adapter
//! must call the lower-level `NetworkClient::request_proof` with the hash we already computed,
//! rather than the convenience builder.

use crate::policy::Spend;
use alloy_primitives::B256;
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;
use std::fs::{File, OpenOptions};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};

/// The key of a unit of paid work. One checkpoint on one instance on one chain is paid for once.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
pub struct WorkKey {
    pub chain_id: u64,
    pub instance_id: B256,
    pub checkpoint_id: u64,
}

/// A submit failure that is safe to count toward abandoning one immutable checkpoint.
///
/// These are deliberately all execution reverts. Provider outages, fee errors, receipt timeouts,
/// broadcast failures, and reorgs never enter this enum: the same proof may succeed once those
/// transient conditions clear, so treating them as evidence that the checkpoint is bad would
/// discard valid paid work.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SubmitFailureClass {
    /// `eth_estimateGas` executed the submit and reported a revert.
    EstimateRevert,
    /// The explicit pre-broadcast `eth_call` executed the submit and reported a revert.
    SimulationRevert,
    /// A broadcast transaction was mined with `status = 0`.
    ReceiptRevert,
}

/// One line of the journal.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Record {
    /// Written and fsynced BEFORE the request. Everything after this point is money at risk.
    Intent {
        key: WorkKey,
        /// The content-addressed request key: `keccak256` of the public values the guest will
        /// commit, which we computed natively before asking anyone to prove it.
        public_values_hash: B256,
        /// The program vkey, so a lookup can filter by it.
        vk_hash: B256,
        /// Unix seconds. Supplied by the caller — this crate has no clock, so tests are
        /// deterministic and resume is reproducible.
        at: u64,
        /// What this request is expected to cost US, in cents, at the moment we committed to it.
        ///
        /// Recorded here rather than derived later because it is the ONLY place the number is
        /// knowable: the estimate depends on the instance's size at request time, and by the time
        /// a budget question is asked the graph has moved. Without it, `LossBudget` is unreachable
        /// code — the daemon passed `Spend::default()` forever and the budget could never fire.
        ///
        /// `serde(default)` so journals written before this field still replay; those lines
        /// contribute zero, which is the safe direction (a budget cannot halt an instance on
        /// spend it cannot see, and the alternative — guessing — would halt on a number nobody
        /// recorded).
        #[serde(default)]
        cost_cents: u64,
    },
    /// Written after the request returns a handle.
    Requested { key: WorkKey, request_id: B256, at: u64 },
    /// The request resolved, one way or another.
    Settled { key: WorkKey, outcome: Outcome, at: u64 },
    /// A human looked at an `OutcomeUnknown` and said what it was.
    Resolved { key: WorkKey, request_id: Option<B256>, at: u64 },
    /// One on-chain submit attempt burned gas (H-3, 2026-08-13 audit). Written from the receipt
    /// — landed or reverted — so on-chain gas registers in the same rolling budget as proving
    /// cost, and a revert LOOP registers as strikes instead of silently draining the hot wallet.
    /// Does not change the key's request status; it is spend + strike bookkeeping only.
    SubmitGas {
        key: WorkKey,
        /// True when the receipt said the tx reverted — gas burned for nothing.
        reverted: bool,
        /// `gas_used × effective_gas_price`, converted to USD-cents at the configured crude
        /// ETH price (same philosophy as `cents_per_billion_cycles`: stop a runaway, not bill).
        cost_cents: u64,
        at: u64,
    },
    /// A deterministic pre-broadcast failure. Receipt reverts are already represented by
    /// `SubmitGas { reverted: true }`; keeping this record preflight-only avoids double-counting
    /// a mined revert while putting both paths through the same failure counter.
    SubmitFailure { key: WorkKey, class: SubmitFailureClass, at: u64 },
    /// Terminal local disposition for one immutable checkpoint. The proof remains a proof of the
    /// same rejected root; it is never reinterpreted or retried. The planner may instead freeze a
    /// newer checkpoint after inputs move.
    Abandoned { key: WorkKey, class: SubmitFailureClass, attempts: u32, at: u64 },
    /// One publication policy attempt that did not reach its configured minimum. The held score
    /// blob and input live on disk; this durable record makes restart retain backoff and
    /// visibility instead of forgetting the work or alert-looping every tick.
    PublicationAttempt {
        key: WorkKey,
        cid: String,
        policy_hash: B256,
        successes: u32,
        required: u32,
        failures: Vec<String>,
        at: u64,
    },
    /// The score blob satisfied the exact configured publication policy. Bound to `policy_hash`,
    /// so changing targets or the minimum republishes before submit.
    Published {
        key: WorkKey,
        cid: String,
        policy_hash: B256,
        successes: u32,
        required: u32,
        at: u64,
    },
    /// A composition input could not be reconstructed from its exact content-addressed sources.
    /// This is availability state, not a terminal proof failure: later retries use the same
    /// checkpoint/commitments and cannot substitute different bytes.
    CompositionAvailabilityAttempt {
        chain_id: u64,
        instance_id: B256,
        checkpoint_id: Option<u64>,
        error: String,
        at: u64,
    },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Outcome {
    /// A proof came back and the root landed.
    Landed,
    /// The root was already newer when we tried to submit. Success, not failure.
    Superseded,
    /// The request failed and we know it failed.
    Failed,
    /// The request was cancelled before it cost anything.
    Cancelled,
}

/// What the journal says about one unit of work, after replaying every line for it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Status {
    /// No line at all. Nothing was requested.
    Untouched,
    /// Intent fsynced, no id yet, not resolved. The ambiguous window.
    OutcomeUnknown { public_values_hash: B256, vk_hash: B256, since: u64 },
    /// The request is ours and we hold its handle.
    InFlight { request_id: B256 },
    /// Done. Never request again for this key.
    Settled(Outcome),
    /// This immutable checkpoint deterministically rejected enough submit attempts. Never submit
    /// or prove it again; advance to a newer checkpoint.
    Abandoned { class: SubmitFailureClass, attempts: u32 },
}

/// Persistent failed-publication state for one work key and one exact policy.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PublicationRetry {
    pub attempts: u32,
    pub last_at: u64,
    pub failures: Vec<String>,
}

/// Latest repairable source-availability failure for one composition checkpoint/preflight.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CompositionAvailabilityRetry {
    pub error: String,
    pub last_at: u64,
}

/// Append-only JSONL, one file, fsynced at the points that matter.
#[derive(Debug)]
pub struct Journal {
    path: PathBuf,
    records: Vec<Record>,
}

#[derive(Debug, thiserror::Error)]
pub enum JournalError {
    #[error("journal io at {path}: {source}")]
    Io {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
    #[error("journal line {line} in {path} is not a record: {source}")]
    Parse {
        path: PathBuf,
        line: usize,
        #[source]
        source: serde_json::Error,
    },
}

impl Journal {
    /// Open (or create) the journal and replay it.
    ///
    /// A corrupt line is a hard error, not a skip: this file's only job is to stop us paying
    /// twice, and a journal we are willing to read selectively cannot do that job.
    pub fn open(path: impl AsRef<Path>) -> Result<Self, JournalError> {
        let path = path.as_ref().to_path_buf();
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|source| JournalError::Io { path: path.clone(), source })?;
        }
        let mut records = Vec::new();
        if path.exists() {
            let file = File::open(&path)
                .map_err(|source| JournalError::Io { path: path.clone(), source })?;
            for (i, line) in BufReader::new(file).lines().enumerate() {
                let line =
                    line.map_err(|source| JournalError::Io { path: path.clone(), source })?;
                if line.trim().is_empty() {
                    continue;
                }
                let rec = serde_json::from_str(&line).map_err(|source| JournalError::Parse {
                    path: path.clone(),
                    line: i + 1,
                    source,
                })?;
                records.push(rec);
            }
        }
        Ok(Self { path, records })
    }

    /// Append one record and fsync before returning.
    ///
    /// The fsync is the whole point for [`Record::Intent`]: a buffered intent that a crash loses
    /// turns a "did I already pay?" into a "no", and we pay again.
    pub fn append(&mut self, record: Record) -> Result<(), JournalError> {
        let mut line = serde_json::to_string(&record).expect("Record is always serializable");
        line.push('\n');
        let mut file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.path)
            .map_err(|source| JournalError::Io { path: self.path.clone(), source })?;
        file.write_all(line.as_bytes())
            .map_err(|source| JournalError::Io { path: self.path.clone(), source })?;
        file.sync_all().map_err(|source| JournalError::Io { path: self.path.clone(), source })?;
        self.records.push(record);
        Ok(())
    }

    /// Replay every line for one key.
    pub fn status(&self, key: &WorkKey) -> Status {
        let mut status = Status::Untouched;
        for rec in self.records.iter() {
            match rec {
                Record::Intent { key: k, public_values_hash, vk_hash, at, .. } if k == key => {
                    if matches!(status, Status::Abandoned { .. }) {
                        continue;
                    }
                    status = Status::OutcomeUnknown {
                        public_values_hash: *public_values_hash,
                        vk_hash: *vk_hash,
                        since: *at,
                    };
                }
                Record::Requested { key: k, request_id, .. } if k == key => {
                    if matches!(status, Status::Abandoned { .. }) {
                        continue;
                    }
                    status = Status::InFlight { request_id: *request_id };
                }
                Record::Resolved { key: k, request_id, .. } if k == key => {
                    if matches!(status, Status::Abandoned { .. }) {
                        continue;
                    }
                    status = match request_id {
                        Some(id) => Status::InFlight { request_id: *id },
                        // A human confirmed nothing was created. Safe to start over.
                        None => Status::Untouched,
                    };
                }
                Record::Settled { key: k, outcome, .. } if k == key => {
                    status = Status::Settled(*outcome);
                }
                Record::Abandoned { key: k, class, attempts, .. } if k == key => {
                    status = Status::Abandoned { class: *class, attempts: *attempts };
                }
                _ => {}
            }
        }
        status
    }

    /// Every key still sitting in the ambiguous window. These go to a human, never to a retry.
    pub fn unresolved(&self) -> Vec<WorkKey> {
        let mut keys: Vec<WorkKey> = self
            .records
            .iter()
            .filter_map(|r| match r {
                Record::Intent { key, .. } => Some(*key),
                _ => None,
            })
            .collect();
        keys.sort();
        keys.dedup();
        keys.retain(|k| matches!(self.status(k), Status::OutcomeUnknown { .. }));
        keys
    }

    /// Whether a fresh proof request for this key is allowed.
    ///
    /// The only "yes" is `Untouched`. In particular an ambiguous record is a NO: re-requesting is
    /// how you pay twice, and no amount of elapsed time turns "I don't know" into "it didn't
    /// happen".
    pub fn may_request(&self, key: &WorkKey) -> bool {
        matches!(self.status(key), Status::Untouched)
    }

    pub fn composition_availability_retry(
        &self,
        chain_id: u64,
        instance_id: B256,
        checkpoint_id: Option<u64>,
    ) -> Option<CompositionAvailabilityRetry> {
        self.records.iter().rev().find_map(|record| match record {
            Record::CompositionAvailabilityAttempt {
                chain_id: recorded_chain,
                instance_id: recorded_instance,
                checkpoint_id: recorded_checkpoint,
                error,
                at,
            } if *recorded_chain == chain_id
                && *recorded_instance == instance_id
                && *recorded_checkpoint == checkpoint_id =>
            {
                Some(CompositionAvailabilityRetry { error: error.clone(), last_at: *at })
            }
            _ => None,
        })
    }

    /// Why a fresh request was refused, phrased for whoever has to fix it.
    ///
    /// [`may_request`](Self::may_request) answers yes or no; this answers "and what do I do about
    /// it?", which is a different question and the only one anyone asks at 2am. The refusal alone
    /// ("journal refuses a fresh request for checkpoint 0") is true, unactionable, and identical
    /// across four unrelated causes.
    ///
    /// `last_applied_on_chain` is the instance's `lastAppliedCheckpoint` as the chain reports it
    /// right now, which is what separates the one cause you cannot guess from the rest — see
    /// the internal `contradicts_chain` check.
    pub fn refusal(&self, key: &WorkKey, last_applied_on_chain: Option<u64>) -> String {
        match self.status(key) {
            Status::Untouched => {
                "the journal permits this request; nothing refused it (if you are reading this, \
                 the caller and the journal disagree about `may_request`)"
                    .to_string()
            }
            Status::InFlight { request_id } => format!(
                "a proof request for this checkpoint is already out ({request_id:#x}). Requesting \
                 again is how you pay twice; wait for it to settle."
            ),
            Status::OutcomeUnknown { since, .. } => format!(
                "a request for this checkpoint was journaled at {since} and its outcome is still \
                 unknown. This is NEVER auto-retried — a human resolves it with a `Resolved` \
                 record once they have checked whether the request exists."
            ),
            Status::Settled(outcome) if self.contradicts_chain(key, last_applied_on_chain) => {
                format!(
                    "the journal says checkpoint {} of this instance was already settled \
                     ({outcome:?}), but the chain reports {}. A settled root cannot be missing \
                     from the chain that accepted it, so this journal was written against a \
                     DIFFERENT chain that happens to share id {} — a devnet that was restarted, a \
                     testnet respawn, or a config now pointing somewhere else. Instance ids and \
                     checkpoint numbers are reproducible across a chain reset, so the old records \
                     collide with the new chain's work and block it forever. Point \
                     `ops.journal_path` at a fresh file for this chain (for the local demo: `task \
                     demo:clean`).",
                    key.checkpoint_id,
                    match last_applied_on_chain {
                        Some(n) => format!("its newest applied checkpoint is {n}"),
                        None => "no root has ever been applied".to_string(),
                    },
                    key.chain_id,
                )
            }
            Status::Settled(outcome) => format!(
                "checkpoint {} was already settled ({outcome:?}) and paid work is never repeated.",
                key.checkpoint_id
            ),
            Status::Abandoned { class, attempts } => format!(
                "checkpoint {} was abandoned after {attempts} deterministic submit failures \
                 (latest class: {class:?}). Its proof remains rejected and is never retried; wait \
                 for or trigger a newer checkpoint.",
                key.checkpoint_id
            ),
        }
    }

    /// Whether this key's journal record cannot be true of the chain in front of us.
    ///
    /// A `Landed` or `Superseded` settlement is a claim about the chain: a root for this
    /// checkpoint (or a newer one) was accepted. If the chain's newest applied checkpoint is
    /// behind that — or it has never applied one at all — the two cannot both be describing the
    /// same chain.
    ///
    /// `Failed` and `Cancelled` make no such claim: they are true whatever the chain says.
    fn contradicts_chain(&self, key: &WorkKey, last_applied_on_chain: Option<u64>) -> bool {
        match self.status(key) {
            Status::Settled(Outcome::Landed | Outcome::Superseded) => {
                last_applied_on_chain.is_none_or(|applied| applied < key.checkpoint_id)
            }
            _ => false,
        }
    }

    /// Rolling spend inside `window_secs` ending at `now`, for the budget check.
    ///
    /// Counts INTENTS (the moment proving money is committed — a request that fails still cost
    /// something) plus on-chain [`Record::SubmitGas`] (H-3: gas burned by a submit, landed or
    /// reverted, is unpreventable spend the moment it broadcast). Counting settlements alone
    /// would let a run of failures spend without ever registering.
    pub fn spend(&self, instance_id: B256, now: u64, window_secs: u64) -> Spend {
        self.spend_scoped(instance_id, now, window_secs, None)
    }

    /// Rolling spend with an optional namespace for the global cap. Callers use disjoint root and
    /// signer id sets so neither workload can exhaust the other's configured loss ceiling.
    pub fn spend_scoped(
        &self,
        instance_id: B256,
        now: u64,
        window_secs: u64,
        global_scope: Option<&BTreeSet<B256>>,
    ) -> Spend {
        let floor = now.saturating_sub(window_secs);
        let mut s = Spend::default();
        let mut add = |key: &WorkKey, at: u64, cost_cents: u64| {
            if at >= floor {
                if global_scope.is_none_or(|scope| scope.contains(&key.instance_id)) {
                    s.global_cents_today = s.global_cents_today.saturating_add(cost_cents);
                }
                if key.instance_id == instance_id {
                    s.instance_cents_today = s.instance_cents_today.saturating_add(cost_cents);
                }
            }
        };
        for r in &self.records {
            match r {
                Record::Intent { key, at, cost_cents, .. } => add(key, *at, *cost_cents),
                Record::SubmitGas { key, at, cost_cents, .. } => add(key, *at, *cost_cents),
                _ => {}
            }
        }
        s
    }

    /// How many deterministic submit failures this key has accumulated, and the latest class.
    ///
    /// Legacy journals represented receipt reverts only as `SubmitGas`; those records remain
    /// first-class failure observations. A `Resolved` line clears pre-abandonment counters for
    /// backwards compatibility with the old circuit breaker, but it cannot clear the terminal
    /// [`Status::Abandoned`] disposition.
    pub fn submit_failures(&self, key: &WorkKey) -> (u32, Option<SubmitFailureClass>) {
        let mut attempts = 0u32;
        let mut latest = None;
        let mut abandoned = false;
        for r in &self.records {
            match r {
                Record::SubmitGas { key: k, reverted: true, .. } if k == key => {
                    attempts = attempts.saturating_add(1);
                    latest = Some(SubmitFailureClass::ReceiptRevert);
                }
                Record::SubmitFailure { key: k, class, .. } if k == key => {
                    attempts = attempts.saturating_add(1);
                    latest = Some(*class);
                }
                Record::Resolved { key: k, .. } if k == key => {
                    if !abandoned {
                        attempts = 0;
                        latest = None;
                    }
                }
                Record::Abandoned { key: k, .. } if k == key => abandoned = true,
                _ => {}
            }
        }
        (attempts, latest)
    }

    /// Whether this key's CID satisfied the exact publication policy now configured.
    pub fn publication_satisfied(&self, key: &WorkKey, cid: &str, policy_hash: B256) -> bool {
        self.records.iter().rev().any(|record| {
            matches!(
                record,
                Record::Published {
                    key: k,
                    cid: published_cid,
                    policy_hash: published_policy,
                    ..
                } if k == key && published_cid == cid && *published_policy == policy_hash
            )
        })
    }

    /// Failed attempts since the latest success under this exact policy. A policy change starts a
    /// fresh retry series instead of inheriting the old target set's alert/backoff history.
    pub fn publication_retry(
        &self,
        key: &WorkKey,
        cid: &str,
        policy_hash: B256,
    ) -> Option<PublicationRetry> {
        let mut retry = None;
        for record in &self.records {
            match record {
                Record::Published {
                    key: k,
                    cid: published_cid,
                    policy_hash: published_policy,
                    ..
                } if k == key && published_cid == cid && *published_policy == policy_hash => {
                    retry = None;
                }
                Record::PublicationAttempt {
                    key: k,
                    cid: attempted_cid,
                    policy_hash: attempted_policy,
                    failures,
                    at,
                    ..
                } if k == key && attempted_cid == cid && *attempted_policy == policy_hash => {
                    let attempts = retry
                        .as_ref()
                        .map_or(1, |state: &PublicationRetry| state.attempts.saturating_add(1));
                    retry = Some(PublicationRetry {
                        attempts,
                        last_at: *at,
                        failures: failures.clone(),
                    });
                }
                _ => {}
            }
        }
        retry
    }

    pub fn records(&self) -> &[Record] {
        &self.records
    }
}
