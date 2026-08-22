//! Emit the contributions program's golden-vector family (`tests/golden/contributions.json`),
//! independently reproduced in Solidity (`contracts/test/unit/golden/ContributionsGoldenVectors.t.sol`)
//! and TS (`packages/frontend/lib/contributions/golden.test.ts`) so the four-way byte parity stays
//! enforced.
//!
//! Run: `cargo run -p contributions-core --example export_golden > tests/golden/contributions.json`
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

    // The M1 compute family: the 6-persona worked example (the cross-lane oracle) end to end —
    // full guest input, per-claim scores, final payouts, blob/CID, and the journal + digest.
    // The fixture already carries the journal-v3 bindings (non-zero, shared with every other
    // program's fixture), so the vectors, the prover CLI's built-in sample and the TS port all
    // commit the same two words.
    let input = contributions_core::testutil::fixture();
    let result = contributions_core::compute::compute(&input);
    let rep = contributions_core::compute::reputation(&input.trust_edges, &input.params);
    let state = contributions_core::reconcile::reconcile(&input.records, &input.params);
    let elig = contributions_core::compute::eligibility(&state, &rep, &input.params);
    let st2 = contributions_core::compute::stage2(&state, &rep, &elig, &input.params);

    let edge_json = |e: &pagerank_core::RawEdge| {
        json!({
            "kind": e.kind,
            "attester": format!("{:?}", e.attester),
            "recipient": format!("{:?}", e.recipient),
            "uid": hx(e.uid.as_slice()),
            "blockTimestamp": e.block_timestamp,
            "data": hx(&e.data),
        })
    };
    let fp = &input.params;
    let j = &result.journal;
    let encoded = pagerank_core::encode::journal_encoded(j);
    let compute_json = json!({
        "input": {
            "trustEdges": input.trust_edges.iter().map(edge_json).collect::<Vec<_>>(),
            "records": input.records.iter().map(edge_json).collect::<Vec<_>>(),
            "params": {
                "dampingFp": fp.damping_fp.to_string(),
                "toleranceFp": fp.tolerance_fp.to_string(),
                "maxIterations": fp.max_iterations,
                "minWeightFp": fp.min_weight_fp.to_string(),
                "maxWeightFp": fp.max_weight_fp.to_string(),
                "trustMultiplierFp": fp.trust_multiplier_fp.to_string(),
                "trustShareFp": fp.trust_share_fp.to_string(),
                "trustDecayFp": fp.trust_decay_fp.to_string(),
                "trustedSeeds": fp.trusted_seeds.iter().map(|a| format!("{a:?}")).collect::<Vec<_>>(),
                "precisionScale": fp.precision_scale.to_string(),
                "weightFieldIndex": fp.weight_field_index,
                "roundStart": fp.round_start,
                "roundEnd": fp.round_end,
                "unacceptedMultFp": fp.unaccepted_mult_fp.to_string(),
                "collaboratorMultFp": fp.collaborator_mult_fp.to_string(),
                "minRaterRepFp": fp.min_rater_rep_fp.to_string(),
                "evaluatorCarveoutBps": fp.evaluator_carveout_bps,
                "totalPool": fp.total_pool.to_string(),
                "claimSchemaUid": hx(fp.claim_schema_uid.as_slice()),
                "responseSchemaUid": hx(fp.response_schema_uid.as_slice()),
                "valuationSchemaUid": hx(fp.valuation_schema_uid.as_slice()),
            },
        },
        "reputation": rep.iter().map(|(a, v)| json!({"account": format!("{a:?}"), "repFp": v.to_string()})).collect::<Vec<_>>(),
        "claimScores": st2.claim_scores.iter().map(|(u, v)| json!({"claimUid": hx(u.as_slice()), "scoreFp": v.to_string()})).collect::<Vec<_>>(),
        "payouts": result.scores.iter().map(|(a, v)| json!({"account": format!("{a:?}"), "value": v.to_string()})).collect::<Vec<_>>(),
        "blob": String::from_utf8(result.blob.clone()).unwrap(),
        "cid": result.cid,
        "journal": {
            "acc": hx(j.acc.as_slice()),
            "leafCount": j.leaf_count,
            "anchorAcc": hx(j.anchor_acc.as_slice()),
            "anchorCount": j.anchor_count,
            "paramsHash": hx(j.params_hash.as_slice()),
            "outputRoot": hx(j.output_root.as_slice()),
            "ipfsHash": hx(j.ipfs_hash.as_slice()),
            "cidDigest": hx(j.cid_digest.as_slice()),
            "totalValue": j.total_value.to_string(),
            "skippedDigest": hx(j.skipped_digest.as_slice()),
            "recipient": hx(j.recipient.as_slice()),
            "instanceDomain": hx(j.instance_domain.as_slice()),
            "encoded": hx(&encoded),
            "digest": hx(pagerank_core::encode::journal_digest(j).as_slice()),
        },
    });

    let out = json!({
        "note": "GENERATED by `cargo run -p contributions-core --example export_golden`. \
                 Frozen interface: docs/build/contributions/interfaces.md.",
        "params": params_json,
        "kinds": kinds_json,
        "leaf": leaf_json,
        "blob": blob_json,
        "compute": compute_json,
    });
    println!("{}", serde_json::to_string_pretty(&out).unwrap());
}
