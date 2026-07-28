//! Reorg safety and the last-moment re-read.

use alloy_primitives::{address, Address, B256};
use operator_core::finality::{Anchor, Dependencies, Finality};
use operator_core::guard::{before_spend, before_submit, GuardRead, Verdict};

const VERIFIER: Address = address!("00000000000000000000000000000000000000B1");
const OTHER: Address = address!("00000000000000000000000000000000000000B2");

fn anchor(block: u64, hash: u8) -> Anchor {
    Anchor { block_number: block, block_hash: B256::from([hash; 32]) }
}

#[test]
fn a_shallow_anchor_is_pending_and_a_deep_one_is_final() {
    let a = anchor(100, 0xAA);
    let canonical = Some(B256::from([0xAA; 32]));
    assert_eq!(
        a.finality(105, 12, canonical),
        Finality::Pending { confirmations: 5, required: 12 }
    );
    assert_eq!(a.finality(112, 12, canonical), Finality::Final);
}

#[test]
fn a_reorg_of_equal_depth_is_caught_because_we_track_the_hash() {
    // The whole reason the hash is tracked: after an equal-depth reorg the block NUMBER is still
    // there and still deep, so a confirmations-only check would call this final.
    let a = anchor(100, 0xAA);
    let swapped = Some(B256::from([0xBB; 32]));
    assert_eq!(
        a.finality(1_000, 12, swapped),
        Finality::Reorged { expected: B256::from([0xAA; 32]), canonical: B256::from([0xBB; 32]) }
    );
}

#[test]
fn a_block_that_no_longer_exists_is_a_reorg_not_merely_shallow() {
    let a = anchor(100, 0xAA);
    assert!(matches!(a.finality(50, 12, None), Finality::Reorged { .. }));
}

#[test]
fn one_shallow_dependency_makes_the_whole_proof_unsafe_to_pay_for() {
    let mut deps = Dependencies::default();
    deps.push(anchor(100, 0xAA)); // deep
    deps.push(anchor(998, 0xBB)); // shallow: the anchor transaction landed just now
    let canonical = |b: u64| Some(B256::from([if b == 100 { 0xAA } else { 0xBB }; 32]));

    assert_eq!(
        deps.worst(1_000, 12, canonical),
        Finality::Pending { confirmations: 2, required: 12 }
    );
    assert_eq!(deps.worst(1_010, 12, canonical), Finality::Final);
}

#[test]
fn a_reorged_dependency_beats_a_pending_one() {
    let mut deps = Dependencies::default();
    deps.push(anchor(998, 0xBB)); // shallow
    deps.push(anchor(100, 0xAA)); // reorged out from under us
    let canonical = |b: u64| Some(B256::from([if b == 100 { 0xCC } else { 0xBB }; 32]));
    assert!(matches!(deps.worst(1_000, 12, canonical), Finality::Reorged { .. }));
}

#[test]
fn duplicate_dependencies_are_deduplicated() {
    let mut deps = Dependencies::default();
    deps.push(anchor(100, 0xAA));
    deps.push(anchor(100, 0xAA));
    assert_eq!(deps.anchors.len(), 1);
}

// ---------------------------------------------------------------------------
// The guard.
// ---------------------------------------------------------------------------

fn clear_read() -> GuardRead {
    GuardRead {
        params_hash: B256::from([0x11; 32]),
        zk_verifier: VERIFIER,
        paused: false,
        pending_timelock_op: Some(false),
    }
}

#[test]
fn a_clear_read_lets_both_spend_and_submit_through() {
    assert!(before_spend(clear_read(), VERIFIER).is_clear());
    assert!(before_submit(clear_read(), VERIFIER).is_clear());
}

#[test]
fn a_verifier_rotation_stops_both() {
    let mut r = clear_read();
    r.zk_verifier = OTHER;
    assert_eq!(before_spend(r, VERIFIER), Verdict::VerifierRotated { was: VERIFIER, now: OTHER });
    assert_eq!(before_submit(r, VERIFIER), Verdict::VerifierRotated { was: VERIFIER, now: OTHER });
}

#[test]
fn a_pause_stops_both() {
    let mut r = clear_read();
    r.paused = true;
    assert_eq!(before_spend(r, VERIFIER), Verdict::Paused);
    assert_eq!(before_submit(r, VERIFIER), Verdict::Paused);
}

#[test]
fn a_queued_admin_operation_stops_a_spend_but_not_a_finished_root() {
    // Before spending, waiting is free. After spending, sitting on a finished proof risks losing
    // it entirely; a reverted submit costs gas, which is strictly cheaper.
    let mut r = clear_read();
    r.pending_timelock_op = Some(true);
    assert_eq!(before_spend(r, VERIFIER), Verdict::RotationPending);
    assert!(before_submit(r, VERIFIER).is_clear());
}

#[test]
fn no_timelock_to_probe_is_not_evidence_of_no_pending_operation() {
    // Factory instances are creator-admin'd and have no timelock at all. `None` must read as "no
    // information", never as "all clear" — the guard's job is to notice, not to reassure.
    let mut r = clear_read();
    r.pending_timelock_op = None;
    assert!(
        before_spend(r, VERIFIER).is_clear(),
        "absence cannot block, but it also proves nothing"
    );

    // And the only thing that DOES block is a positive hit.
    r.pending_timelock_op = Some(true);
    assert_eq!(before_spend(r, VERIFIER), Verdict::RotationPending);
}

#[test]
fn a_params_rotation_alone_no_longer_stops_anything() {
    // M0 pinned `paramsHash` per checkpoint, so a rotation between trigger and submit cannot
    // invalidate work in flight. The guard must not treat it as if it could.
    let mut r = clear_read();
    r.params_hash = B256::from([0x99; 32]);
    assert!(before_spend(r, VERIFIER).is_clear());
    assert!(before_submit(r, VERIFIER).is_clear());
}
