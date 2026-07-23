//! The 6-persona worked example (GOAL.md M1): an independent straight-line recompute of the
//! stage-2 arithmetic from the fixture's literal structure, asserted equal — to the wei —
//! against the full `compute()` pipeline. This fixture is the cross-lane oracle: the golden
//! vectors, the guest (M2), the indexer (M3), the TS port (M4) and the seeded round (M5) all
//! reproduce these numbers.

use alloy_primitives::{Address, B256, U256};
use contributions_core::compute::{compute, eligibility, reputation, SkipReason};
use contributions_core::reconcile::reconcile;
use contributions_core::testutil::{
    fixture, ALICE, BOB, C1, C2, C3, C4, C5, CAROL, DAVE, EVE, SEED,
};
use std::collections::BTreeMap;
use zk_core::fixed::{fp_mul, mul_div};

/// The independent recompute: the §4 formulas written out literally for THIS fixture's
/// structure (budgets, σ numerators/denominators, consent and discount factors hard-coded from
/// the worked example), sharing only the frozen fixed-point primitives with production code.
fn expected_weights(
    rep: &BTreeMap<Address, U256>,
    s: U256,
    beta_bps: u64,
) -> BTreeMap<Address, U256> {
    let r = |a: Address| rep.get(&a).copied().unwrap_or(U256::ZERO);
    let sig = |score: u64, budget: u64| mul_div(U256::from(score), s, U256::from(budget));
    let half = s / U256::from(2);

    // Eligible budgets: DAVE {C1:90 (LWW), C2:60} = 150; CAROL {C1:50, C5:90·disc, C3:30} = 170;
    // BOB {C1:70} = 70; SEED {C1:40, C5:60} = 100. ALICE self-dropped, EVE below-min, C4 dead.
    let mut s_c: BTreeMap<B256, U256> = BTreeMap::new();
    *s_c.entry(C1).or_default() += fp_mul(fp_mul(r(DAVE), sig(90, 150), s), s, s);
    *s_c.entry(C2).or_default() += fp_mul(fp_mul(r(DAVE), sig(60, 150), s), s, s);
    *s_c.entry(C1).or_default() += fp_mul(fp_mul(r(CAROL), sig(50, 170), s), s, s);
    *s_c.entry(C5).or_default() += fp_mul(fp_mul(r(CAROL), sig(90, 170), s), half, s);
    *s_c.entry(C3).or_default() += fp_mul(fp_mul(r(CAROL), sig(30, 170), s), s, s);
    *s_c.entry(C1).or_default() += fp_mul(fp_mul(r(BOB), sig(70, 70), s), s, s);
    *s_c.entry(C1).or_default() += fp_mul(fp_mul(r(SEED), sig(40, 100), s), s, s);
    *s_c.entry(C5).or_default() += fp_mul(fp_mul(r(SEED), sig(60, 100), s), s, s);

    // P(a) = Σ_c S(c) · attribShare · consentMult, in compute()'s association order.
    let mut p_a: BTreeMap<Address, U256> = BTreeMap::new();
    // C1: ALICE 100/100, self-claim ⇒ consent 1.
    *p_a.entry(ALICE).or_default() += fp_mul(fp_mul(s_c[&C1], s, s), s, s);
    // C2: BOB 60/100 implicit accept (attester), CAROL 40/100 explicit accept.
    *p_a.entry(BOB).or_default() +=
        fp_mul(fp_mul(s_c[&C2], mul_div(U256::from(60), s, U256::from(100)), s), s, s);
    *p_a.entry(CAROL).or_default() +=
        fp_mul(fp_mul(s_c[&C2], mul_div(U256::from(40), s, U256::from(100)), s), s, s);
    // C3: EVE 50/100 rejected ⇒ 0 (skipped); DAVE 50/100 unaccepted ⇒ 0.5.
    *p_a.entry(DAVE).or_default() +=
        fp_mul(fp_mul(s_c[&C3], mul_div(U256::from(50), s, U256::from(100)), s), half, s);
    // C5: BOB 100/100 implicit accept.
    *p_a.entry(BOB).or_default() += fp_mul(fp_mul(s_c[&C5], s, s), s, s);

    // Carve-out: contributors 1−β pro-rata P; participants (DAVE, CAROL, BOB, SEED) β pro-rata rep.
    let beta_fp = mul_div(s, U256::from(beta_bps), U256::from(10_000u64));
    let one_minus = s - beta_fp;
    let total_p: U256 = p_a.values().copied().fold(U256::ZERO, |a, b| a + b);
    let participants = [BOB, CAROL, DAVE, SEED];
    let total_rep: U256 = participants.iter().map(|a| r(*a)).fold(U256::ZERO, |a, b| a + b);

    let mut w: BTreeMap<Address, U256> = BTreeMap::new();
    for (a, p) in &p_a {
        let share = mul_div(*p, one_minus, total_p);
        if !share.is_zero() {
            *w.entry(*a).or_default() += share;
        }
    }
    for a in participants {
        let share = mul_div(r(a), beta_fp, total_rep);
        if !share.is_zero() {
            *w.entry(a).or_default() += share;
        }
    }
    w
}

#[test]
fn eligibility_partition_matches_the_worked_example() {
    let input = fixture();
    let rep = reputation(&input.trust_edges, &input.params);
    let state = reconcile(&input.records, &input.params);
    let elig = eligibility(&state, &rep, &input.params);

    // C4 (out of window) is not live; its valuation vanished at reconciliation.
    assert!(!state.claims.contains_key(&C4));
    assert!(state.claims.contains_key(&C1) && state.claims.contains_key(&C5));
    assert!(!state.valuations.contains_key(&(C4, DAVE)));

    // ALICE's self-valuation and EVE's dust-rep valuation are skipped with the right reasons.
    assert!(elig.skipped.contains(&(C1, ALICE, SkipReason::SelfValuation)));
    assert!(elig.skipped.contains(&(C1, EVE, SkipReason::BelowMinRep)));
    assert_eq!(elig.skipped.len(), 2);

    // Exactly CAROL's C5 rating is collaborator-discounted (co-claim with BOB on C2).
    let s = input.params.precision_scale;
    for v in &elig.eligible {
        let expect_discount = if (v.rater, v.claim_uid) == (CAROL, C5) {
            input.params.collaborator_mult_fp
        } else {
            s
        };
        assert_eq!(v.discount_fp, expect_discount, "discount for {:?}/{:?}", v.rater, v.claim_uid);
    }

    // Participants = the four raters with an eligible valuation. DAVE's C1 score is the LWW 90.
    let participants: Vec<Address> = elig.participants.iter().copied().collect();
    let mut expected = vec![BOB, CAROL, DAVE, SEED];
    expected.sort();
    assert_eq!(participants, expected);
    assert_eq!(state.valuations[&(C1, DAVE)], 90);
}

#[test]
fn payouts_match_the_independent_recompute_to_the_wei() {
    let input = fixture();
    let s = input.params.precision_scale;
    let rep = reputation(&input.trust_edges, &input.params);

    let weights = expected_weights(&rep, s, input.params.evaluator_carveout_bps as u64);
    let weights_vec: Vec<(Address, U256)> =
        weights.into_iter().filter(|(_, v)| !v.is_zero()).collect();
    let (mut expected_payouts, expected_total) =
        pagerank_core::distribute::distribute_points_generic(
            &weights_vec,
            s,
            input.params.total_pool,
        );
    expected_payouts.sort_by(|a, b| a.0.cmp(&b.0));

    let result = compute(&input);
    assert_eq!(result.scores, expected_payouts, "payout allocation mismatch");
    assert_eq!(result.journal.total_value, expected_total);

    // The whole pool is distributed, to the wei; EVE (rejected + dust) gets nothing.
    let paid: U256 = result.scores.iter().map(|(_, v)| *v).fold(U256::ZERO, |a, b| a + b);
    assert_eq!(paid, input.params.total_pool);
    assert!(!result.scores.iter().any(|(a, _)| *a == EVE));

    // Everyone in the worked example who should earn does: 5 contributors/raters.
    let accounts: Vec<Address> = result.scores.iter().map(|(a, _)| *a).collect();
    for a in [ALICE, BOB, CAROL, DAVE, SEED] {
        assert!(accounts.contains(&a), "{a:?} missing from payouts");
    }
}

#[test]
fn journal_binds_both_accumulators_and_the_params() {
    let input = fixture();
    let result = compute(&input);
    let (acc, n) = pagerank_core::encode::accumulate(&input.trust_edges);
    let (bacc, bn) = pagerank_core::encode::accumulate(&input.records);
    assert_eq!(result.journal.acc, acc, "slot A = trust accumulator");
    assert_eq!(result.journal.leaf_count, n);
    assert_eq!(result.journal.anchor_acc, bacc, "slot B = contribution accumulator");
    assert_eq!(result.journal.anchor_count, bn);
    assert_eq!(result.journal.params_hash, contributions_core::params::params_hash(&input.params));
    assert_eq!(result.journal.skipped_digest, B256::ZERO);

    // The blob is the canonical encoding of the scores and hashes to ipfsHash.
    assert_eq!(result.blob, zk_core::cid::canonical_blob(&result.scores));
    assert_eq!(result.journal.ipfs_hash.as_slice(), &zk_core::cid::sha256(&result.blob));
}
