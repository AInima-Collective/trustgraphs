//! Crash-restart replay in all three journal states, and the one thing the journal must never do.

use alloy_primitives::B256;
use operator_core::journal::{Journal, Outcome, Record, Status, WorkKey};

fn key(checkpoint_id: u64) -> WorkKey {
    WorkKey { chain_id: 31337, instance_id: B256::from([0x01; 32]), checkpoint_id }
}

fn intent(k: WorkKey, at: u64) -> Record {
    Record::Intent {
        key: k,
        public_values_hash: B256::from([0x7B; 32]),
        vk_hash: B256::from([0x9C; 32]),
        at,
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
