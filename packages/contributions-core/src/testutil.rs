//! Test/fixture support: record builders and a canonical dev params set. NOT guest semantics —
//! used by this crate's tests, the worked-example fixture, and the golden exporter.

use crate::records::{encode_claim, encode_response, encode_valuation};
use crate::Params;
use alloy_primitives::{Address, B256, U256};
use pagerank_core::RawEdge;

pub const A: Address = Address::new([0xA1; 20]);
pub const B: Address = Address::new([0xB1; 20]);
pub const C: Address = Address::new([0xC1; 20]);

/// A contribution record as folded (attester = the actor; recipient unused by v1 semantics).
pub fn edge(kind: u8, attester: Address, uid: B256, ts: u64, data: Vec<u8>) -> RawEdge {
    RawEdge { kind, attester, recipient: Address::ZERO, uid, block_timestamp: ts, data }
}

/// A vouch edge for the trust lane: `data = abi.encode(string comment, uint256 confidence)`
/// with confidence in head slot 1 (weight_field_index 1).
pub fn vouch(
    kind: u8,
    attester: Address,
    recipient: Address,
    uid: B256,
    ts: u64,
    confidence: u64,
) -> RawEdge {
    let mut data = vec![0u8; 64];
    data[32..].copy_from_slice(&U256::from(confidence).to_be_bytes::<32>());
    RawEdge { kind, attester, recipient, uid, block_timestamp: ts, data }
}

/// Claim payload with default title/uri/contentHash.
pub fn claim_data(contributors_shares: &[(Address, u32)]) -> Vec<u8> {
    let contributors: Vec<Address> = contributors_shares.iter().map(|(a, _)| *a).collect();
    let shares: Vec<u32> = contributors_shares.iter().map(|(_, s)| *s).collect();
    encode_claim("test claim", B256::from([0x77; 32]), "ipfs://test", &contributors, &shares)
}

pub fn response_data(claim_uid: B256, response: u8) -> Vec<u8> {
    encode_response(claim_uid, response)
}

pub fn valuation_data(claim_uid: B256, score: u8) -> Vec<u8> {
    encode_valuation(claim_uid, score)
}

// ---------------------------------------------------------------------------
// The 6-persona worked example (GOAL.md M1) — the cross-lane oracle fixture,
// reused by the golden vectors (M1), guest execute parity (M2), the indexer
// (M3), the TS port (M4), and the seeded e2e round (M5).
//
// Personas: SEED (trusted seed; rates), ALICE (solo contributor; nominator),
// BOB (co-contributor + rater), CAROL (co-contributor + rater — the BOB/CAROL
// co-claim makes her C5 rating a collaborator-discount case), DAVE (rater +
// consent-pending nominee), EVE (nominated, rejects; dust rep — her rating is
// filtered by minRaterRep).
//
// Claims: C1 ALICE self-claim; C2 BOB+CAROL co-claim (CAROL accepts);
// C3 nomination by ALICE of EVE (rejects) + DAVE (no response → unaccepted);
// C4 out-of-window (inert, incl. its valuation); C5 BOB self-claim.
// Valuations exercise: LWW re-rate (DAVE on C1), self-valuation drop (ALICE
// on C1), below-min-rep drop (EVE on C1), collaborator discount (CAROL on
// C5), and an inert valuation of the out-of-window C4.
// ---------------------------------------------------------------------------

pub const SEED: Address = Address::new([0x5E; 20]);
pub const ALICE: Address = Address::new([0xAA; 20]);
pub const BOB: Address = Address::new([0xB0; 20]);
pub const CAROL: Address = Address::new([0xCA; 20]);
pub const DAVE: Address = Address::new([0xDA; 20]);
pub const EVE: Address = Address::new([0xEE; 20]);

pub const C1: B256 = B256::new([0x01; 32]);
pub const C2: B256 = B256::new([0x02; 32]);
pub const C3: B256 = B256::new([0x03; 32]);
pub const C4: B256 = B256::new([0x04; 32]);
pub const C5: B256 = B256::new([0x05; 32]);

fn uid(n: u8) -> B256 {
    let mut b = [0u8; 32];
    b[0] = 0x10;
    b[31] = n;
    B256::new(b)
}

/// The worked example's complete guest input.
pub fn fixture() -> crate::compute::GuestInput {
    let mut p = params();
    p.trusted_seeds = vec![SEED];
    p.min_rater_rep_fp = U256::from(1_000_000_000u64); // ε ≫ 0, ≪ any vouched rep
    let t0 = p.round_start;

    let trust_edges = vec![
        vouch(0, SEED, ALICE, uid(1), t0 - 5000, 100),
        vouch(0, SEED, BOB, uid(2), t0 - 4900, 80),
        vouch(0, SEED, CAROL, uid(3), t0 - 4800, 60),
        vouch(0, SEED, DAVE, uid(4), t0 - 4700, 90),
        vouch(0, ALICE, BOB, uid(5), t0 - 4600, 50),
        vouch(0, DAVE, CAROL, uid(6), t0 - 4500, 40),
    ];

    let records = vec![
        // Claims.
        edge(crate::kind::KIND_CLAIM_ATTEST, ALICE, C1, t0 + 100, claim_data(&[(ALICE, 100)])),
        edge(
            crate::kind::KIND_CLAIM_ATTEST,
            BOB,
            C2,
            t0 + 200,
            claim_data(&[(BOB, 60), (CAROL, 40)]),
        ),
        edge(
            crate::kind::KIND_CLAIM_ATTEST,
            ALICE,
            C3,
            t0 + 300,
            claim_data(&[(EVE, 50), (DAVE, 50)]),
        ),
        edge(crate::kind::KIND_CLAIM_ATTEST, BOB, C4, t0 - 100, claim_data(&[(BOB, 100)])),
        edge(crate::kind::KIND_CLAIM_ATTEST, BOB, C5, t0 + 400, claim_data(&[(BOB, 100)])),
        // Responses.
        edge(crate::kind::KIND_RESPONSE_ATTEST, CAROL, uid(0x11), t0 + 500, response_data(C2, 1)),
        edge(crate::kind::KIND_RESPONSE_ATTEST, EVE, uid(0x12), t0 + 600, response_data(C3, 2)),
        // Valuations.
        edge(crate::kind::KIND_VALUATION_ATTEST, DAVE, uid(0x21), t0 + 700, valuation_data(C1, 80)),
        edge(crate::kind::KIND_VALUATION_ATTEST, DAVE, uid(0x22), t0 + 800, valuation_data(C2, 60)),
        edge(
            crate::kind::KIND_VALUATION_ATTEST,
            CAROL,
            uid(0x23),
            t0 + 900,
            valuation_data(C1, 50),
        ),
        edge(
            crate::kind::KIND_VALUATION_ATTEST,
            CAROL,
            uid(0x24),
            t0 + 1000,
            valuation_data(C5, 90),
        ),
        edge(crate::kind::KIND_VALUATION_ATTEST, BOB, uid(0x25), t0 + 1100, valuation_data(C1, 70)),
        edge(
            crate::kind::KIND_VALUATION_ATTEST,
            ALICE,
            uid(0x26),
            t0 + 1200,
            valuation_data(C1, 100),
        ),
        edge(
            crate::kind::KIND_VALUATION_ATTEST,
            EVE,
            uid(0x27),
            t0 + 1300,
            valuation_data(C1, 100),
        ),
        edge(
            crate::kind::KIND_VALUATION_ATTEST,
            SEED,
            uid(0x28),
            t0 + 1400,
            valuation_data(C1, 40),
        ),
        edge(
            crate::kind::KIND_VALUATION_ATTEST,
            SEED,
            uid(0x29),
            t0 + 1500,
            valuation_data(C5, 60),
        ),
        edge(
            crate::kind::KIND_VALUATION_ATTEST,
            DAVE,
            uid(0x2A),
            t0 + 1600,
            valuation_data(C4, 50),
        ),
        // DAVE re-rates C1 (LWW: 90 supersedes 80).
        edge(
            crate::kind::KIND_VALUATION_ATTEST,
            DAVE,
            uid(0x2B),
            t0 + 1700,
            valuation_data(C1, 90),
        ),
        // CAROL rates the nomination C3 (no conflict: her co-claimant set is {BOB}).
        edge(
            crate::kind::KIND_VALUATION_ATTEST,
            CAROL,
            uid(0x2C),
            t0 + 1800,
            valuation_data(C3, 30),
        ),
    ];

    crate::compute::GuestInput { trust_edges, records, params: p }
}

/// The canonical dev params: 1e18 scale, standard trust params, IF golden-vector round window,
/// 0.5 consent/collaborator mults, 1% carve-out, 5000e6 pool.
pub fn params() -> Params {
    let s = U256::from(1_000_000_000_000_000_000u64);
    Params {
        damping_fp: s * U256::from(85) / U256::from(100),
        tolerance_fp: s / U256::from(1_000_000u64),
        max_iterations: 100,
        min_weight_fp: U256::ZERO,
        max_weight_fp: U256::from(100) * s,
        trust_multiplier_fp: U256::from(2) * s,
        trust_share_fp: s * U256::from(15) / U256::from(100),
        trust_decay_fp: s * U256::from(80) / U256::from(100),
        trusted_seeds: vec![],
        precision_scale: s,
        weight_field_index: 1,
        round_start: 1_760_000_000,
        round_end: 1_760_604_800,
        unaccepted_mult_fp: s / U256::from(2),
        collaborator_mult_fp: s / U256::from(2),
        min_rater_rep_fp: U256::ZERO,
        evaluator_carveout_bps: 100,
        total_pool: U256::from(5_000_000_000u64),
        claim_schema_uid: B256::from([0xA1; 32]),
        response_schema_uid: B256::from([0xB2; 32]),
        valuation_schema_uid: B256::from([0xC3; 32]),
    }
}
