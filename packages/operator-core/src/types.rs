//! The chain-shaped facts the decision engine reads, and nothing else.
//!
//! Everything here is a plain value. The engine never calls out; a caller assembles an
//! [`InstanceState`] from chain reads and hands it over. That is what makes every branch in
//! `decide` testable against a fake chain instead of a live one.

use alloy_primitives::{Address, B256};
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;

/// Which SP1 program owns an instance. The id is `keccak256(name)`, matching the
/// `InstanceRegistry` record's `program` field.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Program {
    // This is a deployed program id and a persisted manifest value. Renaming the Rust variant must
    // not change the wire string.
    #[serde(rename = "trust-graph")]
    Trustgraphs,
    Contributions,
    #[serde(rename = "trust-graph-weighted")]
    Weighted,
    Hypercerts,
    Signer,
}

impl Program {
    /// The registry's `program` id.
    pub fn id(self) -> B256 {
        alloy_primitives::keccak256(self.name().as_bytes())
    }

    pub fn name(self) -> &'static str {
        match self {
            Program::Trustgraphs => "trust-graph",
            Program::Contributions => "contributions",
            Program::Weighted => "trust-graph-weighted",
            Program::Hypercerts => "hypercerts",
            Program::Signer => "signer-sync",
        }
    }

    pub fn from_id(id: B256) -> Option<Self> {
        [
            Program::Trustgraphs,
            Program::Contributions,
            Program::Weighted,
            Program::Hypercerts,
            Program::Signer,
        ]
        .into_iter()
        .find(|p| p.id() == id)
    }

    /// Which journal slots this program's guest actually consumes.
    ///
    /// Readiness is program-specific and a generic `leafCount` comparison is wrong twice over:
    /// `EmptyLaneAccumulator.leafCount()` is `pure returns (0)` forever, so a lane-2-only instance
    /// would look permanently quiet; and a contributions instance can move while its mirrored
    /// lane-1 (the vouch graph) is silent, so it would look quiet while a whole round closed.
    pub fn consumes(self) -> Lanes {
        match self {
            // Lane 2 only matters when an anchor registry is wired; when it is not, the
            // checkpoint's lane-2 slot is the constant zero pair and comparing it is harmless.
            Program::Trustgraphs => Lanes { lane1: true, lane2: true },
            // Slot A = trust (mirrored), slot B = contributions. Both move independently.
            Program::Contributions => Lanes { lane1: true, lane2: true },
            // The personalized prior program consumes the EAS accumulator only. Its common
            // journal-v3 lane-two words are constitutionally zero.
            Program::Weighted => Lanes { lane1: true, lane2: false },
            // Lane 1 is the EmptyLaneAccumulator: constant (0, 0) forever.
            Program::Hypercerts => Lanes { lane1: false, lane2: true },
            Program::Signer => Lanes { lane1: true, lane2: false },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::Program;

    #[test]
    fn trustgraphs_variant_keeps_the_deployed_program_name() {
        assert_eq!(serde_json::to_string(&Program::Trustgraphs).unwrap(), r#""trust-graph""#);
        assert_eq!(
            serde_json::from_str::<Program>(r#""trust-graph""#).unwrap(),
            Program::Trustgraphs
        );
    }

    #[test]
    fn weighted_variant_uses_the_isolated_deployed_program_name() {
        assert_eq!(Program::Weighted.name(), "trust-graph-weighted");
        assert_eq!(
            serde_json::from_str::<Program>(r#""trust-graph-weighted""#).unwrap(),
            Program::Weighted
        );
        assert_eq!(Program::from_id(Program::Weighted.id()), Some(Program::Weighted));
        assert_eq!(Program::Weighted.consumes(), super::Lanes { lane1: true, lane2: false });
    }
}

/// Which of the two journal slots a program reads.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Lanes {
    pub lane1: bool,
    pub lane2: bool,
}

/// The input commitments a checkpoint freezes — the pair `submitProof` binds into the journal.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Commitments {
    pub acc: B256,
    pub leaf_count: u64,
    pub anchor_acc: B256,
    pub anchor_count: u64,
}

impl Commitments {
    /// Whether the slots THIS program consumes differ. Slots it ignores are not "movement".
    pub fn differs_in(&self, other: &Commitments, lanes: Lanes) -> bool {
        (lanes.lane1 && (self.acc != other.acc || self.leaf_count != other.leaf_count))
            || (lanes.lane2
                && (self.anchor_acc != other.anchor_acc || self.anchor_count != other.anchor_count))
    }
}

/// A checkpoint as the chain describes it.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct CheckpointRef {
    pub id: u64,
    /// The block the inputs froze at. Roots file here, not at the submission block.
    pub block_number: u64,
    pub commitments: Commitments,
    /// The `paramsHash` `trigger()` pinned. `None` = never pinned, which since M0 means the
    /// checkpoint was minted outside `trigger()` and can never be proven (`UnpinnedCheckpoint`).
    pub pinned_params_hash: Option<B256>,
}

/// A proof we have already started paying for.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct InFlight {
    pub checkpoint_id: u64,
    /// The backend's handle. `None` while the request outcome is still unknown — see
    /// [`crate::journal`].
    pub request_id: Option<B256>,
    pub state: InFlightState,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum InFlightState {
    /// Requested, still proving.
    Proving,
    /// The proof is in hand and byte-checked against the native journal.
    Ready,
    /// The proof and canonical score blob are held, but the configured publication minimum has
    /// not yet been met. Publishing is retryable and must precede submission.
    AwaitingPublication,
    /// A persisted publication attempt failed; wait until `retry_at` instead of alert-looping.
    PublicationBackoff { attempts: u32, retry_at: u64 },
    /// The request was made but we cannot tell what happened to it. Never auto-retried.
    OutcomeUnknown,
}

/// What the vault would pay for the next root on this instance. `None` for a curated instance,
/// which never draws a vault at all.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct VaultView {
    /// False when the cadence guard, the per-root cap, or an empty tank would pay nothing.
    pub eligible: bool,
    /// Combined value the account can actually cover right now, in USD scaled by 1e8 — the same
    /// units `IProvingVault.Quote.payableUsd` reports. Named `_wei` in an earlier draft, which
    /// pre-loaded a 1e10 scale error into an adapter nobody had written yet.
    pub payable_usd: u128,
    /// The vault's machine-readable ineligibility code (`IProvingVault.IneligibleReason`).
    pub reason: u8,
}

/// How big this instance's next proof would be, for the cycle-limit gate and the fee band.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct InstanceSize {
    pub leaf_count: u64,
    pub anchor_count: u64,
}

impl InstanceSize {
    /// A deliberately crude upper bound on guest cycles, used only to refuse instances we cannot
    /// prove at all. Being wrong here costs a skip, not money; being absent costs a timed-out
    /// request we paid for.
    pub fn estimated_cycles(&self, per_input_cycles: u64, base_cycles: u64) -> u64 {
        base_cycles.saturating_add(
            self.leaf_count.saturating_add(self.anchor_count).saturating_mul(per_input_cycles),
        )
    }
}

/// Everything the engine needs about one instance at one moment.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct InstanceState {
    pub instance_id: B256,
    pub program: Program,
    pub snapshot: Address,

    /// Chain head as of this tick.
    pub head_block: u64,
    /// Current basefee, in wei.
    pub basefee_wei: u128,

    /// `0` = unscheduled, which hands epoch boundaries back to whoever calls `trigger()`.
    pub epoch_length: u64,
    pub last_trigger_block: u64,

    /// Known checkpoints, ascending by id. Only the newest unproven one is ever proved.
    pub checkpoints: Vec<CheckpointRef>,
    /// Checkpoints whose held proof deterministically reverted enough times to be terminally
    /// abandoned by this operator. Persisted in the request journal and projected into the pure
    /// planning state on every tick/restart.
    pub abandoned_checkpoints: BTreeSet<u64>,
    /// `None` = no root has ever been applied.
    pub last_applied_checkpoint: Option<u64>,

    /// The snapshot's live `paramsHash`.
    pub params_hash: B256,
    /// What OUR reconstruction of this instance's params hashes to. A mismatch means the chain and
    /// the reconstruction disagree about what this instance computes.
    pub reconstructed_params_hash: B256,

    /// The snapshot's live `zkVerifier`.
    pub zk_verifier: Address,
    /// The verifier whose vkey our guest binary can satisfy. Deliberately not pinned per
    /// checkpoint: a verifier rotation is the SP1-soundness emergency path.
    pub expected_zk_verifier: Address,

    /// A pause, freeze, or any other "do not write" signal read off the instance.
    pub paused: bool,
    /// A queued operation on the instance's admin timelock. Best-effort: factory instances are
    /// creator-admin'd and have no timelock, so absence proves nothing.
    pub rotation_pending: bool,

    /// The live input commitments, for the quiet check.
    pub live_commitments: Commitments,
    pub size: InstanceSize,
    /// The earliest authenticated input ceiling the operator must alert against. New bounded
    /// anchor registries publish their immutable cap; legacy/no-lane-2 instances use the global
    /// vault/operator ceiling.
    pub input_capacity: u64,

    pub in_flight: Option<InFlight>,
    pub vault: Option<VaultView>,
}

impl InstanceState {
    /// The newest checkpoint no root has been applied for.
    ///
    /// Coalescing lives here: `submitProof` is monotonic, so intermediate checkpoints can be
    /// skipped forever. A `trigger()` spam run therefore costs the spammer gas and us nothing.
    pub fn newest_unproven(&self) -> Option<&CheckpointRef> {
        let newest = self
            .checkpoints
            .iter()
            .filter(|c| self.last_applied_checkpoint.is_none_or(|last| c.id > last))
            .max_by_key(|c| c.id)?;
        // Do not fall back to an older checkpoint: coalescing says only the newest immutable
        // snapshot is relevant. If that newest one is abandoned, the next safe action is to
        // freeze a newer snapshot after input movement, never to resurrect older paid work.
        (!self.abandoned_checkpoints.contains(&newest.id)).then_some(newest)
    }

    /// The commitments the last applied root was computed over. `None` = no root yet.
    pub fn applied_commitments(&self) -> Option<Commitments> {
        let last = self.last_applied_checkpoint?;
        self.checkpoints.iter().find(|c| c.id == last).map(|c| c.commitments)
    }

    /// Nothing this program reads has moved since the last root landed.
    pub fn is_quiet(&self) -> bool {
        match self.applied_commitments() {
            None => false, // never proven: there is always a first root to produce
            Some(applied) => !self.live_commitments.differs_in(&applied, self.program.consumes()),
        }
    }

    /// The block a transaction sent now would execute in, at the earliest. Epoch arithmetic is
    /// judged against this and not `head_block`, or every boundary is missed by one tick.
    pub fn next_block(&self) -> u64 {
        self.head_block.saturating_add(1)
    }
}

/// What the daemon should do with an instance this tick.
///
/// The closed list matters: anything not here, the operator does not do. In particular there is no
/// "retry" — a request whose outcome we cannot determine is surfaced to a human, because the
/// failure mode of retrying it is paying twice for one checkpoint.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", tag = "action")]
pub enum Action {
    /// Nothing to do, and nothing wrong. Free.
    Idle(IdleReason),
    /// Freeze a checkpoint: `snapshot.trigger()`.
    Trigger,
    /// The checkpoint exists but is not confirmed enough to spend on yet.
    AwaitFinality { checkpoint_id: u64, confirmations: u64, required: u64 },
    /// Request a proof for this checkpoint.
    Prove { checkpoint_id: u64 },
    /// Publish the held canonical score blob to the configured durability targets.
    Publish { checkpoint_id: u64 },
    /// Land a proof we already hold.
    Submit { checkpoint_id: u64 },
    /// The instance is fine; we are not writing to it right now. Recoverable, alertable.
    Hold(HoldReason),
    /// This instance is not ours to prove, or cannot be proven as configured. Per-instance: the
    /// rest of the run continues.
    Skip(SkipReason),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", tag = "idle")]
pub enum IdleReason {
    /// Nothing this program reads has moved since the last root. The common case, and free.
    Quiet,
    /// The contract-fixed epoch boundary has not passed.
    EpochNotElapsed { next_block: u64, boundary: u64 },
    /// The contract would allow a trigger, but our own subsidy cadence would not.
    SubsidyCadence { next_block: u64, boundary: u64 },
    /// A proof is being computed.
    Proving { checkpoint_id: u64 },
    /// Someone landed a newer root while we were proving. Not a failure.
    Superseded { checkpoint_id: u64 },
    /// Publication failed and is durably queued for a later retry.
    PublicationBackoff { checkpoint_id: u64, attempts: u32, retry_at: u64 },
    /// The newest checkpoint was abandoned, but no consumed input has moved since it froze.
    /// Triggering now would either revert `NoNewInputs` or recreate the same rejected statement.
    AwaitingNewInputs { checkpoint_id: u64 },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", tag = "hold")]
pub enum HoldReason {
    Paused,
    Basefee {
        basefee_wei: u128,
        cap_wei: u128,
    },
    /// The deployed verifier is not the one our guest satisfies. Deliberately fatal to in-flight
    /// work: a verifier rotation is the response to an SP1 soundness bug.
    VerifierRotated {
        on_chain: Address,
        expected: Address,
    },
    /// A queued operation on the instance's admin timelock. Best-effort — factory instances are
    /// creator-admin'd and have no timelock, so this is a signal when present, not an assurance
    /// when absent.
    RotationPending,
    LossBudget(crate::policy::BudgetBreach),
    /// A proof request was made and we cannot determine what became of it. NEVER auto-retried.
    RequestOutcomeUnknown {
        checkpoint_id: u64,
    },
    /// Not curated, and the vault will not cover this root. `reason` is
    /// `IProvingVault.IneligibleReason`. Stop and say so rather than silently subsidizing.
    Unfunded {
        reason: u8,
    },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", tag = "skip")]
pub enum SkipReason {
    UnsupportedProgram(Program),
    TooLarge {
        estimated_cycles: u64,
        limit: u64,
    },
    /// Our reconstruction of this instance's params does not hash to what the chain pinned.
    ParamsMismatch {
        on_chain: B256,
        reconstructed: B256,
    },
    /// A checkpoint minted outside `trigger()`, so `submitProof` would revert `UnpinnedCheckpoint`.
    UnpinnedCheckpoint {
        checkpoint_id: u64,
    },
    /// The chain cannot describe this instance and no manifest entry does either. The detail
    /// lives in [`crate::catalog::SkipCause`], which is what produced it; this variant only has to
    /// tell the daemon not to act.
    Undescribable,
}
