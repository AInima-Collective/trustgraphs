//! The M1 property suite (GOAL.md M1): randomized scenarios driven by a deterministic LCG
//! (no new deps, reproducible failures — print the round seed on assert). Each property
//! is checked over many generated rounds.
//!
//! A note on the padding property: normalization means diluting one claim's consent mass
//! makes every OTHER claim's take grow or stay — so the meaningful anti-gaming direction is
//! that the padded claim's contributor set (attacker + sybil combined) can never MINT: its
//! combined take never exceeds the unpadded combined take (hypercerts E4 rule).

use alloy_primitives::{Address, B256, U256};
use contributions_core::compute::{compute, GuestInput};
use contributions_core::records::{encode_claim, encode_response, encode_valuation};
use contributions_core::testutil::{edge, params, vouch};
use contributions_core::{kind, Params};
use pagerank_core::RawEdge;

/// Deterministic LCG (numerical recipes constants).
struct Rng(u64);
impl Rng {
    fn next(&mut self) -> u64 {
        self.0 = self.0.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
        self.0 >> 16
    }
    fn below(&mut self, n: u64) -> u64 {
        self.next() % n
    }
    fn addr(&mut self, i: u64) -> Address {
        let mut b = [0u8; 20];
        b[..8].copy_from_slice(&(i + 1).to_be_bytes());
        b[19] = 0x77;
        Address::new(b)
    }
}

struct Scenario {
    input: GuestInput,
    uid_counter: u64,
}

impl Scenario {
    fn uid(&mut self) -> B256 {
        self.uid_counter += 1;
        let mut b = [0u8; 32];
        b[..8].copy_from_slice(&self.uid_counter.to_be_bytes());
        B256::new(b)
    }
}

/// Generate a random round: 4–8 personas, a vouch graph seeded from persona 0, 1–4 claims
/// with random contributor sets/shares, random responses, random valuations.
fn generate(seed: u64) -> Scenario {
    let mut rng = Rng(seed);
    let n = 4 + rng.below(5); // personas
    let personas: Vec<Address> = (0..n).map(|i| rng.addr(i)).collect();

    let mut p: Params = params();
    p.trusted_seeds = vec![personas[0]];
    p.min_rater_rep_fp = U256::ZERO;
    let t0 = p.round_start;

    let mut sc = Scenario {
        input: GuestInput { trust_edges: vec![], records: vec![], params: p, binding: Default::default() },
        uid_counter: 0,
    };

    // Vouches: seed vouches a random subset; some random extra edges.
    for (i, a) in personas.iter().enumerate().skip(1) {
        if rng.below(4) > 0 {
            let u = sc.uid();
            sc.input.trust_edges.push(vouch(
                0,
                personas[0],
                *a,
                u,
                t0 - 9000 + i as u64,
                20 + rng.below(80),
            ));
        }
    }
    for _ in 0..rng.below(2 * n) {
        let from = personas[rng.below(n) as usize];
        let to = personas[rng.below(n) as usize];
        if from != to {
            let u = sc.uid();
            let ts = t0 - 5000 + rng.below(1000);
            sc.input.trust_edges.push(vouch(0, from, to, u, ts, 1 + rng.below(100)));
        }
    }

    // Claims.
    let claim_count = 1 + rng.below(4);
    let mut claim_uids = Vec::new();
    for _ in 0..claim_count {
        let attester = personas[rng.below(n) as usize];
        let k = 1 + rng.below(3.min(n)) as usize;
        let mut contributors = Vec::new();
        let mut shares = Vec::new();
        for _ in 0..k {
            contributors.push(personas[rng.below(n) as usize]);
            shares.push(1 + rng.below(100) as u32);
        }
        let u = sc.uid();
        let ts = t0 + 1 + rng.below(1000);
        sc.input.records.push(edge(
            kind::KIND_CLAIM_ATTEST,
            attester,
            u,
            ts,
            encode_claim("c", B256::ZERO, "u", &contributors, &shares),
        ));
        claim_uids.push((u, contributors));
    }

    // Responses (random accept/reject from random personas — non-contributors are ignored).
    for _ in 0..rng.below(2 * claim_count) {
        let (cu, _) = &claim_uids[rng.below(claim_count) as usize];
        let responder = personas[rng.below(n) as usize];
        let u = sc.uid();
        let ts = t0 + 2000 + rng.below(500);
        let resp = 1 + rng.below(2) as u8;
        sc.input.records.push(edge(
            kind::KIND_RESPONSE_ATTEST,
            responder,
            u,
            ts,
            encode_response(*cu, resp),
        ));
    }

    // Valuations.
    for _ in 0..(1 + rng.below(3 * claim_count)) {
        let (cu, _) = &claim_uids[rng.below(claim_count) as usize];
        let rater = personas[rng.below(n) as usize];
        let u = sc.uid();
        let ts = t0 + 3000 + rng.below(500);
        let score = rng.below(101) as u8;
        sc.input.records.push(edge(
            kind::KIND_VALUATION_ATTEST,
            rater,
            u,
            ts,
            encode_valuation(*cu, score),
        ));
    }

    sc
}

fn total(scores: &[(Address, U256)]) -> U256 {
    scores.iter().map(|(_, v)| *v).fold(U256::ZERO, |a, b| a + b)
}

fn payout_of(scores: &[(Address, U256)], a: Address) -> U256 {
    scores.iter().find(|(x, _)| *x == a).map(|(_, v)| *v).unwrap_or(U256::ZERO)
}

#[test]
fn pool_is_distributed_exactly_or_not_at_all() {
    for seed in 0..120 {
        let sc = generate(seed);
        let r = compute(&sc.input);
        let t = total(&r.scores);
        assert!(
            t == sc.input.params.total_pool || t.is_zero(),
            "seed {seed}: distributed {t} of {}",
            sc.input.params.total_pool
        );
        assert_eq!(t, r.journal.total_value, "seed {seed}: journal totalValue mismatch");
    }
}

/// Append an accept response from every listed address (idempotent for the scoring rules:
/// explicit accept ≡ implicit accept for attester/self shares).
fn accept_all(sc: &mut Scenario, claim_uid: B256, ts: u64, who: &[Address]) {
    for a in who {
        let u = sc.uid();
        sc.input.records.push(edge(
            kind::KIND_RESPONSE_ATTEST,
            *a,
            u,
            ts,
            encode_response(claim_uid, 1),
        ));
    }
}

/// The recapture bound (CONTRIBUTION_FUNDING.md §5.1, sharpened at M1 — see DEVIATIONS #5):
/// with burned consent mass (a rejected share), an accepting sybil CAN recapture value — but
/// never beyond the claim's FULL-CONSENT ceiling. Controlled scenario so the measured
/// addresses earn only from the padded claim (set-level comparisons over random entangled
/// scenarios are ill-posed: shrinking one claim's mass grows every other claim's take).
#[test]
fn padding_recapture_never_exceeds_the_full_consent_ceiling() {
    let s_addr = Rng(1).addr(0);
    let x = Rng(1).addr(1);
    let z = Rng(1).addr(2);
    let y = Rng(1).addr(3);
    let rater = Rng(1).addr(4);
    let sybil = Rng(1).addr(5);

    let build = |pad: bool, full_consent: bool| -> GuestInput {
        let mut p: Params = params();
        p.trusted_seeds = vec![s_addr];
        let t0 = p.round_start;
        let c1 = B256::new([0x01; 32]);
        let c2 = B256::new([0x02; 32]);
        let mut uid_n = 0u64;
        let mut uid = move || {
            uid_n += 1;
            let mut b = [0u8; 32];
            b[..8].copy_from_slice(&uid_n.to_be_bytes());
            b[31] = 0x99;
            B256::new(b)
        };
        let trust_edges = vec![vouch(0, s_addr, rater, uid(), t0 - 1000, 80)];
        let (contributors, shares): (Vec<Address>, Vec<u32>) =
            if pad { (vec![x, z, sybil], vec![50, 50, 100]) } else { (vec![x, z], vec![50, 50]) };
        let mut records = vec![
            edge(
                kind::KIND_CLAIM_ATTEST,
                x,
                c1,
                t0 + 10,
                encode_claim("c1", B256::ZERO, "u", &contributors, &shares),
            ),
            edge(
                kind::KIND_CLAIM_ATTEST,
                y,
                c2,
                t0 + 20,
                encode_claim("c2", B256::ZERO, "u", &[y], &[100]),
            ),
            edge(kind::KIND_VALUATION_ATTEST, rater, uid(), t0 + 30, encode_valuation(c1, 60)),
            edge(kind::KIND_VALUATION_ATTEST, rater, uid(), t0 + 40, encode_valuation(c2, 40)),
        ];
        if full_consent {
            records.push(edge(
                kind::KIND_RESPONSE_ATTEST,
                z,
                uid(),
                t0 + 50,
                encode_response(c1, 1),
            ));
        } else {
            records.push(edge(
                kind::KIND_RESPONSE_ATTEST,
                z,
                uid(),
                t0 + 50,
                encode_response(c1, 2),
            ));
        }
        if pad {
            records.push(edge(
                kind::KIND_RESPONSE_ATTEST,
                sybil,
                uid(),
                t0 + 60,
                encode_response(c1, 1),
            ));
        }
        GuestInput { trust_edges, records, params: p, binding: Default::default() }
    };

    // Ceiling: unpadded, Z accepts (claim 1 at full consent).
    let ceiling = compute(&build(false, true).clone());
    // Attack: Z rejected (burned mass), sybil padded in and accepting.
    let padded = compute(&build(true, false).clone());

    let set = [x, z, sybil];
    let ceiling_take: U256 =
        set.iter().map(|a| payout_of(&ceiling.scores, *a)).fold(U256::ZERO, |a, b| a + b);
    let padded_take: U256 =
        set.iter().map(|a| payout_of(&padded.scores, *a)).fold(U256::ZERO, |a, b| a + b);
    assert!(!ceiling_take.is_zero());
    // The recapture is real (padding with burned mass beats the burned unpadded claim)…
    let burned = compute(&build(false, false).clone());
    let burned_take: U256 =
        set.iter().map(|a| payout_of(&burned.scores, *a)).fold(U256::ZERO, |a, b| a + b);
    assert!(padded_take > burned_take, "recapture scenario should recapture");
    // …but never exceeds the full-consent ceiling (quantization dust tolerance).
    assert!(
        padded_take <= ceiling_take + U256::from(64u64),
        "padded set {padded_take} exceeded full-consent ceiling {ceiling_take}"
    );
}

/// The crisp E4 analog: when every original share is fully consented (no burned mass to
/// recapture), padding cannot increase the set's combined take at all.
#[test]
fn padding_a_fully_consented_claim_never_mints() {
    let mut checked = 0;
    for seed in 0..120 {
        let base_sc = generate(seed);
        let claim_idx =
            base_sc.input.records.iter().position(|e| e.kind == kind::KIND_CLAIM_ATTEST).unwrap();
        let claim = base_sc.input.records[claim_idx].clone();
        let decoded = contributions_core::records::decode_claim(&claim.data).unwrap();

        let mut base_full = generate(seed);
        accept_all(&mut base_full, claim.uid, claim.block_timestamp + 5000, &decoded.contributors);
        let base = compute(&base_full.input);
        if total(&base.scores).is_zero() {
            continue;
        }

        let mut padded_sc = generate(seed);
        let mut rng = Rng(seed ^ 0xDEAD);
        let sybil = rng.addr(900 + seed);
        let mut contributors = decoded.contributors.clone();
        let mut shares = decoded.shares.clone();
        contributors.push(sybil);
        shares.push(1 + rng.below(200) as u32);
        padded_sc.input.records[claim_idx].data =
            encode_claim("c", B256::ZERO, "u", &contributors, &shares);
        accept_all(&mut padded_sc, claim.uid, claim.block_timestamp + 5000, &contributors);
        let padded = compute(&padded_sc.input);

        let base_take: U256 =
            contributors.iter().map(|a| payout_of(&base.scores, *a)).fold(U256::ZERO, |a, b| a + b);
        let padded_take: U256 = contributors
            .iter()
            .map(|a| payout_of(&padded.scores, *a))
            .fold(U256::ZERO, |a, b| a + b);
        assert!(
            padded_take <= base_take + U256::from(64u64),
            "seed {seed}: fully-consented padding minted {padded_take} > {base_take}"
        );
        checked += 1;
    }
    assert!(checked > 40, "too few effective padding checks: {checked}");
}

#[test]
fn self_valuations_and_out_of_window_records_are_inert() {
    for seed in 0..120 {
        let mut sc = generate(seed);
        let base = compute(&sc.input);

        // Add: a self-valuation by the first claim's first contributor, an out-of-window claim
        // by a fresh address (with a valuation of it), and a pre-window valuation of a live claim
        // (valuations have no window — but one referencing a DEAD claim must be inert).
        let claim =
            sc.input.records.iter().find(|e| e.kind == kind::KIND_CLAIM_ATTEST).cloned().unwrap();
        let decoded = contributions_core::records::decode_claim(&claim.data).unwrap();
        let self_rater = decoded.contributors[0];
        let u1 = sc.uid();
        sc.input.records.push(edge(
            kind::KIND_VALUATION_ATTEST,
            self_rater,
            u1,
            claim.block_timestamp + 6000,
            encode_valuation(claim.uid, 100),
        ));
        let mut rng = Rng(seed ^ 0xBEEF);
        let stranger = rng.addr(800 + seed);
        let dead_uid = sc.uid();
        let ts_out = sc.input.params.round_end + 1 + rng.below(999);
        sc.input.records.push(edge(
            kind::KIND_CLAIM_ATTEST,
            stranger,
            dead_uid,
            ts_out,
            encode_claim("late", B256::ZERO, "u", &[stranger], &[7]),
        ));
        let u2 = sc.uid();
        sc.input.records.push(edge(
            kind::KIND_VALUATION_ATTEST,
            sc.input.trust_edges.first().map(|e| e.attester).unwrap_or(stranger),
            u2,
            ts_out + 1,
            encode_valuation(dead_uid, 100),
        ));

        let extended = compute(&sc.input);
        assert_eq!(base.scores, extended.scores, "seed {seed}: inert records changed payouts");
        assert_eq!(base.journal.output_root, extended.journal.output_root);
        // The input commitment DID change (they are real folded records).
        assert_ne!(base.journal.anchor_acc, extended.journal.anchor_acc);
    }
}

#[test]
fn zero_carveout_means_zero_rater_leaves() {
    for seed in 0..120 {
        let mut sc = generate(seed);
        sc.input.params.evaluator_carveout_bps = 0;
        // A pure rater: fresh address, vouched by the seed (nonzero rep), rates every claim,
        // contributes nothing.
        let mut rng = Rng(seed ^ 0xF00D);
        let pure_rater = rng.addr(700 + seed);
        let seed_addr = sc.input.params.trusted_seeds[0];
        let u = sc.uid();
        sc.input.trust_edges.push(vouch(
            0,
            seed_addr,
            pure_rater,
            u,
            sc.input.params.round_start - 100,
            50,
        ));
        let claim_uids: Vec<B256> = sc
            .input
            .records
            .iter()
            .filter(|e| e.kind == kind::KIND_CLAIM_ATTEST)
            .map(|e| e.uid)
            .collect();
        for cu in claim_uids {
            let u = sc.uid();
            let ts = sc.input.params.round_start + 4000;
            sc.input.records.push(edge(
                kind::KIND_VALUATION_ATTEST,
                pure_rater,
                u,
                ts,
                encode_valuation(cu, 80),
            ));
        }
        let r = compute(&sc.input);
        assert_eq!(
            payout_of(&r.scores, pure_rater),
            U256::ZERO,
            "seed {seed}: β=0 but a pure rater earned"
        );
    }
}

#[test]
fn rejected_consent_zeroes_that_share() {
    for seed in 0..120 {
        let mut sc = generate(seed);
        // A fresh contributor is nominated on a fresh claim, rejects, and never rates:
        // they must never appear in the payouts.
        let mut rng = Rng(seed ^ 0xCAFE);
        let refuser = rng.addr(600 + seed);
        let attester = sc.input.params.trusted_seeds[0];
        let cu = sc.uid();
        let t0 = sc.input.params.round_start;
        sc.input.records.push(edge(
            kind::KIND_CLAIM_ATTEST,
            attester,
            cu,
            t0 + 50,
            encode_claim("nom", B256::ZERO, "u", &[refuser], &[100]),
        ));
        let u = sc.uid();
        sc.input.records.push(edge(
            kind::KIND_RESPONSE_ATTEST,
            refuser,
            u,
            t0 + 60,
            encode_response(cu, 2),
        ));
        // Someone with rep rates the claim highly, so the share WOULD earn but for the reject.
        let u = sc.uid();
        sc.input.records.push(edge(
            kind::KIND_VALUATION_ATTEST,
            attester,
            u,
            t0 + 70,
            encode_valuation(cu, 100),
        ));

        let r = compute(&sc.input);
        assert_eq!(payout_of(&r.scores, refuser), U256::ZERO, "seed {seed}: rejected share earned");
    }
}

#[test]
fn below_min_rep_rater_is_a_no_op() {
    for seed in 0..120 {
        let mut sc = generate(seed);
        // Raise the bar above dust: any un-vouched rater is below it.
        sc.input.params.min_rater_rep_fp = U256::from(1_000_000_000u64);
        let base = compute(&sc.input);

        // A dust rater (no vouches at all) rates everything 100.
        let mut rng = Rng(seed ^ 0xD00F);
        let dust = rng.addr(500 + seed);
        let claim_uids: Vec<B256> = sc
            .input
            .records
            .iter()
            .filter(|e| e.kind == kind::KIND_CLAIM_ATTEST)
            .map(|e| e.uid)
            .collect();
        for cu in claim_uids {
            let u = sc.uid();
            let ts = sc.input.params.round_start + 4500;
            sc.input.records.push(edge(
                kind::KIND_VALUATION_ATTEST,
                dust,
                u,
                ts,
                encode_valuation(cu, 100),
            ));
        }
        let extended = compute(&sc.input);
        assert_eq!(base.scores, extended.scores, "seed {seed}: dust rater moved payouts");
        assert_eq!(payout_of(&extended.scores, dust), U256::ZERO);
    }
}
