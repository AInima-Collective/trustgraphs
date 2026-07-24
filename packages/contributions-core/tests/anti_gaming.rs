//! The §5 anti-gaming vector suite (GOAL.md M6): each attack from
//! CONTRIBUTION_FUNDING.md §5 exercised as a concrete scenario and shown provably inert or
//! discounted. Complements tests/properties.rs (randomized) with named, attack-shaped cases.

use alloy_primitives::{Address, B256, U256};
use contributions_core::compute::{compute, eligibility, reputation, GuestInput};
use contributions_core::records::{encode_claim, encode_response, encode_valuation};
use contributions_core::testutil::{edge, params, vouch};
use contributions_core::{kind, Params};

fn addr(n: u8) -> Address {
    Address::new([n; 20])
}

fn uid(n: u16) -> B256 {
    let mut b = [0u8; 32];
    b[..2].copy_from_slice(&n.to_be_bytes());
    b[31] = 0xF5;
    B256::new(b)
}

fn payout_of(scores: &[(Address, U256)], a: Address) -> U256 {
    scores.iter().find(|(x, _)| *x == a).map(|(_, v)| *v).unwrap_or(U256::ZERO)
}

/// A base world: SEED vouches two raters (R1, R2) and two contributors (X, Y) claim solo.
fn base(p: Params) -> (GuestInput, [Address; 5], [B256; 2]) {
    let seed = addr(0x51);
    let r1 = addr(0x52);
    let r2 = addr(0x53);
    let x = addr(0x54);
    let y = addr(0x55);
    let t0 = p.round_start;
    let mut input = GuestInput {
        trust_edges: vec![
            vouch(0, seed, r1, uid(1), t0 - 100, 80),
            vouch(0, seed, r2, uid(2), t0 - 90, 80),
        ],
        records: vec![
            edge(
                kind::KIND_CLAIM_ATTEST,
                x,
                uid(10),
                t0 + 10,
                encode_claim("x", B256::ZERO, "u", &[x], &[100]),
            ),
            edge(
                kind::KIND_CLAIM_ATTEST,
                y,
                uid(11),
                t0 + 20,
                encode_claim("y", B256::ZERO, "u", &[y], &[100]),
            ),
        ],
        params: p,
    };
    input.params.trusted_seeds = vec![seed];
    (input, [seed, r1, r2, x, y], [uid(10), uid(11)])
}

/// §5.1 budgeted voice: rating everything at 100 vs everything at 40 is IDENTICAL — the
/// absolute level cannot mint; only relative allocation matters.
#[test]
fn score_inflation_is_pure_voice_splitting() {
    let (mut hi, [_, r1, r2, ..], [c1, c2]) = base(params());
    let t0 = hi.params.round_start;
    let mut lo = hi.clone();
    for (input, s) in [(&mut hi, 100u8), (&mut lo, 40u8)] {
        input.records.push(edge(
            kind::KIND_VALUATION_ATTEST,
            r1,
            uid(20),
            t0 + 30,
            encode_valuation(c1, s),
        ));
        input.records.push(edge(
            kind::KIND_VALUATION_ATTEST,
            r1,
            uid(21),
            t0 + 40,
            encode_valuation(c2, s),
        ));
    }
    // r2 anchors the round with an asymmetric rating so payouts aren't trivially uniform.
    for input in [&mut hi, &mut lo] {
        input.records.push(edge(
            kind::KIND_VALUATION_ATTEST,
            r2,
            uid(22),
            t0 + 50,
            encode_valuation(c1, 90),
        ));
        input.records.push(edge(
            kind::KIND_VALUATION_ATTEST,
            r2,
            uid(23),
            t0 + 60,
            encode_valuation(c2, 30),
        ));
    }
    let hi_result = compute(&hi);
    let lo_result = compute(&lo);
    assert_eq!(hi_result.scores, lo_result.scores, "absolute score level must be inert");
}

/// §5.2 conflict-of-interest ring ("you rate my thing, I rate yours"): two raters who
/// co-claim ARE discounted on each other's solo claims, and earn strictly less than the
/// identical world without the shared claim.
#[test]
fn collusion_ring_is_discounted() {
    let (mut ring, [seed, r1, r2, x, y], [c1, c2]) = base(params());
    let t0 = ring.params.round_start;
    // The ring is between the contributors x and y themselves: vouch them so their
    // mutual ratings carry real weight.
    for input_uid in [(30u16, x), (31u16, y)] {
        ring.trust_edges.push(vouch(0, seed, input_uid.1, uid(input_uid.0), t0 - 80, 80));
    }
    let mut no_ring = ring.clone();

    // The ring evidence: x and y share a claim (only in `ring`).
    ring.records.push(edge(
        kind::KIND_CLAIM_ATTEST,
        x,
        uid(40),
        t0 + 25,
        encode_claim("shared", B256::ZERO, "u", &[x, y], &[50, 50]),
    ));
    // An independent third contributor competes for the pool — without one, the pair's
    // combined take is the whole contributor mass by normalization and no internal
    // discount could ever show up in payouts.
    let z = addr(0x56);
    let c3 = uid(45);
    for input in [&mut ring, &mut no_ring] {
        input.records.push(edge(
            kind::KIND_CLAIM_ATTEST,
            z,
            c3,
            t0 + 26,
            encode_claim("z", B256::ZERO, "u", &[z], &[100]),
        ));
    }
    // The mutual rating (both worlds): x rates y's claim 100, y rates x's claim 100.
    for input in [&mut ring, &mut no_ring] {
        input.records.push(edge(
            kind::KIND_VALUATION_ATTEST,
            x,
            uid(41),
            t0 + 30,
            encode_valuation(c2, 100),
        ));
        input.records.push(edge(
            kind::KIND_VALUATION_ATTEST,
            y,
            uid(42),
            t0 + 40,
            encode_valuation(c1, 100),
        ));
        // Independent raters anchor the outside claim (and lightly the pair's claims).
        input.records.push(edge(
            kind::KIND_VALUATION_ATTEST,
            r1,
            uid(43),
            t0 + 50,
            encode_valuation(c1, 50),
        ));
        input.records.push(edge(
            kind::KIND_VALUATION_ATTEST,
            r1,
            uid(46),
            t0 + 55,
            encode_valuation(c3, 50),
        ));
        input.records.push(edge(
            kind::KIND_VALUATION_ATTEST,
            r2,
            uid(44),
            t0 + 60,
            encode_valuation(c2, 50),
        ));
        input.records.push(edge(
            kind::KIND_VALUATION_ATTEST,
            r2,
            uid(47),
            t0 + 65,
            encode_valuation(c3, 50),
        ));
    }

    // Eligibility: in the ring world, both mutual ratings are discounted at 0.5.
    let rep = reputation(&ring.trust_edges, &ring.params);
    let state = contributions_core::reconcile::reconcile(&ring.records, &ring.params);
    let elig = eligibility(&state, &rep, &ring.params);
    let discounted: Vec<_> = elig
        .eligible
        .iter()
        .filter(|v| v.discount_fp == ring.params.collaborator_mult_fp)
        .map(|v| (v.rater, v.claim_uid))
        .collect();
    assert!(discounted.contains(&(x, c2)), "x's rating of y's claim must be discounted");
    assert!(discounted.contains(&(y, c1)), "y's rating of x's claim must be discounted");

    // And the ring pair's combined take from their SOLO claims is strictly lower than in
    // the no-ring world (their mutual boost is cut in half; independent anchors unchanged).
    let ring_result = compute(&ring);
    let no_ring_result = compute(&no_ring);
    let ring_take = payout_of(&ring_result.scores, x) + payout_of(&ring_result.scores, y);
    let no_ring_take = payout_of(&no_ring_result.scores, x) + payout_of(&no_ring_result.scores, y);
    assert!(
        ring_take < no_ring_take,
        "co-claiming must strictly reduce the mutual-rating boost: {ring_take} !< {no_ring_take}"
    );
}

/// §5.1 sybil resistance: a swarm of fresh (unvouched) raters all rating the attacker's
/// claim 100 moves NOTHING, even with `minRaterRep = 0` — teleport-dust rep for
/// out-of-graph addresses is exactly zero weight.
#[test]
fn unvouched_rater_swarm_is_inert_even_without_min_rep() {
    let (mut sc, [_, r1, _, x, _y], [c1, c2]) = base(params());
    sc.params.min_rater_rep_fp = U256::ZERO;
    let t0 = sc.params.round_start;
    // One honest rating so the round has value.
    sc.records.push(edge(
        kind::KIND_VALUATION_ATTEST,
        r1,
        uid(50),
        t0 + 30,
        encode_valuation(c2, 60),
    ));
    let base_result = compute(&sc);

    for i in 0..20u16 {
        let sybil = Address::new([0xE0 ^ (i as u8 + 1); 20]);
        sc.records.push(edge(
            kind::KIND_VALUATION_ATTEST,
            sybil,
            uid(100 + i),
            t0 + 40 + i as u64,
            encode_valuation(c1, 100),
        ));
    }
    let swarm_result = compute(&sc);
    assert_eq!(base_result.scores, swarm_result.scores, "unvouched swarm moved payouts");
    assert_eq!(payout_of(&swarm_result.scores, x), U256::ZERO, "swarm minted value for x");
}

/// §5.1 "everything revocable, last-write-wins, no ordering games": permuting the fold
/// order of records with DISTINCT timestamps changes nothing (the canonical order is
/// (timestamp, fold_index); distinct timestamps make fold order irrelevant) — and the
/// revocation of a uid excludes it regardless of where the revoke sits in the log.
#[test]
fn fold_order_games_are_inert() {
    let (mut sc, [_, r1, r2, _x, _y], [c1, c2]) = base(params());
    let t0 = sc.params.round_start;
    sc.records.push(edge(
        kind::KIND_VALUATION_ATTEST,
        r1,
        uid(60),
        t0 + 30,
        encode_valuation(c1, 80),
    ));
    sc.records.push(edge(
        kind::KIND_VALUATION_ATTEST,
        r2,
        uid(61),
        t0 + 40,
        encode_valuation(c2, 70),
    ));
    sc.records.push(edge(
        kind::KIND_VALUATION_ATTEST,
        r1,
        uid(62),
        t0 + 50,
        encode_valuation(c1, 20),
    )); // LWW winner
    sc.records.push(edge(
        kind::KIND_VALUATION_REVOKE,
        r2,
        uid(61),
        t0 + 60,
        encode_valuation(c2, 70),
    ));

    let base_result = compute(&sc);

    // Reverse the record log (a hostile prover cannot do this — the accumulator pins the
    // order — but the SEMANTICS must not depend on it either).
    let mut reversed = sc.clone();
    reversed.records.reverse();
    let rev_result = compute(&reversed);
    assert_eq!(base_result.scores, rev_result.scores, "fold order changed payouts");
    // The input commitments differ, of course — only the semantics are order-free.
    assert_ne!(base_result.journal.anchor_acc, rev_result.journal.anchor_acc);
}

/// §2.2 consent: rejection is not gameable by re-nomination — a contributor who rejected
/// keeps earning zero even if the attacker re-attests the same claim content under a new
/// uid (the response is per-claim, so the nominee must re-reject; verify the UNACCEPTED
/// discount still caps the re-nominated share at half weight).
#[test]
fn renomination_after_reject_is_capped_at_unaccepted_weight() {
    let (mut sc, [_, r1, _, _x, _y], [c1_anchor, _]) = base(params());
    let t0 = sc.params.round_start;
    let victim = addr(0x77);
    let nom1 = uid(70);
    let nom2 = uid(71);
    // Nominate, victim rejects.
    sc.records.push(edge(
        kind::KIND_CLAIM_ATTEST,
        addr(0x78),
        nom1,
        t0 + 30,
        encode_claim("n1", B256::ZERO, "u", &[victim], &[100]),
    ));
    sc.records.push(edge(
        kind::KIND_RESPONSE_ATTEST,
        victim,
        uid(72),
        t0 + 40,
        encode_response(nom1, 2),
    ));
    // Attacker re-attests the nomination as a fresh claim; victim hasn't seen it yet.
    sc.records.push(edge(
        kind::KIND_CLAIM_ATTEST,
        addr(0x78),
        nom2,
        t0 + 50,
        encode_claim("n1", B256::ZERO, "u", &[victim], &[100]),
    ));
    // A reputable rater rates both nominations highly — and an independent claim too,
    // so the victim's consent weight is measured against real competition (with the
    // victim as the only valued contributor, normalization would hand them the whole
    // contributor mass regardless of consent).
    sc.records.push(edge(
        kind::KIND_VALUATION_ATTEST,
        r1,
        uid(73),
        t0 + 60,
        encode_valuation(nom1, 100),
    ));
    sc.records.push(edge(
        kind::KIND_VALUATION_ATTEST,
        r1,
        uid(74),
        t0 + 70,
        encode_valuation(nom2, 100),
    ));
    sc.records.push(edge(
        kind::KIND_VALUATION_ATTEST,
        r1,
        uid(76),
        t0 + 75,
        encode_valuation(c1_anchor, 80),
    ));

    let result = compute(&sc);
    // The rejected claim pays the victim nothing. The re-nominated claim pays at most the
    // unaccepted HALF weight — compare against a world where the victim accepted nom2.
    let mut accepted = sc.clone();
    accepted.records.push(edge(
        kind::KIND_RESPONSE_ATTEST,
        victim,
        uid(75),
        t0 + 80,
        encode_response(nom2, 1),
    ));
    let accepted_result = compute(&accepted);
    let got = payout_of(&result.scores, victim);
    let if_accepted = payout_of(&accepted_result.scores, victim);
    assert!(got > U256::ZERO, "unaccepted re-nomination still accrues (at half weight)");
    assert!(
        got < if_accepted,
        "unresponded share must earn strictly less than an accepted one: {got} !< {if_accepted}"
    );
}
