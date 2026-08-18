//! Every `Action` branch, against a fake chain.
//!
//! The GOAL's M1 exit list, one test each: quiet instance, epoch not elapsed, coalesce over three
//! unproven checkpoints, params mismatch skips one instance and leaves the rest running, verifier
//! rotation pending, basefee spike, unfinalized checkpoint, loss budget exceeded, and
//! crash-restart replay in all three journal states (the last in `tests/journal.rs`).

use alloy_primitives::{address, b256, Address, B256};
use operator_core::journal::{Journal, Record, Status, SubmitFailureClass, WorkKey};
use operator_core::policy::{BudgetBreach, LossBudget};
use operator_core::types::{
    Action, CheckpointRef, Commitments, HoldReason, IdleReason, InFlight, InFlightState,
    InstanceSize, InstanceState, Program, SkipReason, VaultView,
};
use operator_core::{plan, Policy, Spend};

const SNAPSHOT: Address = address!("00000000000000000000000000000000000000A1");
const VERIFIER: Address = address!("00000000000000000000000000000000000000B1");
const PARAMS: B256 = b256!("1111111111111111111111111111111111111111111111111111111111111111");

fn commitments(n: u64) -> Commitments {
    Commitments {
        acc: B256::from(alloy_primitives::U256::from(n)),
        leaf_count: n,
        anchor_acc: B256::ZERO,
        anchor_count: 0,
    }
}

fn checkpoint(id: u64, block: u64, n: u64) -> CheckpointRef {
    CheckpointRef {
        id,
        block_number: block,
        commitments: commitments(n),
        pinned_params_hash: Some(PARAMS),
    }
}

/// A healthy trust-graph instance with one unproven, finalized checkpoint waiting.
fn healthy() -> InstanceState {
    InstanceState {
        instance_id: B256::from([0x01; 32]),
        program: Program::Trustgraphs,
        snapshot: SNAPSHOT,
        head_block: 1_000,
        basefee_wei: 5_000_000_000, // 5 gwei
        epoch_length: 100,
        last_trigger_block: 900,
        checkpoints: vec![checkpoint(0, 900, 3)],
        abandoned_checkpoints: Default::default(),
        last_applied_checkpoint: None,
        params_hash: PARAMS,
        reconstructed_params_hash: PARAMS,
        zk_verifier: VERIFIER,
        expected_zk_verifier: VERIFIER,
        paused: false,
        rotation_pending: false,
        live_commitments: commitments(3),
        size: InstanceSize { leaf_count: 3, anchor_count: 0, authenticated_cycles: None },
        input_capacity: operator_core::policy::MAX_PRICED_INPUTS,
        in_flight: None,
        vault: None,
    }
}

fn curated() -> Policy {
    // Subsidy cadence off for most tests: it is exercised on its own below, and leaving it on
    // would mask every other trigger branch behind it.
    Policy { subsidy_min_blocks: 0, ..Policy::curated() }
}

// ---------------------------------------------------------------------------
// The happy path, so every refusal below is measured against something that works.
// ---------------------------------------------------------------------------

#[test]
fn a_ready_checkpoint_is_proved() {
    assert_eq!(plan(&healthy(), &curated(), Spend::default()), Action::Prove { checkpoint_id: 0 });
}

#[test]
fn a_ready_proof_is_submitted() {
    let mut s = healthy();
    s.in_flight = Some(InFlight {
        checkpoint_id: 0,
        request_id: Some(B256::from([0xAA; 32])),
        state: InFlightState::Ready,
    });
    assert_eq!(plan(&s, &curated(), Spend::default()), Action::Submit { checkpoint_id: 0 });
}

#[test]
fn a_held_proof_waiting_for_publication_is_published_before_submit() {
    let mut s = healthy();
    s.in_flight = Some(InFlight {
        checkpoint_id: 0,
        request_id: Some(B256::from([0xAA; 32])),
        state: InFlightState::AwaitingPublication,
    });
    assert_eq!(plan(&s, &curated(), Spend::default()), Action::Publish { checkpoint_id: 0 });
}

#[test]
fn a_failed_publication_waits_for_its_persisted_retry_time() {
    let mut s = healthy();
    s.in_flight = Some(InFlight {
        checkpoint_id: 0,
        request_id: Some(B256::from([0xAA; 32])),
        state: InFlightState::PublicationBackoff { attempts: 3, retry_at: 1_234 },
    });
    assert_eq!(
        plan(&s, &curated(), Spend::default()),
        Action::Idle(IdleReason::PublicationBackoff {
            checkpoint_id: 0,
            attempts: 3,
            retry_at: 1_234,
        })
    );
}

#[test]
fn an_abandoned_ready_checkpoint_advances_without_resurrecting_its_proof() {
    let mut s = healthy();
    let request_id = B256::from([0xAA; 32]);
    s.in_flight = Some(InFlight {
        checkpoint_id: 0,
        request_id: Some(request_id),
        state: InFlightState::Ready,
    });
    assert_eq!(plan(&s, &curated(), Spend::default()), Action::Submit { checkpoint_id: 0 });

    // Three deterministic preflight reverts terminally abandon this immutable checkpoint. The
    // disposition survives the exact restart boundary that used to resurrect the held proof.
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("journal.jsonl");
    let key = WorkKey { chain_id: 31337, instance_id: s.instance_id, checkpoint_id: 0 };
    {
        let mut journal = Journal::open(&path).unwrap();
        journal
            .append(Record::Intent {
                key,
                public_values_hash: B256::from([0x77; 32]),
                vk_hash: B256::from([0x88; 32]),
                at: 1,
                cost_cents: 100,
            })
            .unwrap();
        journal.append(Record::Requested { key, request_id, at: 2 }).unwrap();
        for at in 3..=5 {
            journal
                .append(Record::SubmitFailure {
                    key,
                    class: SubmitFailureClass::SimulationRevert,
                    at,
                })
                .unwrap();
        }
        journal
            .append(Record::Abandoned {
                key,
                class: SubmitFailureClass::SimulationRevert,
                attempts: 3,
                at: 5,
            })
            .unwrap();
    }
    let journal = Journal::open(&path).unwrap();
    assert!(matches!(journal.status(&key), Status::Abandoned { attempts: 3, .. }));

    // The restarted journal projection removes only checkpoint 0 from the actionable set. Its
    // rejected proof is not changed into success, resubmitted, or asked for again.
    s.in_flight = None;
    if matches!(journal.status(&key), Status::Abandoned { .. }) {
        s.abandoned_checkpoints.insert(0);
    }
    s.live_commitments = commitments(4);
    assert_eq!(plan(&s, &curated(), Spend::default()), Action::Trigger);

    // Once the fresh checkpoint exists, normal coalescing selects it and never falls back to 0.
    s.checkpoints.push(checkpoint(1, 1_001, 4));
    s.head_block = 1_001 + curated().confirmations;
    assert_eq!(plan(&s, &curated(), Spend::default()), Action::Prove { checkpoint_id: 1 });
}

#[test]
fn an_abandoned_checkpoint_waits_for_input_movement_instead_of_trigger_looping() {
    let mut s = healthy();
    s.abandoned_checkpoints.insert(0);
    assert_eq!(
        plan(&s, &curated(), Spend::default()),
        Action::Idle(IdleReason::AwaitingNewInputs { checkpoint_id: 0 })
    );
}

// ---------------------------------------------------------------------------
// Quiet is free.
// ---------------------------------------------------------------------------

#[test]
fn an_instance_with_no_new_edges_costs_nothing() {
    let mut s = healthy();
    s.last_applied_checkpoint = Some(0);
    s.live_commitments = commitments(3); // identical to what checkpoint 0 froze
    assert_eq!(plan(&s, &curated(), Spend::default()), Action::Idle(IdleReason::Quiet));
}

#[test]
fn a_never_proven_instance_is_not_quiet() {
    // No root has ever landed, so there is always a first one to produce — even with an empty
    // graph. "Quiet" means "nothing changed since the last root", and there is no last root.
    let mut s = healthy();
    s.checkpoints.clear();
    s.live_commitments = Commitments::default();
    assert_eq!(plan(&s, &curated(), Spend::default()), Action::Trigger);
}

#[test]
fn lane_2_movement_wakes_a_hypercerts_instance_whose_lane_1_never_moves() {
    // The trap this exists for: `EmptyLaneAccumulator.leafCount()` is `pure returns (0)` forever,
    // so a generic leafCount comparison would call this instance permanently quiet.
    let mut s = healthy();
    s.program = Program::Hypercerts;
    s.checkpoints = vec![CheckpointRef {
        id: 0,
        block_number: 900,
        commitments: Commitments {
            acc: B256::ZERO,
            leaf_count: 0,
            anchor_acc: B256::from([0x11; 32]),
            anchor_count: 4,
        },
        pinned_params_hash: Some(PARAMS),
    }];
    s.last_applied_checkpoint = Some(0);
    // Lane 1 is still (0, 0) — as it always will be — but lane 2 gained an anchor.
    s.live_commitments = Commitments {
        acc: B256::ZERO,
        leaf_count: 0,
        anchor_acc: B256::from([0x22; 32]),
        anchor_count: 5,
    };
    let mut p = curated();
    p.supported_programs.insert(Program::Hypercerts);
    assert_eq!(plan(&s, &p, Spend::default()), Action::Trigger);
}

#[test]
fn a_contributions_round_moves_while_its_mirrored_vouch_graph_is_silent() {
    // The other half of the same trap: slot A (trust, mirrored) is unchanged, slot B
    // (contributions) gained records. A lane-1-only readiness check would sleep through a round.
    let mut s = healthy();
    s.program = Program::Contributions;
    s.checkpoints = vec![CheckpointRef {
        id: 0,
        block_number: 900,
        commitments: Commitments {
            acc: B256::from([0x33; 32]),
            leaf_count: 7,
            anchor_acc: B256::from([0x44; 32]),
            anchor_count: 2,
        },
        pinned_params_hash: Some(PARAMS),
    }];
    s.last_applied_checkpoint = Some(0);
    s.live_commitments = Commitments {
        acc: B256::from([0x33; 32]), // vouch graph unchanged
        leaf_count: 7,
        anchor_acc: B256::from([0x55; 32]), // three more contribution records
        anchor_count: 5,
    };
    assert_eq!(plan(&s, &curated(), Spend::default()), Action::Trigger);
}

// ---------------------------------------------------------------------------
// Cadence.
// ---------------------------------------------------------------------------

#[test]
fn epoch_not_elapsed_is_idle_not_a_bounced_transaction() {
    let mut s = healthy();
    s.checkpoints = vec![checkpoint(0, 900, 3)];
    s.last_applied_checkpoint = Some(0);
    s.live_commitments = commitments(4); // an edge arrived
    s.last_trigger_block = 990;
    s.head_block = 1_000; // next block 1001, boundary 1090
    assert_eq!(
        plan(&s, &curated(), Spend::default()),
        Action::Idle(IdleReason::EpochNotElapsed { next_block: 1_001, boundary: 1_090 })
    );
}

#[test]
fn the_boundary_is_judged_against_the_block_the_transaction_would_run_in() {
    let mut s = healthy();
    s.checkpoints = vec![checkpoint(0, 900, 3)];
    s.last_applied_checkpoint = Some(0);
    s.live_commitments = commitments(4);
    s.epoch_length = 100;
    s.last_trigger_block = 900; // boundary 1000

    // head 998 ⇒ next block 999: one short.
    s.head_block = 998;
    assert!(matches!(
        plan(&s, &curated(), Spend::default()),
        Action::Idle(IdleReason::EpochNotElapsed { .. })
    ));
    // head 999 ⇒ next block 1000: the transaction WILL execute at the boundary. Judging against
    // `head` instead would miss every boundary by exactly one tick.
    s.head_block = 999;
    assert_eq!(plan(&s, &curated(), Spend::default()), Action::Trigger);
}

#[test]
fn our_subsidy_cadence_binds_on_top_of_the_contracts() {
    // EPOCH_FLOOR bounds creation only — `setEpochLength` is constitutional, so a creator can
    // lower their own epoch afterwards. The contract would allow this trigger; we will not pay
    // for it monthly-plus.
    let mut s = healthy();
    s.checkpoints = vec![checkpoint(0, 900, 3)];
    s.last_applied_checkpoint = Some(0);
    s.live_commitments = commitments(4);
    s.epoch_length = 10; // the community lowered it
    s.last_trigger_block = 900;
    s.head_block = 1_000;

    let policy = Policy { subsidy_min_blocks: 216_000, ..Policy::curated() };
    assert_eq!(
        plan(&s, &policy, Spend::default()),
        Action::Idle(IdleReason::SubsidyCadence { next_block: 1_001, boundary: 216_900 })
    );
    // And a non-curated (vault-funded) instance is NOT held by our cadence — it pays for its own.
    let paid = Policy { subsidy_min_blocks: 216_000, ..Policy::funded() };
    assert_eq!(plan(&s, &paid, Spend::default()), Action::Trigger);
}

// ---------------------------------------------------------------------------
// Coalescing: spam is bounded.
// ---------------------------------------------------------------------------

#[test]
fn three_unproven_checkpoints_coalesce_to_the_newest() {
    let mut s = healthy();
    s.checkpoints = vec![checkpoint(0, 800, 1), checkpoint(1, 850, 2), checkpoint(2, 900, 3)];
    assert_eq!(plan(&s, &curated(), Spend::default()), Action::Prove { checkpoint_id: 2 });
}

#[test]
fn a_trigger_spam_run_costs_the_operator_nothing_extra() {
    // 50 checkpoints minted by a spammer, each costing them gas. We prove one.
    let mut s = healthy();
    s.checkpoints = (0..50).map(|i| checkpoint(i, 800 + i, i + 1)).collect();
    let before = plan(&s, &curated(), Spend::default());
    assert_eq!(before, Action::Prove { checkpoint_id: 49 });

    // Ten more arrive before we act. Still exactly one proof, just a newer one.
    for i in 50..60 {
        s.checkpoints.push(checkpoint(i, 800 + i, i + 1));
    }
    assert_eq!(plan(&s, &curated(), Spend::default()), Action::Prove { checkpoint_id: 59 });
}

#[test]
fn checkpoints_at_or_below_the_applied_one_are_never_proved_again() {
    let mut s = healthy();
    s.checkpoints = vec![checkpoint(0, 800, 1), checkpoint(1, 850, 2)];
    s.last_applied_checkpoint = Some(1);
    s.live_commitments = commitments(2);
    assert_eq!(plan(&s, &curated(), Spend::default()), Action::Idle(IdleReason::Quiet));
}

// ---------------------------------------------------------------------------
// Per-instance skips.
// ---------------------------------------------------------------------------

#[test]
fn a_params_mismatch_skips_one_instance_and_leaves_the_rest_running() {
    let good = healthy();
    let mut bad = healthy();
    bad.instance_id = B256::from([0x02; 32]);
    bad.reconstructed_params_hash = B256::from([0xFF; 32]);

    // The bad one is skipped...
    assert_eq!(
        plan(&bad, &curated(), Spend::default()),
        Action::Skip(SkipReason::ParamsMismatch {
            on_chain: PARAMS,
            reconstructed: B256::from([0xFF; 32]),
        })
    );
    // ...and the good one is completely unaffected. This is the behaviour that deliberately
    // differs from `instance_scan`, which aborts the whole run on a mismatch.
    assert_eq!(plan(&good, &curated(), Spend::default()), Action::Prove { checkpoint_id: 0 });
}

#[test]
fn a_rotation_between_trigger_and_prove_does_not_strand_the_pinned_checkpoint() {
    // Governance rotated after this request started. Catalog discovery now sees version 2, but
    // the request journal and held input remain bound to the version-1 checkpoint. It must neither
    // be cancelled nor duplicated, and a ready proof must still be submitted.
    let mut s = healthy();
    let rotated = B256::from([0x99; 32]);
    s.params_hash = rotated;
    s.reconstructed_params_hash = rotated;
    s.checkpoints[0].pinned_params_hash = Some(PARAMS); // pinned: the old value
    s.in_flight = Some(InFlight {
        checkpoint_id: 0,
        request_id: Some(B256::from([0xA1; 32])),
        state: InFlightState::Proving,
    });

    assert_eq!(
        plan(&s, &curated(), Spend::default()),
        Action::Idle(IdleReason::Proving { checkpoint_id: 0 })
    );

    s.in_flight.as_mut().unwrap().state = InFlightState::Ready;
    assert_eq!(plan(&s, &curated(), Spend::default()), Action::Submit { checkpoint_id: 0 });
}

#[test]
fn a_checkpoint_pinned_to_params_we_cannot_reproduce_is_skipped_not_attempted() {
    let mut s = healthy();
    let rotated = B256::from([0x99; 32]);
    s.checkpoints[0].pinned_params_hash = Some(rotated);
    assert_eq!(
        plan(&s, &curated(), Spend::default()),
        Action::Skip(SkipReason::ParamsMismatch { on_chain: rotated, reconstructed: PARAMS })
    );
}

#[test]
fn we_refuse_to_mint_a_checkpoint_we_could_never_prove() {
    // `trigger()` pins the LIVE hash. If we cannot reproduce that value, minting one costs us gas
    // to create work for somebody else. Nothing is pending, so this is the trigger branch.
    let mut s = healthy();
    s.checkpoints = vec![checkpoint(0, 900, 3)];
    s.last_applied_checkpoint = Some(0);
    s.live_commitments = commitments(4);
    s.last_trigger_block = 800;
    s.params_hash = B256::from([0x99; 32]);

    assert_eq!(
        plan(&s, &curated(), Spend::default()),
        Action::Skip(SkipReason::ParamsMismatch {
            on_chain: B256::from([0x99; 32]),
            reconstructed: PARAMS,
        })
    );
}

#[test]
fn a_checkpoint_minted_outside_trigger_is_unprovable_and_skipped() {
    let mut s = healthy();
    s.checkpoints[0].pinned_params_hash = None;
    assert_eq!(
        plan(&s, &curated(), Spend::default()),
        Action::Skip(SkipReason::UnpinnedCheckpoint { checkpoint_id: 0 })
    );
}

#[test]
fn an_unsupported_program_is_skipped_before_anything_else_is_considered() {
    let mut s = healthy();
    s.program = Program::Hypercerts;
    // Even though everything else about it is broken too, the cheapest refusal wins.
    s.paused = true;
    s.reconstructed_params_hash = B256::from([0xFF; 32]);
    assert_eq!(
        plan(&s, &curated(), Spend::default()),
        Action::Skip(SkipReason::UnsupportedProgram(Program::Hypercerts))
    );
}

/// The operator's refusal boundary and the vault's top fee band must be the SAME number, or we
/// price proofs we will not produce (or produce proofs nobody will pay for). The Solidity half of
/// this assertion is `test_TheTopBandAndTheOperatorsCycleLimitAgree`.
#[test]
fn the_refusal_boundary_is_exactly_the_vaults_top_priced_band() {
    use operator_core::policy::MAX_PRICED_INPUTS;
    let p = curated();
    let mut s = healthy();

    s.size =
        InstanceSize { leaf_count: MAX_PRICED_INPUTS, anchor_count: 0, authenticated_cycles: None };
    assert_eq!(
        plan(&s, &p, Spend::default()),
        Action::Prove { checkpoint_id: 0 },
        "the largest priced instance must still be provable"
    );

    s.size = InstanceSize {
        leaf_count: MAX_PRICED_INPUTS + 1,
        anchor_count: 0,
        authenticated_cycles: None,
    };
    assert!(
        matches!(plan(&s, &p, Spend::default()), Action::Skip(SkipReason::TooLarge { .. })),
        "one input past the top band must be refused"
    );

    // And the derivation is the thing that keeps them equal, not a coincidence of two literals.
    assert_eq!(p.cycle_limit, p.base_cycles + MAX_PRICED_INPUTS * p.cycles_per_input);
}

#[test]
fn composition_uses_authenticated_work_not_its_small_source_count() {
    let mut state = healthy();
    state.program = Program::Composition;
    state.size =
        InstanceSize { leaf_count: 2, anchor_count: 0, authenticated_cycles: Some(222_311_301) };
    let mut policy = curated();
    policy.supported_programs.insert(Program::Composition);
    policy.cycle_limit = 222_311_300;
    assert!(matches!(
        plan(&state, &policy, Spend::default()),
        Action::Skip(SkipReason::TooLarge { estimated_cycles: 222_311_301, limit: 222_311_300 })
    ));

    policy.cycle_limit = 222_311_301;
    assert!(!matches!(
        plan(&state, &policy, Spend::default()),
        Action::Skip(SkipReason::TooLarge { .. })
    ));
}

#[test]
fn an_oversized_instance_is_refused_before_the_request_not_after_the_timeout() {
    let mut s = healthy();
    s.size = InstanceSize { leaf_count: 10_000_000, anchor_count: 0, authenticated_cycles: None };
    let p = curated();
    match plan(&s, &p, Spend::default()) {
        Action::Skip(SkipReason::TooLarge { estimated_cycles, limit }) => {
            assert!(estimated_cycles > limit);
            assert_eq!(limit, p.cycle_limit);
        }
        other => panic!("expected TooLarge, got {other:?}"),
    }
}

// ---------------------------------------------------------------------------
// Holds.
// ---------------------------------------------------------------------------

#[test]
fn a_verifier_rotation_holds_and_does_not_burn_a_proof() {
    let mut s = healthy();
    s.zk_verifier = address!("00000000000000000000000000000000000000C1");
    assert_eq!(
        plan(&s, &curated(), Spend::default()),
        Action::Hold(HoldReason::VerifierRotated {
            on_chain: address!("00000000000000000000000000000000000000C1"),
            expected: VERIFIER,
        })
    );
}

#[test]
fn a_pending_timelock_operation_holds() {
    let mut s = healthy();
    s.rotation_pending = true;
    assert_eq!(plan(&s, &curated(), Spend::default()), Action::Hold(HoldReason::RotationPending));
}

#[test]
fn a_paused_instance_holds() {
    let mut s = healthy();
    s.paused = true;
    assert_eq!(plan(&s, &curated(), Spend::default()), Action::Hold(HoldReason::Paused));
}

#[test]
fn a_basefee_spike_holds_the_submit_but_never_the_proof() {
    let policy = curated();
    let spike = policy.max_basefee_wei + 1;

    // Proving costs PROVE, not gas: a spike must not stop it. A root that lands six hours late
    // still files at its input-freeze block.
    let mut s = healthy();
    s.basefee_wei = spike;
    assert_eq!(plan(&s, &policy, Spend::default()), Action::Prove { checkpoint_id: 0 });

    // Submitting does cost gas.
    s.in_flight =
        Some(InFlight { checkpoint_id: 0, request_id: None, state: InFlightState::Ready });
    assert_eq!(
        plan(&s, &policy, Spend::default()),
        Action::Hold(HoldReason::Basefee { basefee_wei: spike, cap_wei: policy.max_basefee_wei })
    );

    // ...and so does triggering.
    s.in_flight = None;
    s.checkpoints = vec![checkpoint(0, 900, 3)];
    s.last_applied_checkpoint = Some(0);
    s.live_commitments = commitments(4);
    s.last_trigger_block = 800;
    assert!(matches!(
        plan(&s, &policy, Spend::default()),
        Action::Hold(HoldReason::Basefee { .. })
    ));
}

#[test]
fn a_basefee_spike_is_not_alertable_but_every_other_hold_is() {
    use operator_core::decide::alerts;
    assert!(!alerts(&Action::Hold(HoldReason::Basefee { basefee_wei: 1, cap_wei: 0 })));
    assert!(alerts(&Action::Hold(HoldReason::Paused)));
    assert!(alerts(&Action::Skip(SkipReason::UnpinnedCheckpoint { checkpoint_id: 0 })));
    assert!(!alerts(&Action::Idle(IdleReason::Quiet)));
    assert!(!alerts(&Action::Prove { checkpoint_id: 0 }));
}

#[test]
fn the_loss_budget_halts_an_instance_rather_than_bleeding() {
    let policy = Policy {
        loss_budget: LossBudget { per_instance_cents_per_day: 500, global_cents_per_day: 5_000 },
        ..curated()
    };
    let s = healthy();

    // Under budget: work continues.
    let ok = Spend { instance_cents_today: 499, global_cents_today: 4_999 };
    assert_eq!(plan(&s, &policy, ok), Action::Prove { checkpoint_id: 0 });

    // Per-instance breach halts this instance.
    let breach = Spend { instance_cents_today: 500, global_cents_today: 600 };
    assert_eq!(
        plan(&s, &policy, breach),
        Action::Hold(HoldReason::LossBudget(BudgetBreach::Instance {
            spent_cents: 500,
            cap_cents: 500
        }))
    );

    // Global breach halts a healthy instance too — that is what "global" means.
    let global = Spend { instance_cents_today: 1, global_cents_today: 5_000 };
    assert_eq!(
        plan(&s, &policy, global),
        Action::Hold(HoldReason::LossBudget(BudgetBreach::Global {
            spent_cents: 5_000,
            cap_cents: 5_000
        }))
    );
}

// ---------------------------------------------------------------------------
// Finality.
// ---------------------------------------------------------------------------

#[test]
fn an_unfinalized_checkpoint_is_waited_on_not_proved() {
    let mut s = healthy();
    s.checkpoints = vec![checkpoint(0, 995, 3)]; // 5 confirmations, policy wants 12
    assert_eq!(
        plan(&s, &curated(), Spend::default()),
        Action::AwaitFinality { checkpoint_id: 0, confirmations: 5, required: 12 }
    );

    // Exactly at the threshold, it goes.
    s.head_block = 995 + 12;
    assert_eq!(plan(&s, &curated(), Spend::default()), Action::Prove { checkpoint_id: 0 });
}

// ---------------------------------------------------------------------------
// In-flight work.
// ---------------------------------------------------------------------------

#[test]
fn a_proof_in_flight_never_starts_a_second_one() {
    let mut s = healthy();
    s.checkpoints.push(checkpoint(1, 950, 4)); // a newer checkpoint appeared
    s.in_flight =
        Some(InFlight { checkpoint_id: 0, request_id: None, state: InFlightState::Proving });
    assert_eq!(
        plan(&s, &curated(), Spend::default()),
        Action::Idle(IdleReason::Proving { checkpoint_id: 0 })
    );
}

#[test]
fn a_root_landed_by_someone_else_mid_proof_is_success_not_failure() {
    // Monotonic submitProof + input-freeze-block filing is what makes N operators compose.
    let mut s = healthy();
    s.last_applied_checkpoint = Some(0);
    s.live_commitments = commitments(3);
    s.in_flight =
        Some(InFlight { checkpoint_id: 0, request_id: None, state: InFlightState::Ready });
    assert_eq!(
        plan(&s, &curated(), Spend::default()),
        Action::Idle(IdleReason::Superseded { checkpoint_id: 0 })
    );
}

#[test]
fn an_unknown_request_outcome_holds_for_a_human_and_is_never_retried() {
    let mut s = healthy();
    s.in_flight =
        Some(InFlight { checkpoint_id: 0, request_id: None, state: InFlightState::OutcomeUnknown });
    let action = plan(&s, &curated(), Spend::default());
    assert_eq!(action, Action::Hold(HoldReason::RequestOutcomeUnknown { checkpoint_id: 0 }));
    // The load-bearing property: this is never a Prove. Retrying is how you pay twice.
    assert!(!matches!(action, Action::Prove { .. }));
}

// ---------------------------------------------------------------------------
// The paid path.
// ---------------------------------------------------------------------------

#[test]
fn an_unfunded_uncurated_instance_stops_and_says_so_rather_than_being_subsidized() {
    let paid = Policy::funded();
    let mut s = healthy();

    // No vault account at all.
    assert_eq!(plan(&s, &paid, Spend::default()), Action::Hold(HoldReason::Unfunded { reason: 1 }));

    // An account that would pay nothing (e.g. cadence not elapsed = reason 3).
    s.vault =
        Some(VaultView { eligible: false, fee_usd: 0, gas_usd: 0, payable_usd: 0, reason: 3 });
    assert_eq!(plan(&s, &paid, Spend::default()), Action::Hold(HoldReason::Unfunded { reason: 3 }));

    // Funded and eligible: prove.
    s.vault = Some(VaultView {
        eligible: true,
        fee_usd: 40 * 100_000_000,
        gas_usd: 10 * 100_000_000,
        payable_usd: 50 * 100_000_000, /* $50 */
        reason: 0,
    });
    assert_eq!(plan(&s, &paid, Spend::default()), Action::Prove { checkpoint_id: 0 });
}

#[test]
fn a_curated_instance_never_consults_a_vault() {
    let s = healthy(); // vault: None
    assert_eq!(plan(&s, &curated(), Spend::default()), Action::Prove { checkpoint_id: 0 });
}

#[test]
fn eligibility_is_checked_before_proving_not_after() {
    // The failure this prevents: discovering mid-flight that a proof will not be paid for. So the
    // unfunded hold must beat the Prove action for the SAME state.
    let s = healthy();
    assert!(matches!(
        plan(&s, &Policy::funded(), Spend::default()),
        Action::Hold(HoldReason::Unfunded { .. })
    ));
}

/// The third state, and the one a two-flag model gets wrong.
///
/// An operator run with `[paid]` off is a community self-proving with its own keys — the thing the
/// hosted service explicitly does not gate. It is not curated (nobody is subsidizing it) and it
/// draws no vault (there isn't one). Collapsing that into `curated` would also throttle it to our
/// monthly subsidy cadence, which is our budget decision and none of their business.
#[test]
fn a_self_proving_run_needs_neither_curation_nor_a_vault() {
    let self_prove = Policy::default(); // curated: false, requires_vault: false
    let s = healthy(); // vault: None
    assert_eq!(plan(&s, &self_prove, Spend::default()), Action::Prove { checkpoint_id: 0 });

    // ...and it is not held back by the subsidy cadence either.
    let mut s2 = healthy();
    s2.checkpoints = vec![checkpoint(0, 900, 3)];
    s2.last_applied_checkpoint = Some(0);
    s2.live_commitments = commitments(4);
    s2.last_trigger_block = 900;
    s2.head_block = 1_000;
    let throttled = Policy { subsidy_min_blocks: 216_000, ..Policy::default() };
    assert_eq!(plan(&s2, &throttled, Spend::default()), Action::Trigger);
}
