//! Emit the contributions program's golden-vector family (`test/golden/contributions.json`),
//! independently reproduced in Solidity (`test/unit/golden/ContributionsGoldenVectors.t.sol`)
//! and TS (`frontend/lib/contributions/golden.test.ts`) so the four-way byte parity stays
//! enforced.
//!
//! Run: `cargo run -p contributions-core --example export_golden > test/golden/contributions.json`
//!
//! IF families: `params` (all 21 fields + seedSetRoot + paramsHash), `kinds` (the fold-tag
//! table), `leaf` (one contribution accumulator edge leaf), `blob` (canonical blob sample).
//! M1 extends this file with the full compute family (fixture records → journal).

use alloy_primitives::{hex, Address, B256, U256};
use contributions_core::{kind, params::params_hash, Params};
use pagerank_core::{encode, merkle};
use serde_json::json;

fn hx(b: &[u8]) -> String {
    format!("0x{}", hex::encode(b))
}

fn s() -> U256 {
    U256::from(1_000_000_000_000_000_000u64)
}

fn fp(n: u64, d: u64) -> U256 {
    s() * U256::from(n) / U256::from(d)
}

fn params() -> Params {
    Params {
        damping_fp: fp(85, 100),
        tolerance_fp: s() / U256::from(1_000_000u64),
        max_iterations: 100,
        min_weight_fp: U256::ZERO,
        max_weight_fp: U256::from(100) * s(),
        trust_multiplier_fp: U256::from(2) * s(),
        trust_share_fp: fp(15, 100),
        trust_decay_fp: fp(80, 100),
        trusted_seeds: vec![
            // Deliberately unsorted: the vector locks sort-independence.
            Address::from([0xBE; 20]),
            Address::from([0x11; 20]),
            Address::from([0x77; 20]),
        ],
        precision_scale: s(),
        weight_field_index: 1,
        round_start: 1_760_000_000,
        round_end: 1_760_604_800,
        unaccepted_mult_fp: fp(1, 2),
        collaborator_mult_fp: fp(1, 2),
        min_rater_rep_fp: U256::from(1_000_000_000u64),
        evaluator_carveout_bps: 100,
        // 5000 test-USDC (6 decimals) — the M5 round scale.
        total_pool: U256::from(5_000_000_000u64),
        claim_schema_uid: B256::from([0xA1; 32]),
        response_schema_uid: B256::from([0xB2; 32]),
        valuation_schema_uid: B256::from([0xC3; 32]),
    }
}

fn main() {
    let p = params();

    let mut sorted_seeds = p.trusted_seeds.clone();
    sorted_seeds.sort();
    let seed_set_root = merkle::seed_set_root(&sorted_seeds);
    let ph = params_hash(&p);

    let params_json = json!({
        "dampingFp": p.damping_fp.to_string(),
        "toleranceFp": p.tolerance_fp.to_string(),
        "maxIterations": p.max_iterations,
        "minWeightFp": p.min_weight_fp.to_string(),
        "maxWeightFp": p.max_weight_fp.to_string(),
        "trustMultiplierFp": p.trust_multiplier_fp.to_string(),
        "trustShareFp": p.trust_share_fp.to_string(),
        "trustDecayFp": p.trust_decay_fp.to_string(),
        "trustedSeeds": p.trusted_seeds.iter().map(|a| format!("{a:?}")).collect::<Vec<_>>(),
        "precisionScale": p.precision_scale.to_string(),
        "weightFieldIndex": p.weight_field_index,
        "roundStart": p.round_start,
        "roundEnd": p.round_end,
        "unacceptedMultFp": p.unaccepted_mult_fp.to_string(),
        "collaboratorMultFp": p.collaborator_mult_fp.to_string(),
        "minRaterRepFp": p.min_rater_rep_fp.to_string(),
        "evaluatorCarveoutBps": p.evaluator_carveout_bps,
        "totalPool": p.total_pool.to_string(),
        "claimSchemaUid": hx(p.claim_schema_uid.as_slice()),
        "responseSchemaUid": hx(p.response_schema_uid.as_slice()),
        "valuationSchemaUid": hx(p.valuation_schema_uid.as_slice()),
        "seedSetRoot": hx(seed_set_root.as_slice()),
        "paramsHash": hx(ph.as_slice()),
    });

    // The fold-kind table (INTERFACES.md §2).
    let kinds_json: Vec<_> = (0u8..=2)
        .flat_map(|si| {
            [false, true].into_iter().map(
                move |rv| json!({"schemaIndex": si, "isRevoke": rv, "kind": kind::kind(si, rv)}),
            )
        })
        .collect();

    // One contribution accumulator leaf (identical ABI to AttestationAccumulator; kind 4 =
    // valuation attested) and one fold step from a nonzero acc.
    let attester = Address::from([0x44; 20]);
    let recipient = Address::ZERO;
    let uid = B256::from([0x55; 32]);
    let ts: u64 = 1_760_100_000;
    // data = abi.encode(bytes32 claimUID, uint8 score): claimUID then score word.
    let mut data = Vec::with_capacity(64);
    data.extend_from_slice(&[0x66; 32]);
    data.extend_from_slice(&encode::word_u8(80));
    let data_hash = alloy_primitives::keccak256(&data);
    let leaf =
        encode::edge_leaf(kind::KIND_VALUATION_ATTEST, attester, recipient, uid, ts, data_hash);
    let prev_acc = B256::from([0x99; 32]);
    let folded = encode::fold(prev_acc, leaf);

    let leaf_json = json!({
        "kind": kind::KIND_VALUATION_ATTEST,
        "attester": format!("{attester:?}"),
        "recipient": format!("{recipient:?}"),
        "uid": hx(uid.as_slice()),
        "blockTimestamp": ts,
        "data": hx(&data),
        "dataHash": hx(data_hash.as_slice()),
        "leaf": hx(leaf.as_slice()),
        "prevAcc": hx(prev_acc.as_slice()),
        "foldedAcc": hx(folded.as_slice()),
    });

    // Canonical blob sample (INTERFACES.md §5) — same encoder as trust-graph lane 1.
    let scores =
        vec![(Address::from([0x01; 20]), U256::from(1_250_000u64)), (attester, U256::from(42u64))];
    let blob = zk_core::cid::canonical_blob(&scores);
    let digest = zk_core::cid::sha256(&blob);
    let blob_json = json!({
        "scores": scores
            .iter()
            .map(|(a, v)| json!({"account": format!("{a:?}"), "value": v.to_string()}))
            .collect::<Vec<_>>(),
        "blob": String::from_utf8(blob.clone()).unwrap(),
        "blobHex": hx(&blob),
        "ipfsHash": hx(&digest),
        "cid": zk_core::cid::cid_v1_raw(&digest),
    });

    let out = json!({
        "note": "GENERATED by `cargo run -p contributions-core --example export_golden`. \
                 Frozen interface: docs/contributions/INTERFACES.md.",
        "params": params_json,
        "kinds": kinds_json,
        "leaf": leaf_json,
        "blob": blob_json,
    });
    println!("{}", serde_json::to_string_pretty(&out).unwrap());
}
