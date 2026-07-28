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
                    status = Status::OutcomeUnknown {
                        public_values_hash: *public_values_hash,
                        vk_hash: *vk_hash,
                        since: *at,
                    };
                }
                Record::Requested { key: k, request_id, .. } if k == key => {
                    status = Status::InFlight { request_id: *request_id };
                }
                Record::Resolved { key: k, request_id, .. } if k == key => {
                    status = match request_id {
                        Some(id) => Status::InFlight { request_id: *id },
                        // A human confirmed nothing was created. Safe to start over.
                        None => Status::Untouched,
                    };
                }
                Record::Settled { key: k, outcome, .. } if k == key => {
                    status = Status::Settled(*outcome);
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

    /// Rolling spend inside `window_secs` ending at `now`, for the budget check.
    ///
    /// Counts INTENTS, not settlements: an intent is the moment money is committed, and a request
    /// that fails still cost something. Counting settlements would let a run of failures spend
    /// without ever registering.
    pub fn spend(&self, instance_id: B256, now: u64, window_secs: u64) -> Spend {
        let floor = now.saturating_sub(window_secs);
        let mut s = Spend::default();
        for r in &self.records {
            if let Record::Intent { key, at, cost_cents, .. } = r {
                if *at >= floor {
                    s.global_cents_today = s.global_cents_today.saturating_add(*cost_cents);
                    if key.instance_id == instance_id {
                        s.instance_cents_today = s.instance_cents_today.saturating_add(*cost_cents);
                    }
                }
            }
        }
        s
    }

    pub fn records(&self) -> &[Record] {
        &self.records
    }
}
