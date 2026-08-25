//! Crash-restart replay in all three journal states, and the one thing the journal must never do.

use alloy_primitives::B256;
use operator_core::journal::{Journal, Outcome, Record, Status, SubmitFailureClass, WorkKey};
use std::collections::BTreeSet;

fn key(checkpoint_id: u64) -> WorkKey {
    WorkKey { chain_id: 31337, instance_id: B256::from([0x01; 32]), checkpoint_id }
}

fn intent(k: WorkKey, at: u64) -> Record {
    priced_intent(k, at, 0)
}

fn priced_intent(k: WorkKey, at: u64, cost_cents: u64) -> Record {
    Record::Intent {
        key: k,
        public_values_hash: B256::from([0x7B; 32]),
        vk_hash: B256::from([0x9C; 32]),
        at,
        cost_cents,
        cost_model_version: 1,
        estimated_cycles: cost_cents.saturating_mul(1_000_000_000),
        max_iterations: 100,
        iterations_run: 17,
    }
}

#[test]
fn state_1_no_intent_means_nothing_was_requested() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("journal.jsonl");
    let j = Journal::open(&path).unwrap();
    assert_eq!(j.status(&key(0)), Status::Untouched);
    assert!(j.may_request(&key(0)));
}

#[test]
fn state_2_intent_plus_id_re_attaches_instead_of_paying_again() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("journal.jsonl");
    let request_id = B256::from([0xAA; 32]);
    {
        let mut j = Journal::open(&path).unwrap();
        j.append(intent(key(0), 100)).unwrap();
        j.append(Record::Requested { key: key(0), request_id, at: 101 }).unwrap();
    }
    // ...crash...
    let j = Journal::open(&path).unwrap();
    assert_eq!(j.status(&key(0)), Status::InFlight { request_id });
    assert!(!j.may_request(&key(0)), "re-requesting a known in-flight proof pays twice");
}

#[test]
fn state_3_intent_without_id_is_the_ambiguous_window_and_is_never_auto_retried() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("journal.jsonl");
    {
        let mut j = Journal::open(&path).unwrap();
        j.append(intent(key(0), 100)).unwrap();
        // crash between the request and the id landing
    }
    let j = Journal::open(&path).unwrap();
    match j.status(&key(0)) {
        Status::OutcomeUnknown { since, .. } => assert_eq!(since, 100),
        other => panic!("expected OutcomeUnknown, got {other:?}"),
    }
    // The load-bearing assertion of this whole file.
    assert!(!j.may_request(&key(0)), "an unknown outcome must never be retried");
    assert_eq!(j.unresolved(), vec![key(0)]);
}

#[test]
fn a_human_resolving_the_window_either_way_unblocks_it_correctly() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("journal.jsonl");

    // Resolved as "yes, it exists, here is the handle".
    {
        let mut j = Journal::open(&path).unwrap();
        j.append(intent(key(0), 100)).unwrap();
        j.append(Record::Resolved {
            key: key(0),
            request_id: Some(B256::from([0xBB; 32])),
            at: 200,
        })
        .unwrap();
        assert_eq!(j.status(&key(0)), Status::InFlight { request_id: B256::from([0xBB; 32]) });
        assert!(!j.may_request(&key(0)));
        assert!(j.unresolved().is_empty());
    }

    // Resolved as "nothing was ever created" — only then is starting over safe.
    {
        let mut j = Journal::open(&path).unwrap();
        j.append(intent(key(1), 300)).unwrap();
        j.append(Record::Resolved { key: key(1), request_id: None, at: 400 }).unwrap();
        assert_eq!(j.status(&key(1)), Status::Untouched);
        assert!(j.may_request(&key(1)));
    }
}

#[test]
fn a_settled_checkpoint_is_never_paid_for_again() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("journal.jsonl");
    let mut j = Journal::open(&path).unwrap();
    j.append(intent(key(0), 100)).unwrap();
    j.append(Record::Requested { key: key(0), request_id: B256::from([0xAA; 32]), at: 101 })
        .unwrap();
    j.append(Record::Settled { key: key(0), outcome: Outcome::Landed, at: 102 }).unwrap();

    assert_eq!(j.status(&key(0)), Status::Settled(Outcome::Landed));
    assert!(!j.may_request(&key(0)));

    // Superseded is a settlement too: somebody landed a newer root, so this unit of work is done.
    j.append(intent(key(1), 200)).unwrap();
    j.append(Record::Settled { key: key(1), outcome: Outcome::Superseded, at: 201 }).unwrap();
    assert_eq!(j.status(&key(1)), Status::Settled(Outcome::Superseded));
    assert!(!j.may_request(&key(1)));
}

#[test]
fn keys_are_independent_across_instances_and_chains() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("journal.jsonl");
    let mut j = Journal::open(&path).unwrap();
    j.append(intent(key(0), 100)).unwrap();

    let other_instance =
        WorkKey { chain_id: 31337, instance_id: B256::from([0x02; 32]), checkpoint_id: 0 };
    let other_chain =
        WorkKey { chain_id: 1, instance_id: B256::from([0x01; 32]), checkpoint_id: 0 };
    assert!(j.may_request(&other_instance), "one instance's window must not block another's");
    assert!(j.may_request(&other_chain), "the same instance mirrored on another chain is separate");
}

#[test]
fn every_record_survives_a_round_trip_through_the_file() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("journal.jsonl");
    let written = {
        let mut j = Journal::open(&path).unwrap();
        j.append(intent(key(0), 1)).unwrap();
        j.append(Record::Requested { key: key(0), request_id: B256::from([0x11; 32]), at: 2 })
            .unwrap();
        j.append(Record::Settled { key: key(0), outcome: Outcome::Failed, at: 3 }).unwrap();
        j.append(Record::Resolved { key: key(1), request_id: None, at: 4 }).unwrap();
        j.append(Record::SubmitFailure {
            key: key(2),
            class: SubmitFailureClass::SimulationRevert,
            at: 5,
        })
        .unwrap();
        j.append(Record::Abandoned {
            key: key(2),
            class: SubmitFailureClass::SimulationRevert,
            attempts: 3,
            at: 6,
        })
        .unwrap();
        j.append(Record::PublicationAttempt {
            key: key(3),
            cid: "bafkreifailed".into(),
            policy_hash: B256::from([0x33; 32]),
            successes: 1,
            required: 2,
            failures: vec!["backup: unavailable".into()],
            at: 7,
        })
        .unwrap();
        j.append(Record::Published {
            key: key(3),
            cid: "bafkreifailed".into(),
            policy_hash: B256::from([0x33; 32]),
            successes: 2,
            required: 2,
            at: 8,
        })
        .unwrap();
        j.append(Record::SubmitPending {
            key: key(4),
            tx_hash: B256::from([0x44; 32]),
            block_number: 123,
            block_hash: B256::from([0x45; 32]),
            confirmations: 12,
            cost_cents: 17,
            at: 9,
        })
        .unwrap();
        j.append(Record::SubmitReorged { key: key(4), tx_hash: B256::from([0x44; 32]), at: 10 })
            .unwrap();
        j.append(Record::CompositionAvailabilityAttempt {
            chain_id: 31_337,
            instance_id: B256::from([0x44; 32]),
            checkpoint_id: Some(9),
            error: "source CID unavailable from durability quorum".into(),
            at: 11,
        })
        .unwrap();
        j.records().to_vec()
    };
    let reopened = Journal::open(&path).unwrap();
    assert_eq!(reopened.records(), written.as_slice());
}

#[test]
fn pending_submit_finality_survives_restart_and_clears_durably() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("journal.jsonl");
    let tx = B256::from([0x71; 32]);
    {
        let mut journal = Journal::open(&path).unwrap();
        journal
            .append(Record::SubmitPending {
                key: key(7),
                tx_hash: tx,
                block_number: 900,
                block_hash: B256::from([0x72; 32]),
                confirmations: 12,
                cost_cents: 23,
                at: 100,
            })
            .unwrap();
    }

    let mut reopened = Journal::open(&path).unwrap();
    let pending = reopened.pending_submissions();
    let restored = pending.get(&key(7)).expect("the finality watch survives restart");
    assert_eq!(restored.tx_hash, tx);
    assert_eq!(restored.anchor.block_number, 900);
    assert_eq!(restored.anchor.block_hash, B256::from([0x72; 32]));
    assert_eq!(restored.confirmations, 12);
    assert_eq!(reopened.spend(key(7).instance_id, 100, 86_400).instance_cents_today, 23);

    reopened.append(Record::SubmitReorged { key: key(7), tx_hash: tx, at: 101 }).unwrap();
    assert!(reopened.pending_submissions().is_empty());

    reopened
        .append(Record::SubmitPending {
            key: key(7),
            tx_hash: B256::from([0x73; 32]),
            block_number: 901,
            block_hash: B256::from([0x74; 32]),
            confirmations: 12,
            cost_cents: 29,
            at: 102,
        })
        .unwrap();
    reopened.append(Record::Settled { key: key(7), outcome: Outcome::Landed, at: 114 }).unwrap();
    assert!(reopened.pending_submissions().is_empty());
}

#[test]
fn composition_availability_backoff_is_checkpoint_and_instance_scoped() {
    let dir = tempfile::tempdir().unwrap();
    let mut journal = Journal::open(dir.path().join("journal.jsonl")).unwrap();
    journal
        .append(Record::CompositionAvailabilityAttempt {
            chain_id: 31_337,
            instance_id: B256::from([0x44; 32]),
            checkpoint_id: Some(7),
            error: "gateway quorum unavailable".into(),
            at: 123,
        })
        .unwrap();
    assert_eq!(
        journal
            .composition_availability_retry(31_337, B256::from([0x44; 32]), Some(7))
            .unwrap()
            .last_at,
        123
    );
    assert!(journal
        .composition_availability_retry(31_337, B256::from([0x44; 32]), Some(8))
        .is_none());
    assert!(journal.composition_availability_retry(10, B256::from([0x44; 32]), Some(7)).is_none());
}

#[test]
fn failed_publication_retry_state_survives_restart_and_success_clears_it() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("journal.jsonl");
    let policy = B256::from([0x33; 32]);
    {
        let mut j = Journal::open(&path).unwrap();
        for at in [100, 200] {
            j.append(Record::PublicationAttempt {
                key: key(0),
                cid: "bafkreiblob".into(),
                policy_hash: policy,
                successes: 1,
                required: 2,
                failures: vec!["backup: timeout".into()],
                at,
            })
            .unwrap();
        }
    }
    let mut reopened = Journal::open(&path).unwrap();
    let retry = reopened.publication_retry(&key(0), "bafkreiblob", policy).unwrap();
    assert_eq!(retry.attempts, 2);
    assert_eq!(retry.last_at, 200);
    assert_eq!(retry.failures, vec!["backup: timeout"]);
    assert!(!reopened.publication_satisfied(&key(0), "bafkreiblob", policy));

    reopened
        .append(Record::Published {
            key: key(0),
            cid: "bafkreiblob".into(),
            policy_hash: policy,
            successes: 2,
            required: 2,
            at: 300,
        })
        .unwrap();
    assert!(reopened.publication_satisfied(&key(0), "bafkreiblob", policy));
    assert_eq!(reopened.publication_retry(&key(0), "bafkreiblob", policy), None);
}

#[test]
fn publication_success_is_bound_to_the_exact_cid_and_policy() {
    let dir = tempfile::tempdir().unwrap();
    let mut j = Journal::open(dir.path().join("journal.jsonl")).unwrap();
    let policy = B256::from([0x44; 32]);
    j.append(Record::Published {
        key: key(0),
        cid: "bafkreiblob".into(),
        policy_hash: policy,
        successes: 2,
        required: 2,
        at: 100,
    })
    .unwrap();

    assert!(j.publication_satisfied(&key(0), "bafkreiblob", policy));
    assert!(!j.publication_satisfied(&key(0), "bafkreiother", policy));
    assert!(!j.publication_satisfied(&key(0), "bafkreiblob", B256::from([0x55; 32])));
}

#[test]
fn a_legacy_zero_of_zero_publication_record_is_not_success() {
    let dir = tempfile::tempdir().unwrap();
    let mut j = Journal::open(dir.path().join("journal.jsonl")).unwrap();
    let policy = B256::from([0x66; 32]);
    j.append(Record::Published {
        key: key(0),
        cid: "bafkreiunpublished".into(),
        policy_hash: policy,
        successes: 0,
        required: 0,
        at: 100,
    })
    .unwrap();

    assert!(!j.publication_satisfied(&key(0), "bafkreiunpublished", policy));
}

#[test]
fn a_corrupt_line_is_a_hard_error_not_a_silent_skip() {
    // A journal we are willing to read selectively cannot do its one job.
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("journal.jsonl");
    {
        let mut j = Journal::open(&path).unwrap();
        j.append(intent(key(0), 1)).unwrap();
    }
    std::fs::write(
        &path,
        format!("{}\n{{ not json\n", serde_json::to_string(&intent(key(0), 1)).unwrap()),
    )
    .unwrap();
    assert!(Journal::open(&path).is_err());
}

// ---------------------------------------------------------------------------------------------
// Rolling spend. This is what makes `LossBudget` reachable: the daemon passed `Spend::default()`
// forever, so the budget could never fire on any input at all.
// ---------------------------------------------------------------------------------------------

fn other_instance(checkpoint_id: u64) -> WorkKey {
    WorkKey { chain_id: 31337, instance_id: B256::from([0x02; 32]), checkpoint_id }
}

#[test]
fn spend_sums_this_instance_and_everything_globally() {
    let dir = tempfile::tempdir().unwrap();
    let mut j = Journal::open(dir.path().join("journal.jsonl")).unwrap();
    j.append(priced_intent(key(0), 1_000, 300)).unwrap();
    j.append(priced_intent(key(1), 1_100, 200)).unwrap();
    j.append(priced_intent(other_instance(0), 1_200, 700)).unwrap();

    let s = j.spend(B256::from([0x01; 32]), 2_000, 86_400);
    assert_eq!(s.instance_cents_today, 500, "only this instance's two intents");
    assert_eq!(s.global_cents_today, 1_200, "every instance's intents");
}

#[test]
fn spend_drops_intents_older_than_the_window() {
    let dir = tempfile::tempdir().unwrap();
    let mut j = Journal::open(dir.path().join("journal.jsonl")).unwrap();
    j.append(priced_intent(key(0), 100, 5_000)).unwrap(); // yesterday
    j.append(priced_intent(key(1), 90_000, 250)).unwrap(); // today

    let s = j.spend(B256::from([0x01; 32]), 100_000, 86_400);
    assert_eq!(s.instance_cents_today, 250, "the old intent must not keep an instance halted");
}

#[test]
fn spend_counts_intents_not_settlements() {
    // A request that FAILED still cost money. Counting settlements would let a run of failures
    // spend without ever registering against the budget.
    let dir = tempfile::tempdir().unwrap();
    let mut j = Journal::open(dir.path().join("journal.jsonl")).unwrap();
    j.append(priced_intent(key(0), 1_000, 400)).unwrap();
    j.append(Record::Settled { key: key(0), outcome: Outcome::Failed, at: 1_010 }).unwrap();

    let s = j.spend(B256::from([0x01; 32]), 1_100, 86_400);
    assert_eq!(s.instance_cents_today, 400);
}

#[test]
fn a_journal_written_before_costs_existed_still_replays_at_zero() {
    // `serde(default)`. Zero is the safe direction: a budget cannot halt an instance on spend it
    // cannot see, and the alternative — guessing a cost nobody recorded — halts on fiction.
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("journal.jsonl");
    std::fs::write(
        &path,
        r#"{"kind":"intent","key":{"chain_id":31337,"instance_id":"0x0101010101010101010101010101010101010101010101010101010101010101","checkpoint_id":0},"public_values_hash":"0x7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b","vk_hash":"0x9c9c9c9c9c9c9c9c9c9c9c9c9c9c9c9c9c9c9c9c9c9c9c9c9c9c9c9c9c9c9c9c","at":1000}
"#,
    )
    .unwrap();
    let j = Journal::open(&path).unwrap();
    assert_eq!(j.spend(B256::from([0x01; 32]), 1_100, 86_400).instance_cents_today, 0);
    assert_eq!(
        j.status(&key(0)),
        Status::OutcomeUnknown {
            public_values_hash: B256::from([0x7B; 32]),
            vk_hash: B256::from([0x9C; 32]),
            since: 1_000,
        }
    );
}

// ---------------------------------------------------------------------------------------------
// Refusals that name their own cause.
//
// The regression these exist for: a devnet was restarted, so the chain's checkpoint counter went
// back to 0 while the instance id (keccak of creator/name/salt) and the chain id (31337) stayed
// put. Every component of the `WorkKey` collided with the previous run's, the journal correctly
// refused to pay twice for what it believed was the same work, and the daemon re-planned the same
// doomed `Prove` every tick for the rest of its life. It was right to refuse and useless about
// why: "journal refuses a fresh request for checkpoint 0".
// ---------------------------------------------------------------------------------------------

/// The chain cannot be missing a root it already accepted, so the journal is describing a
/// different chain that shares the id.
#[test]
fn a_settled_root_the_chain_has_never_seen_is_a_stale_journal() {
    let dir = tempfile::tempdir().unwrap();
    let mut j = Journal::open(dir.path().join("journal.jsonl")).unwrap();
    j.append(intent(key(0), 1_000)).unwrap();
    j.append(Record::Requested { key: key(0), request_id: B256::from([0x22; 32]), at: 1_001 })
        .unwrap();
    j.append(Record::Settled { key: key(0), outcome: Outcome::Landed, at: 1_002 }).unwrap();

    let why = j.refusal(&key(0), None);
    assert!(why.contains("DIFFERENT chain"), "{why}");
    assert!(why.contains("no root has ever been applied"), "{why}");
    assert!(why.contains("task demo:clean"), "the message must carry its own fix: {why}");
}

/// Same contradiction, one step subtler: the chain HAS applied a root, but an older one than the
/// journal claims to have landed.
#[test]
fn a_chain_behind_the_journal_is_also_a_stale_journal() {
    let dir = tempfile::tempdir().unwrap();
    let mut j = Journal::open(dir.path().join("journal.jsonl")).unwrap();
    j.append(intent(key(7), 1_000)).unwrap();
    j.append(Record::Settled { key: key(7), outcome: Outcome::Superseded, at: 1_001 }).unwrap();

    let why = j.refusal(&key(7), Some(3));
    assert!(why.contains("DIFFERENT chain"), "{why}");
    assert!(why.contains("newest applied checkpoint is 3"), "{why}");
}

/// The ordinary case, which must NOT be reported as a stale journal: the root really did land and
/// the chain agrees. Re-running the demo against a live chain hits this, and telling that operator
/// to wipe its journal would be telling them to arm a double-spend.
#[test]
fn a_settled_root_the_chain_confirms_is_just_settled() {
    let dir = tempfile::tempdir().unwrap();
    let mut j = Journal::open(dir.path().join("journal.jsonl")).unwrap();
    j.append(intent(key(4), 1_000)).unwrap();
    j.append(Record::Settled { key: key(4), outcome: Outcome::Landed, at: 1_001 }).unwrap();

    for applied in [Some(4), Some(9)] {
        let why = j.refusal(&key(4), applied);
        assert!(!why.contains("DIFFERENT chain"), "applied={applied:?}: {why}");
        assert!(why.contains("already settled"), "{why}");
    }
}

/// A settlement that makes no claim about the chain cannot contradict it. `Failed` and `Cancelled`
/// are true whether or not a root is there, so an absent root proves nothing.
#[test]
fn a_failed_request_is_not_evidence_of_a_stale_journal() {
    for outcome in [Outcome::Failed, Outcome::Cancelled] {
        let dir = tempfile::tempdir().unwrap();
        let mut j = Journal::open(dir.path().join("journal.jsonl")).unwrap();
        j.append(intent(key(0), 1_000)).unwrap();
        j.append(Record::Settled { key: key(0), outcome, at: 1_001 }).unwrap();
        let why = j.refusal(&key(0), None);
        assert!(!why.contains("DIFFERENT chain"), "{outcome:?}: {why}");
    }
}

/// The other two refusals keep their own explanations, and neither is confused for a chain reset.
#[test]
fn in_flight_and_unknown_refusals_say_what_they_are() {
    let dir = tempfile::tempdir().unwrap();
    let mut j = Journal::open(dir.path().join("journal.jsonl")).unwrap();

    j.append(intent(key(0), 1_000)).unwrap();
    let unknown = j.refusal(&key(0), None);
    assert!(unknown.contains("outcome is still unknown"), "{unknown}");
    assert!(unknown.contains("NEVER auto-retried"), "{unknown}");
    assert!(!unknown.contains("DIFFERENT chain"), "{unknown}");

    j.append(Record::Requested { key: key(0), request_id: B256::from([0x22; 32]), at: 1_001 })
        .unwrap();
    let in_flight = j.refusal(&key(0), None);
    assert!(in_flight.contains("already out"), "{in_flight}");
    assert!(in_flight.contains("pay twice"), "{in_flight}");
    assert!(!in_flight.contains("DIFFERENT chain"), "{in_flight}");
}

// ---------------------------------------------------------------------------
// H-3 (2026-08-13 audit): submit gas is budgeted spend, and a revert loop is
// strikes toward a human hold — not a free retry.
// ---------------------------------------------------------------------------

fn submit_gas(k: WorkKey, reverted: bool, cost_cents: u64, at: u64) -> Record {
    Record::SubmitGas { key: k, reverted, cost_cents, at }
}

/// Receipt and preflight reverts share one deterministic failure counter. Provider/fee/reorg
/// failures have no journal record and therefore cannot accidentally advance this counter.
#[test]
fn deterministic_submit_failures_share_one_counter() {
    let dir = tempfile::tempdir().unwrap();
    let mut j = Journal::open(dir.path().join("journal.jsonl")).unwrap();

    assert_eq!(j.submit_failures(&key(0)), (0, None));
    j.append(Record::SubmitFailure {
        key: key(0),
        class: SubmitFailureClass::EstimateRevert,
        at: 1_001,
    })
    .unwrap();
    assert_eq!(j.submit_failures(&key(0)), (1, Some(SubmitFailureClass::EstimateRevert)));
    j.append(Record::SubmitFailure {
        key: key(0),
        class: SubmitFailureClass::SimulationRevert,
        at: 1_002,
    })
    .unwrap();
    j.append(submit_gas(key(0), true, 250, 1_003)).unwrap();
    assert_eq!(j.submit_failures(&key(0)), (3, Some(SubmitFailureClass::ReceiptRevert)));

    // Counters are per-key: another checkpoint is unaffected.
    assert_eq!(j.submit_failures(&key(1)), (0, None));
    // A successful (non-reverted) submit is not a strike.
    j.append(submit_gas(key(1), false, 250, 2_000)).unwrap();
    assert_eq!(j.submit_failures(&key(1)), (0, None));

    // Before terminal abandonment, the legacy human recovery record still clears the counter.
    j.append(Record::Resolved { key: key(0), request_id: None, at: 3_000 }).unwrap();
    assert_eq!(j.submit_failures(&key(0)), (0, None));
}

#[test]
fn abandoned_is_terminal_and_survives_restart() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("journal.jsonl");
    {
        let mut j = Journal::open(&path).unwrap();
        j.append(intent(key(0), 100)).unwrap();
        j.append(Record::Requested { key: key(0), request_id: B256::from([0xAA; 32]), at: 101 })
            .unwrap();
        for at in 102..=104 {
            j.append(Record::SubmitFailure {
                key: key(0),
                class: SubmitFailureClass::SimulationRevert,
                at,
            })
            .unwrap();
        }
        j.append(Record::Abandoned {
            key: key(0),
            class: SubmitFailureClass::SimulationRevert,
            attempts: 3,
            at: 104,
        })
        .unwrap();
    }

    let mut reopened = Journal::open(&path).unwrap();
    assert_eq!(
        reopened.status(&key(0)),
        Status::Abandoned { class: SubmitFailureClass::SimulationRevert, attempts: 3 }
    );
    assert!(!reopened.may_request(&key(0)));
    assert!(reopened.refusal(&key(0), None).contains("never retried"));

    // `Resolved` belongs to the request-outcome ambiguity and cannot resurrect an abandoned
    // immutable proof.
    reopened.append(Record::Resolved { key: key(0), request_id: None, at: 105 }).unwrap();
    assert!(matches!(reopened.status(&key(0)), Status::Abandoned { .. }));
    assert_eq!(reopened.submit_failures(&key(0)), (3, Some(SubmitFailureClass::SimulationRevert)));
}

/// On-chain gas — landed or reverted — lands in the SAME rolling budget as proving cost, so a
/// revert loop eventually breaches `LossBudget` instead of draining the wallet invisibly.
#[test]
fn h3_submit_gas_counts_into_the_rolling_spend_window() {
    use operator_core::policy::LossBudget;

    let dir = tempfile::tempdir().unwrap();
    let mut j = Journal::open(dir.path().join("journal.jsonl")).unwrap();
    let instance = key(0).instance_id;

    j.append(priced_intent(key(0), 1_000, 400)).unwrap();
    j.append(submit_gas(key(0), true, 300, 1_100)).unwrap();
    j.append(submit_gas(key(0), true, 300, 1_200)).unwrap();
    // Gas on another instance counts globally, not against this one.
    let other = WorkKey { chain_id: 31337, instance_id: B256::from([0x02; 32]), checkpoint_id: 0 };
    j.append(submit_gas(other, false, 500, 1_300)).unwrap();

    let s = j.spend(instance, 2_000, 10_000);
    assert_eq!(s.instance_cents_today, 400 + 300 + 300);
    assert_eq!(s.global_cents_today, 400 + 300 + 300 + 500);

    // The window still applies: old gas ages out.
    let aged = j.spend(instance, 20_000, 1_000);
    assert_eq!(aged.instance_cents_today, 0);

    // And the budget the daemon consults actually fires on gas alone.
    let budget = LossBudget { per_instance_cents_per_day: 500, global_cents_per_day: 10_000 };
    assert!(budget.exceeded_by(s).is_some(), "gas spend must be able to breach the budget");

    // SubmitGas is bookkeeping only: it never changes the key's request status.
    assert_eq!(j.status(&other), Status::Untouched);
}

#[test]
fn derived_signer_budget_has_an_independent_global_namespace() {
    let dir = tempfile::tempdir().unwrap();
    let mut journal = Journal::open(dir.path().join("journal.jsonl")).unwrap();
    let root = key(0);
    let signer = WorkKey { chain_id: 31337, instance_id: B256::from([0x51; 32]), checkpoint_id: 0 };
    journal.append(priced_intent(root, 1_000, 2_000)).unwrap();
    journal.append(priced_intent(signer, 1_000, 300)).unwrap();

    let signer_scope = BTreeSet::from([signer.instance_id]);
    let spend = journal.spend_scoped(signer.instance_id, 2_000, 10_000, Some(&signer_scope));
    assert_eq!(spend.instance_cents_today, 300);
    assert_eq!(
        spend.global_cents_today, 300,
        "score-root spend must not exhaust the signer-specific cap"
    );

    let root_scope = BTreeSet::from([root.instance_id]);
    let spend = journal.spend_scoped(root.instance_id, 2_000, 10_000, Some(&root_scope));
    assert_eq!(spend.instance_cents_today, 2_000);
    assert_eq!(
        spend.global_cents_today, 2_000,
        "signer spend must not exhaust the ordinary root cap"
    );
}

/// A journal written before SubmitGas existed still replays (forward-compat mirror of the
/// cost_cents serde(default) guarantee).
#[test]
fn h3_submit_gas_round_trips_through_replay() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("journal.jsonl");
    {
        let mut j = Journal::open(&path).unwrap();
        j.append(submit_gas(key(0), true, 123, 1_000)).unwrap();
        j.append(submit_gas(key(0), true, 456, 1_001)).unwrap();
    }
    let j = Journal::open(&path).unwrap();
    assert_eq!(
        j.submit_failures(&key(0)),
        (2, Some(SubmitFailureClass::ReceiptRevert)),
        "failures survive a restart"
    );
    assert_eq!(j.spend(key(0).instance_id, 1_500, 10_000).instance_cents_today, 579);
}
