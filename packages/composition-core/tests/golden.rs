use alloy_primitives::{Address, B256, U256};
use composition_core::{
    codec,
    compute::compute,
    fixture::{post_trigger_input, remainder_tie_input, reproduction_input, sample_input},
};
use serde_json::Value;

fn production_golden() -> Value {
    serde_json::from_str(include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../test/golden/trust-compose.json"
    )))
    .unwrap()
}

fn research_golden() -> Value {
    serde_json::from_str(include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../research/composition/golden.json"
    )))
    .unwrap()
}

fn b256(value: &Value) -> B256 {
    value.as_str().unwrap().parse().unwrap()
}

fn address(value: &Value) -> Address {
    value.as_str().unwrap().parse().unwrap()
}

#[test]
fn rust_reproduces_every_research_quota_attribution_output_and_update() {
    let golden = research_golden();
    let result = compute(&sample_input()).unwrap();
    assert_eq!(result.journal.acc, b256(&golden["manifestSha256"]));
    for source in &result.source_allocations {
        let source_id = format!("{:#x}", source.source_id);
        assert_eq!(source.quota.to_string(), golden["sourceQuotas"][&source_id].as_str().unwrap());
        for entry in &source.allocations {
            let account = format!("{:#x}", entry.account);
            assert_eq!(
                entry.value.to_string(),
                golden["sourceAllocations"][&source_id][&account].as_str().unwrap()
            );
        }
    }
    assert_eq!(result.scores.len(), golden["output"].as_object().unwrap().len());
    for (account, value) in &result.scores {
        assert_eq!(value.to_string(), golden["output"][format!("{account:#x}")].as_str().unwrap());
    }
    assert_eq!(result.journal.ipfs_hash, b256(&golden["outputBlobSha256"]));
    assert_eq!(result.cid, golden["outputCid"]);
    assert_eq!(result.journal.output_root, b256(&golden["outputRoot"]));
    assert_eq!(result.journal.total_value, U256::from(1_000_000));

    let next = compute(&post_trigger_input()).unwrap();
    assert_eq!(next.journal.output_root, b256(&golden["postTriggerUpdate"]["outputRoot"]));
    assert_eq!(next.journal.acc, b256(&golden["postTriggerUpdate"]["manifestSha256"]));
}

#[test]
fn rust_reproduces_type_script_policy_params_capture_journal_and_proof_vector() {
    let golden = production_golden();
    let input = sample_input();
    let result = compute(&input).unwrap();

    assert_eq!(
        alloy_primitives::hex::encode(&input.manifest),
        golden["capture"]["manifest"].as_str().unwrap().trim_start_matches("0x")
    );
    assert_eq!(input.capture_commitment, b256(&golden["capture"]["manifestSha256"]));
    assert_eq!(
        codec::source_policy_root(&result.manifest.sources),
        b256(&golden["policyManifest"]["root"])
    );
    let policy = codec::policy_manifest_encoded(input.params.chain_id, &result.manifest.sources);
    assert_eq!(
        alloy_primitives::hex::encode(&policy),
        golden["policyManifest"]["encoded"].as_str().unwrap().trim_start_matches("0x")
    );
    for (index, source) in result.manifest.sources.iter().enumerate() {
        assert_eq!(
            codec::source_policy_leaf(source),
            b256(&golden["policyManifest"]["leaves"][index])
        );
    }
    assert_eq!(
        alloy_primitives::hex::encode(codec::params_encoded(&input.params)),
        golden["params"]["encoded"].as_str().unwrap().trim_start_matches("0x")
    );
    assert_eq!(codec::params_hash(&input.params), b256(&golden["params"]["paramsHash"]));
    assert_eq!(
        alloy_primitives::hex::encode(codec::journal_encoded(&result.journal)),
        golden["journal"]["encoded"].as_str().unwrap().trim_start_matches("0x")
    );
    assert_eq!(codec::journal_digest(&result.journal), b256(&golden["journal"]["digest"]));
    assert_eq!(
        result.blob,
        alloy_primitives::hex::decode(
            golden["output"]["blob"].as_str().unwrap().trim_start_matches("0x")
        )
        .unwrap()
    );

    let sample_account = address(&golden["output"]["sampleAccount"]);
    let sample_value =
        U256::from_str_radix(golden["output"]["sampleValue"].as_str().unwrap(), 10).unwrap();
    let leaf = zk_core::merkle::output_leaf(sample_account, sample_value);
    assert_eq!(leaf, b256(&golden["output"]["sampleLeaf"]));
    let leaves = result
        .scores
        .iter()
        .map(|(account, value)| zk_core::merkle::output_leaf(*account, *value))
        .collect::<Vec<_>>();
    let tree = zk_core::merkle::build_tree(leaves);
    assert_eq!(
        zk_core::merkle::proof_for(&tree, leaf).unwrap(),
        golden["output"]["sampleProof"].as_array().unwrap().iter().map(b256).collect::<Vec<_>>()
    );
}

#[test]
fn source_builder_enumeration_order_is_canonical() {
    let forward = sample_input();
    let reversed = composition_core::fixture::reversed_sample_input();
    assert_eq!(forward.manifest, reversed.manifest);
    assert_eq!(forward.capture_commitment, reversed.capture_commitment);
    assert_eq!(compute(&forward).unwrap().journal, compute(&reversed).unwrap().journal);
}

#[test]
fn exact_source_reproduction_and_address_remainder_ties_are_pinned() {
    let reproduced = compute(&reproduction_input()).unwrap();
    assert_eq!(reproduced.source_allocations[0].quota, 3);
    assert_eq!(reproduced.source_allocations[1].quota, 2);
    assert_eq!(
        reproduced
            .scores
            .iter()
            .map(|(account, value)| (*account, value.to::<u128>()))
            .collect::<Vec<_>>(),
        vec![
            (Address::from([0x01; 20]), 1),
            (Address::from([0x02; 20]), 2),
            (Address::from([0x03; 20]), 1),
            (Address::from([0x04; 20]), 1),
        ]
    );

    let tie = compute(&remainder_tie_input()).unwrap();
    assert_eq!(tie.source_allocations[0].quota, 2);
    assert_eq!(tie.source_allocations[1].quota, 2);
    assert_eq!(
        tie.scores
            .iter()
            .map(|(account, value)| (*account, value.to::<u128>()))
            .collect::<Vec<_>>(),
        vec![
            (Address::from([0x01; 20]), 1),
            (Address::from([0x02; 20]), 1),
            (Address::from([0x04; 20]), 1),
            (Address::from([0x05; 20]), 1),
        ]
    );
}
