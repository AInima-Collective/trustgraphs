//! `plan(state, policy, spend) -> Action`. One pure function, no I/O, no clock.
//!
//! This is the file to read when the question is "would it have paid twice here?" or "why did it
//! sit still for a week?". Every branch is reachable from a fake chain in `tests/decide.rs`.
//!
//! The ordering below is the design, not an accident. Cheap refusals come before expensive
//! decisions, and every branch that could cost money is guarded by something read from the chain
//! in the same tick.

use crate::policy::{Policy, Spend};
use crate::types::{
    Action, CheckpointRef, HoldReason, IdleReason, InFlightState, InstanceState, SkipReason,
};
use crate::work::{CapabilityProfile, WorkProfile};

/// Decide what to do with one instance right now.
pub fn plan(state: &InstanceState, policy: &Policy, spend: Spend) -> Action {
    // 1. Things we will never do, checked before anything that costs a thought.
    if !policy.supported_programs.contains(&state.program) {
        return Action::Skip(SkipReason::UnsupportedProgram(state.program));
    }
    let raw_bound = WorkProfile::from_raw_bounds(state.program, state.size);
    if let Err(violation) = CapabilityProfile::default().check(raw_bound) {
        return Action::Skip(SkipReason::CapabilityExceeded {
            profile_version: violation.profile_version,
            dimension: violation.dimension,
            observed: violation.observed,
            limit: violation.limit,
        });
    }
    let cycles = state.size.estimated_cycles(state.program);
    if cycles > policy.cycle_limit {
        return Action::Skip(SkipReason::TooLarge {
            estimated_cycles: cycles,
            limit: policy.cycle_limit,
        });
    }

    // 2. Holds: the instance is fine, we are not writing to it right now.
    if state.paused {
        return Action::Hold(HoldReason::Paused);
    }
    if let Some(breach) = policy.loss_budget.exceeded_by(spend) {
        return Action::Hold(HoldReason::LossBudget(breach));
    }
    // Only the VERIFIER matters here now. A params rotation used to invalidate in-flight work;
    // since M0 pinned `paramsHash` per checkpoint it cannot, so the guard's remaining job is
    // verifier rotations (which MUST invalidate in-flight proofs — that is the SP1-soundness
    // emergency path) and pauses.
    if state.zk_verifier != state.expected_zk_verifier {
        return Action::Hold(HoldReason::VerifierRotated {
            on_chain: state.zk_verifier,
            expected: state.expected_zk_verifier,
        });
    }
    if state.rotation_pending {
        return Action::Hold(HoldReason::RotationPending);
    }

    // 3. Work already paid for. Finish it, abandon it, or wait — never start a second one.
    if let Some(flight) = &state.in_flight {
        // Someone landed a newer root while we were proving. Not a failure: monotonic
        // `submitProof` + input-freeze-block filing is exactly what makes N operators compose.
        if state.last_applied_checkpoint.is_some_and(|last| flight.checkpoint_id <= last) {
            return Action::Idle(IdleReason::Superseded { checkpoint_id: flight.checkpoint_id });
        }
        return match flight.state {
            InFlightState::OutcomeUnknown => Action::Hold(HoldReason::RequestOutcomeUnknown {
                checkpoint_id: flight.checkpoint_id,
            }),
            InFlightState::Proving => {
                Action::Idle(IdleReason::Proving { checkpoint_id: flight.checkpoint_id })
            }
            InFlightState::AwaitingPublication => {
                Action::Publish { checkpoint_id: flight.checkpoint_id }
            }
            InFlightState::PublicationBackoff { attempts, retry_at } => {
                Action::Idle(IdleReason::PublicationBackoff {
                    checkpoint_id: flight.checkpoint_id,
                    attempts,
                    retry_at,
                })
            }
            InFlightState::Ready => submit_or_hold(state, policy, flight.checkpoint_id),
        };
    }

    // 4. A checkpoint is waiting to be proven. Coalescing means only the newest one ever is.
    if let Some(cp) = state.newest_unproven() {
        return prove_or_wait(state, policy, cp);
    }

    // 5. Nothing frozen. Should we freeze something?
    trigger_or_idle(state, policy)
}

fn submit_or_hold(state: &InstanceState, policy: &Policy, checkpoint_id: u64) -> Action {
    if state.basefee_wei > policy.max_basefee_wei {
        return Action::Hold(HoldReason::Basefee {
            basefee_wei: state.basefee_wei,
            cap_wei: policy.max_basefee_wei,
        });
    }
    Action::Submit { checkpoint_id }
}

fn prove_or_wait(state: &InstanceState, policy: &Policy, cp: &CheckpointRef) -> Action {
    // A checkpoint `trigger()` did not mint has no pinned params and can never be proven
    // (`UnpinnedCheckpoint`). Since M0 bound every accumulator to its snapshot this is
    // unreachable in production; if we see it, something minted a checkpoint out of band and
    // proving it would be pure waste.
    let Some(pinned) = cp.pinned_params_hash else {
        return Action::Skip(SkipReason::UnpinnedCheckpoint { checkpoint_id: cp.id });
    };
    // The pinned value is what the digest will be built from, so it — not the live `paramsHash` —
    // is what our reconstruction has to match. This is what makes a rotation mid-flight free.
    if pinned != state.reconstructed_params_hash {
        return Action::Skip(SkipReason::ParamsMismatch {
            on_chain: pinned,
            reconstructed: state.reconstructed_params_hash,
        });
    }

    // Do not spend on a checkpoint a reorg could erase.
    let confirmations = state.head_block.saturating_sub(cp.block_number);
    if confirmations < policy.confirmations {
        return Action::AwaitFinality {
            checkpoint_id: cp.id,
            confirmations,
            required: policy.confirmations,
        };
    }

    // Money, last: a prover must never discover mid-flight that it will not be paid.
    //
    // Only for instances that DRAW a vault. A curated instance is proven on us, and a self-proving
    // run has no vault at all — holding either of them for "unfunded" would be the operator
    // refusing to do the thing it was started to do.
    if policy.requires_vault {
        match state.vault {
            None => return Action::Hold(HoldReason::Unfunded { reason: 1 /* NoAccount */ }),
            Some(v) if !v.eligible => {
                return Action::Hold(HoldReason::Unfunded { reason: v.reason })
            }
            Some(_) => {}
        }
    }

    Action::Prove { checkpoint_id: cp.id }
}

fn trigger_or_idle(state: &InstanceState, policy: &Policy) -> Action {
    if let Some(cp) = state
        .checkpoints
        .iter()
        .filter(|c| state.last_applied_checkpoint.is_none_or(|last| c.id > last))
        .max_by_key(|c| c.id)
        .filter(|c| state.abandoned_checkpoints.contains(&c.id))
    {
        if !state.live_commitments.differs_in(&cp.commitments, state.program.consumes()) {
            return Action::Idle(IdleReason::AwaitingNewInputs { checkpoint_id: cp.id });
        }
    }

    // Quiet is free. An instance with no new edges costs nothing, forever.
    if state.is_quiet() {
        return Action::Idle(IdleReason::Quiet);
    }

    // The contract-fixed boundary, judged against the block a transaction sent now would run in.
    if state.epoch_length > 0 {
        let boundary = state.last_trigger_block.saturating_add(state.epoch_length);
        if state.next_block() < boundary {
            return Action::Idle(IdleReason::EpochNotElapsed {
                next_block: state.next_block(),
                boundary,
            });
        }
    }

    // Our own cadence for a curated instance, on top of the contract's. `EPOCH_FLOOR` bounds
    // creation only: `setEpochLength` is constitutional, so any creator can lower their own epoch
    // afterwards and the contract's gate is not a bound on what we choose to pay for.
    if policy.curated && policy.subsidy_min_blocks > 0 {
        let subsidy_boundary = state.last_trigger_block.saturating_add(policy.subsidy_min_blocks);
        if state.next_block() < subsidy_boundary {
            return Action::Idle(IdleReason::SubsidyCadence {
                next_block: state.next_block(),
                boundary: subsidy_boundary,
            });
        }
    }

    if state.basefee_wei > policy.max_basefee_wei {
        return Action::Hold(HoldReason::Basefee {
            basefee_wei: state.basefee_wei,
            cap_wei: policy.max_basefee_wei,
        });
    }

    // Last: would the checkpoint we are about to mint be provable BY US?
    //
    // `trigger()` pins the LIVE `paramsHash`, so if our reconstruction cannot reproduce that
    // value, the checkpoint we mint is one we can never prove — we would pay gas to create work
    // for someone else. This is deliberately the only place the live hash is compared. Comparing
    // it up front instead would strand an instance forever after any rotation: the reconstruction
    // comes from the immutable `InstanceCreated` event, so it can never match a rotated live hash
    // again, and the already-pinned checkpoint that IS still provable would never get proven —
    // exactly the waste pinning exists to prevent.
    if state.params_hash != state.reconstructed_params_hash {
        return Action::Skip(SkipReason::ParamsMismatch {
            on_chain: state.params_hash,
            reconstructed: state.reconstructed_params_hash,
        });
    }

    Action::Trigger
}

/// Whether an action spends anything. Used by the daemon to decide what to journal before acting.
pub fn spends(action: &Action) -> bool {
    matches!(action, Action::Trigger | Action::Prove { .. } | Action::Submit { .. })
}

/// Whether an action is a terminal refusal for this tick (as opposed to progress).
pub fn is_refusal(action: &Action) -> bool {
    matches!(action, Action::Skip(_) | Action::Hold(_))
}

/// Whether an action should raise an alert rather than just a log line.
///
/// Idle is normal. A skip or a hold is a human-visible condition — except the two that are simply
/// "we are not the ones acting right now".
pub fn alerts(action: &Action) -> bool {
    match action {
        Action::Hold(HoldReason::Basefee { .. }) => false,
        Action::Skip(_) | Action::Hold(_) => true,
        _ => false,
    }
}
