use alloy_primitives::{hex, keccak256, Address, B256};
use serde_json::json;
use weighted_prior_core::{
    compute::compute,
    encode,
    manifest::{canonical_manifest, manifest_digest, normalize, prior_leaf, prior_root},
    rank::apportion,
    Binding, GuestInput, Params, RawEdge, RawPriorEntry, PARAMS_VERSION,
};

fn hx(bytes: &[u8]) -> String {
    format!("0x{}", hex::encode(bytes))
}

fn address(byte: u8) -> Address {
    Address::from([byte; 20])
}

fn edge(from: u8, to: u8, uid: u8, timestamp: u64, weight: u64) -> RawEdge {
    let mut data = vec![0u8; 64];
    data[56..64].copy_from_slice(&weight.to_be_bytes());
    RawEdge {
        kind: 0,
        attester: address(from),
        recipient: address(to),
        uid: B256::from([uid; 32]),
        block_timestamp: timestamp,
        data,
    }
}

fn main() {
    let raw = vec![
        RawPriorEntry { account: address(0x11), weight: "10".into() },
        RawPriorEntry { account: address(0x22), weight: "2.5".into() },
        RawPriorEntry { account: address(0x33), weight: "1".into() },
    ];
    let prior = normalize(&raw).unwrap();
    let manifest = canonical_manifest(10, &prior).unwrap();
    let params = Params {
        version: PARAMS_VERSION,
        damping_fp: 850_000_000_000_000_000,
        tolerance_fp: 0,
        max_iterations: 40,
        min_weight: 0,
        max_weight: 100,
        prior_root: prior_root(&prior).unwrap(),
        prior_count: prior.len() as u32,
        manifest_sha256: manifest_digest(&manifest),
        schema_uid: B256::from([0xAB; 32]),
        weight_field_index: 1,
        accumulator: address(0xAC),
        chain_id: 10,
    };
    let edges = vec![
        edge(0x11, 0x22, 1, 100, 3),
        edge(0x11, 0x33, 2, 101, 1),
        edge(0x22, 0x33, 3, 102, 5),
        edge(0x33, 0x33, 4, 103, 99),
        edge(0x44, 0x55, 5, 104, 1),
        edge(0x55, 0x44, 6, 105, 1),
    ];
    let binding = Binding {
        recipient: address(0xBE),
        instance_domain: zk_core::journal::instance_domain(address(0x5A), 10),
    };
    let input = GuestInput { edges, params, manifest, binding };
    let result = compute(&input).unwrap();
    let journal = &result.journal;
    let (acc, leaf_count) = encode::accumulate(&input.edges);
    let first_edge = &input.edges[0];
    let output_leaves = result
        .scores
        .iter()
        .map(|(account, value)| zk_core::merkle::output_leaf(*account, *value))
        .collect::<Vec<_>>();
    let tree = zk_core::merkle::build_tree(output_leaves);
    let (sample_account, sample_value) = result.scores[0];
    let sample_leaf = zk_core::merkle::output_leaf(sample_account, sample_value);
    let sample_proof = zk_core::merkle::proof_for(&tree, sample_leaf).unwrap();
    let tie_raw = vec![
        RawPriorEntry { account: address(0x01), weight: "1".into() },
        RawPriorEntry { account: address(0x02), weight: "1".into() },
        RawPriorEntry { account: address(0x03), weight: "1".into() },
    ];
    let tie_prior = normalize(&tie_raw).unwrap();
    let tie_allocation =
        apportion(&[(address(0x01), 1), (address(0x02), 1), (address(0x03), 1)], 2, 3).unwrap();

    let output = json!({
        "schema": "trustgraph-weighted-golden-v1",
        "prior": {
            "rawEntries": raw.iter().map(|entry| json!({
                "account": hx(entry.account.as_slice()),
                "weight": entry.weight,
            })).collect::<Vec<_>>(),
            "entries": prior.iter().map(|entry| json!({
                "account": hx(entry.account.as_slice()),
                "weight": entry.weight.to_string(),
                "leaf": hx(prior_leaf(entry).as_slice()),
            })).collect::<Vec<_>>(),
            "root": hx(input.params.prior_root.as_slice()),
            "manifest": hx(&input.manifest),
            "manifestSha256": hx(input.params.manifest_sha256.as_slice()),
        },
        "ties": {
            "accounts": tie_prior.iter().map(|entry| hx(entry.account.as_slice())).collect::<Vec<_>>(),
            "normalizedWeights": tie_prior.iter().map(|entry| entry.weight.to_string()).collect::<Vec<_>>(),
            "apportionBudget": "2",
            "apportionDenominator": "3",
            "apportionValues": tie_prior.iter().map(|entry| tie_allocation[&entry.account].to_string()).collect::<Vec<_>>(),
        },
        "params": {
            "version": input.params.version,
            "dampingFp": input.params.damping_fp.to_string(),
            "toleranceFp": input.params.tolerance_fp.to_string(),
            "maxIterations": input.params.max_iterations,
            "minWeight": input.params.min_weight.to_string(),
            "maxWeight": input.params.max_weight.to_string(),
            "priorRoot": hx(input.params.prior_root.as_slice()),
            "priorCount": input.params.prior_count,
            "manifestSha256": hx(input.params.manifest_sha256.as_slice()),
            "schemaUid": hx(input.params.schema_uid.as_slice()),
            "weightFieldIndex": input.params.weight_field_index,
            "accumulator": hx(input.params.accumulator.as_slice()),
            "chainId": input.params.chain_id,
            "encoded": hx(&encode::params_encoded(&input.params)),
            "paramsHash": hx(encode::params_hash(&input.params).as_slice()),
        },
        "accumulator": {
            "edge0": {
                "kind": first_edge.kind,
                "attester": hx(first_edge.attester.as_slice()),
                "recipient": hx(first_edge.recipient.as_slice()),
                "uid": hx(first_edge.uid.as_slice()),
                "blockTimestamp": first_edge.block_timestamp,
                "dataHash": hx(keccak256(&first_edge.data).as_slice()),
                "leaf": hx(first_edge.leaf().as_slice()),
            },
            "acc": hx(acc.as_slice()),
            "leafCount": leaf_count,
        },
        "compute": {
            "iterations": result.iterations,
            "scores": result.scores.iter().map(|(account, value)| json!({
                "account": hx(account.as_slice()),
                "value": value.to_string(),
            })).collect::<Vec<_>>(),
            "disconnectedAccounts": [hx(address(0x44).as_slice()), hx(address(0x55).as_slice())],
        },
        "output": {
            "root": hx(journal.output_root.as_slice()),
            "sampleAccount": hx(sample_account.as_slice()),
            "sampleValue": sample_value.to_string(),
            "sampleLeaf": hx(sample_leaf.as_slice()),
            "sampleProof": sample_proof.iter().map(|item| hx(item.as_slice())).collect::<Vec<_>>(),
        },
        "cid": {
            "blob": String::from_utf8(result.blob.clone()).unwrap(),
            "blobHex": hx(&result.blob),
            "ipfsHash": hx(journal.ipfs_hash.as_slice()),
            "cid": result.cid,
            "cidDigest": hx(journal.cid_digest.as_slice()),
        },
        "journal": {
            "acc": hx(journal.acc.as_slice()),
            "leafCount": journal.leaf_count,
            "anchorAcc": hx(journal.anchor_acc.as_slice()),
            "anchorCount": journal.anchor_count,
            "paramsHash": hx(journal.params_hash.as_slice()),
            "outputRoot": hx(journal.output_root.as_slice()),
            "ipfsHash": hx(journal.ipfs_hash.as_slice()),
            "cidDigest": hx(journal.cid_digest.as_slice()),
            "totalValue": journal.total_value.to_string(),
            "skippedDigest": hx(journal.skipped_digest.as_slice()),
            "recipient": hx(journal.recipient.as_slice()),
            "instanceDomain": hx(journal.instance_domain.as_slice()),
            "encoded": hx(&encode::journal_encoded(journal)),
            "digest": hx(encode::journal_digest(journal).as_slice()),
        },
    });
    println!("{}", serde_json::to_string_pretty(&output).unwrap());
}
