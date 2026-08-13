//! Emit canonical golden vectors consumed by `test/unit/GoldenVectors.t.sol`, which independently
//! recomputes every frozen byte format in Solidity and asserts equality (PLAN.md WP2, Risk R2).
//!
//! Run: `cargo run -p pagerank-core --example export_golden`

use alloy_primitives::{hex, Address, B256, U256};
use pagerank_core::compute::compute;
use pagerank_core::{
    encode, merkle, signer, GuestInput, Params, RawEdge, SelectionParams, SignerInput,
};
use serde_json::json;
use std::str::FromStr;

fn hx(b: &[u8]) -> String {
    format!("0x{}", hex::encode(b))
}

fn addr(b: u8) -> Address {
    Address::from([b; 20])
}

fn edge(kind: u8, from: u8, to: u8, uid: u8, ts: u64, weight: u64) -> RawEdge {
    let mut data = vec![0u8; 64];
    data[32..64].copy_from_slice(&U256::from(weight).to_be_bytes::<32>());
    RawEdge {
        kind,
        attester: addr(from),
        recipient: addr(to),
        uid: B256::from([uid; 32]),
        block_timestamp: ts,
        data,
    }
}

fn scale() -> U256 {
    U256::from(10u64).pow(U256::from(18u64))
}

fn fp(num: u64, den: u64) -> U256 {
    scale() * U256::from(num) / U256::from(den)
}

fn params() -> Params {
    let s = scale();
    Params {
        damping_fp: fp(85, 100),
        tolerance_fp: s / U256::from(1_000_000u64),
        max_iterations: 100,
        min_weight_fp: U256::ZERO,
        max_weight_fp: U256::from(100u64) * s,
        trust_multiplier_fp: U256::from(2u64) * s,
        trust_share_fp: fp(15, 100),
        trust_decay_fp: fp(80, 100),
        trusted_seeds: vec![addr(1), addr(3)],
        total_pool: U256::from(1_000_000_000_000_000_000_000_000u128),
        precision_scale: s,
        schema_uid: B256::from([0xAB; 32]),
        weight_field_index: 1,
        envelope0_domain_separators: vec![],
        lane2_max_head_age: 0,
        // Params-schema v2 domain separation. Deliberately non-zero so the vectors would catch a
        // port that silently defaults these fields away.
        accumulator: addr(0xAC),
        chain_id: 31337,
    }
}

/// The journal-v3 bindings the vectors pin. Both deliberately non-zero, and the domain is the
/// real derivation over a fixed `(snapshot, chainId)` pair, so the vectors catch a port that
/// silently drops either word or encodes the domain preimage differently.
fn binding() -> pagerank_core::Binding {
    pagerank_core::Binding {
        recipient: addr(0xBE),
        instance_domain: encode::instance_domain(addr(0x5A), 31337),
    }
}

fn main() {
    let edges =
        vec![edge(0, 1, 2, 1, 100, 50), edge(0, 2, 3, 2, 101, 75), edge(0, 3, 1, 3, 102, 90)];
    let input =
        GuestInput { edges: edges.clone(), params: params(), lane2: None, binding: binding() };
    let result = compute(&input);
    let j = &result.journal;

    // Standalone accumulator vectors for the first edge + full fold.
    let e0 = &edges[0];
    let e0_datahash = alloy_primitives::keccak256(&e0.data);
    let e0_leaf = encode::edge_leaf(
        e0.kind,
        e0.attester,
        e0.recipient,
        e0.uid,
        e0.block_timestamp,
        e0_datahash,
    );
    let (acc, leaf_count) = encode::accumulate(&edges);

    // Output tree: pick the first scored account and produce a proof.
    let leaves: Vec<B256> =
        result.scores.iter().map(|(a, v)| merkle::output_leaf(*a, *v)).collect();
    let tree = merkle::build_tree(leaves.clone());
    let (sample_acct, sample_val) = result.scores[0];
    let sample_leaf = merkle::output_leaf(sample_acct, sample_val);
    let sample_proof: Vec<String> =
        merkle::proof_for(&tree, sample_leaf).unwrap().iter().map(|b| hx(b.as_slice())).collect();

    let params_hash = encode::params_hash(&input.params);

    // Signer-sync selection: derive the Safe owner set + threshold + signer journal. The instance
    // domain is the real derivation over a fixed (module, chainId) pair — deliberately a DIFFERENT
    // address than the trust-graph binding's 0x5A so a port that cross-wires the two domains fails.
    let selection = SelectionParams { top_n: 3, min_threshold: 1, target_threshold_bps: 5000 };
    let signer_domain = encode::instance_domain(addr(0x5B), 31337);
    let signer_input = SignerInput {
        edges: edges.clone(),
        params: params(),
        selection,
        instance_domain: signer_domain,
    };
    let signer_result = signer::compute_signers(&signer_input);
    let sj = &signer_result.journal;
    let selection_params_hash = encode::selection_params_hash(&selection);

    // Params constituents + seedSetRoot, so Solidity can independently recompute paramsHash.
    let p = &input.params;
    let mut sorted_seeds = p.trusted_seeds.clone();
    sorted_seeds.sort();
    let seed_set_root = merkle::seed_set_root(&sorted_seeds);

    let out = json!({
        "params": {
            "dampingFp": p.damping_fp.to_string(),
            "toleranceFp": p.tolerance_fp.to_string(),
            "maxIterations": p.max_iterations,
            "minWeightFp": p.min_weight_fp.to_string(),
            "maxWeightFp": p.max_weight_fp.to_string(),
            "trustMultiplierFp": p.trust_multiplier_fp.to_string(),
            "trustShareFp": p.trust_share_fp.to_string(),
            "trustDecayFp": p.trust_decay_fp.to_string(),
            "seedSetRoot": hx(seed_set_root.as_slice()),
            "sortedSeeds": sorted_seeds.iter().map(|a| hx(a.as_slice())).collect::<Vec<_>>(),
            "totalPool": p.total_pool.to_string(),
            "precisionScale": p.precision_scale.to_string(),
            "schemaUid": hx(p.schema_uid.as_slice()),
            "weightFieldIndex": p.weight_field_index,
            "envelope0DomainSeparators": p.envelope0_domain_separators.iter().map(|d| hx(d.as_slice())).collect::<Vec<_>>(),
            "lane2MaxHeadAge": p.lane2_max_head_age,
            "accumulator": hx(p.accumulator.as_slice()),
            "chainId": p.chain_id,
            "paramsHash": hx(params_hash.as_slice())
        },
        "accumulator": {
            "edge0": {
                "kind": e0.kind,
                "attester": hx(e0.attester.as_slice()),
                "recipient": hx(e0.recipient.as_slice()),
                "uid": hx(e0.uid.as_slice()),
                "blockTimestamp": e0.block_timestamp,
                "dataHash": hx(e0_datahash.as_slice()),
                "leaf": hx(e0_leaf.as_slice())
            },
            "acc": hx(acc.as_slice()),
            "leafCount": leaf_count
        },
        "paramsHash": hx(params_hash.as_slice()),
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
            "encoded": hx(&encode::journal_encoded(j)),
            "digest": hx(encode::journal_digest(j).as_slice())
        },
        "instanceDomain": {
            // The universal domain-separation preimage: keccak256(abi.encode(snapshot, chainId)),
            // rebuilt on-chain by submitProof from address(this) + block.chainid.
            "snapshot": hx(addr(0x5A).as_slice()),
            "chainId": 31337u64,
            "domain": hx(encode::instance_domain(addr(0x5A), 31337).as_slice())
        },
        "anchor": {
            // Anchor-log leaf (AnchorRegistry fold) + a nonempty skippedDigest vector,
            // locked four ways like every other encoding (OFFCHAIN doc §4.1/§4.3).
            "leaf": {
                "nodeId": hx(&[0x11u8; 32]),
                "envelopeKind": 0,
                "head": hx(&[0x22u8; 32]),
                // H-5: the head's signed count rides the leaf. Deliberately non-zero so the
                // vectors catch a port that drops or zero-defaults the word.
                "count": 5u64,
                "dataCommitment": hx(&[0x33u8; 32]),
                "blockTimestamp": 1234u64,
                "leaf": hx(zk_core::anchor::anchor_leaf(
                    alloy_primitives::B256::from([0x11u8; 32]),
                    0,
                    alloy_primitives::B256::from([0x22u8; 32]),
                    5,
                    alloy_primitives::B256::from([0x33u8; 32]),
                    1234,
                ).as_slice())
            },
            "skip": {
                "nodeId": hx(&[0x44u8; 32]),
                "reason": 1,
                "epochObserved": 7u64,
                "skipLeaf": hx(zk_core::anchor::skip_leaf(&zk_core::anchor::SkipEntry {
                    node_id: alloy_primitives::B256::from([0x44u8; 32]),
                    reason: 1,
                    epoch_observed: 7,
                }).as_slice()),
                "skippedDigest": hx(zk_core::anchor::skipped_digest(&[zk_core::anchor::SkipEntry {
                    node_id: alloy_primitives::B256::from([0x44u8; 32]),
                    reason: 1,
                    epoch_observed: 7,
                }]).as_slice())
            }
        },
        "output": {
            "root": hx(j.output_root.as_slice()),
            "sampleAccount": hx(sample_acct.as_slice()),
            "sampleValue": sample_val.to_string(),
            "sampleLeaf": hx(sample_leaf.as_slice()),
            "sampleProof": sample_proof
        },
        "cid": {
            "blob": String::from_utf8(result.blob.clone()).unwrap(),
            "blobHex": hx(&result.blob),
            "ipfsHash": hx(j.ipfs_hash.as_slice()),
            "cid": result.cid,
            "cidDigest": hx(j.cid_digest.as_slice())
        },
        "signer": {
            "selection": {
                "topN": selection.top_n,
                "minThreshold": selection.min_threshold,
                "targetThresholdBps": selection.target_threshold_bps
            },
            "selectionParamsHash": hx(selection_params_hash.as_slice()),
            "signers": signer_result.signers.iter().map(|a| hx(a.as_slice())).collect::<Vec<_>>(),
            "signerSetRoot": hx(sj.signer_set_root.as_slice()),
            "targetThreshold": sj.target_threshold.to_string(),
            "instanceDomain": {
                // The M-3 binding preimage: keccak256(abi.encode(module, chainId)), rebuilt
                // on-chain by submitSignerProof from address(this) + block.chainid.
                "module": hx(addr(0x5B).as_slice()),
                "chainId": 31337u64,
                "domain": hx(signer_domain.as_slice())
            },
            "journal": {
                "acc": hx(sj.acc.as_slice()),
                "leafCount": sj.leaf_count,
                "paramsHash": hx(sj.params_hash.as_slice()),
                "selectionParamsHash": hx(sj.selection_params_hash.as_slice()),
                "signerSetRoot": hx(sj.signer_set_root.as_slice()),
                "targetThreshold": sj.target_threshold.to_string(),
                "instanceDomain": hx(sj.instance_domain.as_slice()),
                "encoded": hx(&encode::signer_journal_encoded(sj)),
                "digest": hx(encode::signer_journal_digest(sj).as_slice())
            }
        }
    });

    let _ = Address::from_str("0x0000000000000000000000000000000000000000");
    print!("{}", serde_json::to_string_pretty(&out).unwrap());
}
