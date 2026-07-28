//! The mandatory re-read before spending, and again before submitting.
//!
//! A creator-admin can rotate an instance's configuration one block after any preflight, so the
//! question is not "can we make spend safe?" — we cannot — but "what is still worth re-checking at
//! the last possible moment, and what has M0 made moot?".
//!
//! M0 made the params rotation moot: `trigger()` pins `paramsHash` per checkpoint, so a rotation
//! between trigger and submit no longer invalidates work in flight. What is left:
//!
//! - **The verifier.** Deliberately NOT pinned, because rotating it is the emergency response to
//!   an SP1 soundness bug (`UPGRADE_GOVERNANCE.md` §5.5). It must invalidate in-flight proofs, so
//!   we must notice it before broadcasting one.
//! - **Pauses / freezes.** A submit into a paused instance is a wasted transaction.
//! - **A pending timelock operation.** Best-effort only: factory instances are creator-admin'd and
//!   have no timelock at all, so absence of a queued operation proves nothing. Treat a hit as a
//!   reason to wait and a miss as no information.

use alloy_primitives::{Address, B256};
use serde::{Deserialize, Serialize};

/// What the guard reads, immediately before acting.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct GuardRead {
    pub params_hash: B256,
    pub zk_verifier: Address,
    pub paused: bool,
    /// `None` when the instance has no timelock to probe (the factory case). `Some(false)` is
    /// evidence; `None` is not.
    pub pending_timelock_op: Option<bool>,
}

/// What the guard concluded.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", tag = "verdict")]
pub enum Verdict {
    /// Go.
    Clear,
    /// The verifier moved under us. Anything in flight is void.
    VerifierRotated {
        was: Address,
        now: Address,
    },
    Paused,
    /// A queued admin operation. Wait for it to land or be cancelled.
    RotationPending,
}

impl Verdict {
    pub fn is_clear(self) -> bool {
        matches!(self, Verdict::Clear)
    }
}

/// Re-read before requesting a proof.
///
/// `expected_verifier` is the one whose vkey this binary's guest satisfies.
pub fn before_spend(read: GuardRead, expected_verifier: Address) -> Verdict {
    if read.paused {
        return Verdict::Paused;
    }
    if read.zk_verifier != expected_verifier {
        return Verdict::VerifierRotated { was: expected_verifier, now: read.zk_verifier };
    }
    if read.pending_timelock_op == Some(true) {
        return Verdict::RotationPending;
    }
    Verdict::Clear
}

/// Re-read before broadcasting a submit.
///
/// Same checks minus the timelock probe: by this point the proof is already paid for, so a queued
/// operation that may or may not touch this instance is not a reason to sit on a finished root. If
/// it does land first, the submit reverts and costs gas, which is strictly cheaper than the proof
/// we would otherwise have thrown away.
pub fn before_submit(read: GuardRead, expected_verifier: Address) -> Verdict {
    if read.paused {
        return Verdict::Paused;
    }
    if read.zk_verifier != expected_verifier {
        return Verdict::VerifierRotated { was: expected_verifier, now: read.zk_verifier };
    }
    Verdict::Clear
}

/// Classify a revert we got back from a submit, so the daemon reacts correctly rather than
/// uniformly.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SubmitOutcome {
    /// The root landed.
    Landed,
    /// `StaleCheckpoint`: someone landed a newer root. This is SUCCESS. The scores are fresh; we
    /// simply were not the ones who refreshed them, which is what monotonic `submitProof` and
    /// input-freeze-block filing exist to make safe.
    Superseded,
    /// A pause-shaped revert. Hold and alert; do not retry in a loop.
    Paused,
    /// `UnpinnedCheckpoint`: the checkpoint was minted outside `trigger()`. Skip and alert.
    Unpinned,
    /// Anything else. Alert; a human decides.
    Failed,
}
