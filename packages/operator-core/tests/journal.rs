//! Crash-restart replay in all three journal states, and the one thing the journal must never do.

use alloy_primitives::B256;
use operator_core::journal::{Journal, Outcome, Record, Status, WorkKey};

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
        j.records().to_vec()
    };
    let reopened = Journal::open(&path).unwrap();
    assert_eq!(reopened.records(), written.as_slice());
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
