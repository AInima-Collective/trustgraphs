use alloy_primitives::{Address, B256, U256};
use composition_core::{
    codec,
    compute::compute,
    fixture::{mixed_input, reversed_mixed_input, rotated_mixed_input},
    source_compatibility_class_v1, trust_graph_output_domain, trust_graph_program_id,
    weighted_trust_graph_output_domain, weighted_trust_graph_program_id,
};
use serde_json::Value;

fn production_golden() -> Value {
    serde_json::from_str(include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../tests/golden/trust-compose.json"
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
fn class_constant_and_admitted_pairs_match_the_decision_record() {
    assert_eq!(
        source_compatibility_class_v1(),
        "0x5426d501d31705b306bf65d6260a564441ff6b3b98a4375766c76348b7cca9e2"
            .parse::<B256>()
            .unwrap()
    );
    assert_eq!(
        trust_graph_program_id(),
        "0xdb036dae12e8641d1e58d416eec22090955469d8da1c292e2b6b02ecb9e8d380"
            .parse::<B256>()
            .unwrap()
    );
    assert_eq!(
        weighted_trust_graph_program_id(),
        "0xbab333b5932d7fa8073fe8ed541c0d2aef9667198b0417f43ee5c920071af2b2"
            .parse::<B256>()
            .unwrap()
    );
    assert_eq!(
        trust_graph_output_domain(),
        "0xa8ba97693d080750d9a6972406e8f5488842c338c94b402e5f02dad3d9e9eea5"
            .parse::<B256>()
            .unwrap()
    );
    assert_eq!(
        weighted_trust_graph_output_domain(),
        "0x0509c32608494c9065912b6e03f10cfe54d31c433ffe3547fc729474342c293f"
            .parse::<B256>()
            .unwrap()
    );
    let golden = production_golden();
    assert_eq!(
        source_compatibility_class_v1(),
        b256(&golden["constants"]["sourceCompatibilityClass"])
    );
}

#[test]
fn rust_reproduces_type_script_policy_params_capture_journal_and_proof_vector() {
    let golden = production_golden();
    let input = mixed_input();
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
    assert_eq!(result.blob, golden["output"]["blob"].as_str().unwrap().as_bytes());
    assert_eq!(result.cid, golden["output"]["cid"]);

    for (index, expected) in golden["sourceQuotas"].as_array().unwrap().iter().enumerate() {
        let actual = &result.source_allocations[index];
        assert_eq!(actual.source_id, b256(&expected["sourceId"]));
        assert_eq!(actual.quota.to_string(), expected["quota"].as_str().unwrap());
    }
    for (index, expected) in golden["sourceAllocations"].as_array().unwrap().iter().enumerate() {
        let actual = &result.source_allocations[index];
        let entries = expected["allocations"].as_array().unwrap();
        assert_eq!(actual.allocations.len(), entries.len());
        for (entry, expected_entry) in actual.allocations.iter().zip(entries) {
            assert_eq!(entry.account, address(&expected_entry["account"]));
            assert_eq!(entry.value.to_string(), expected_entry["value"].as_str().unwrap());
        }
    }
    let expected_output = golden["output"]["entries"].as_array().unwrap();
    assert_eq!(result.scores.len(), expected_output.len());
    for ((account, value), expected_entry) in result.scores.iter().zip(expected_output) {
        assert_eq!(*account, address(&expected_entry["account"]));
        assert_eq!(value.to_string(), expected_entry["value"].as_str().unwrap());
    }
    assert_eq!(result.journal.total_value, U256::from(1_000));

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
    let forward = mixed_input();
    let reversed = reversed_mixed_input();
    assert_eq!(forward.manifest, reversed.manifest);
    assert_eq!(forward.capture_commitment, reversed.capture_commitment);
    assert_eq!(compute(&forward).unwrap().journal, compute(&reversed).unwrap().journal);
}

#[test]
fn rotated_policy_reproduces_the_frozen_rotation_vector() {
    let golden = production_golden();
    let rotated = rotated_mixed_input();
    let result = compute(&rotated).unwrap();
    assert_eq!(
        rotated.params.policy_manifest_sha256,
        b256(&golden["rotation"]["policyManifestSha256"])
    );
    assert_eq!(rotated.params.source_policy_root, b256(&golden["rotation"]["sourcePolicyRoot"]));
    assert_eq!(codec::params_hash(&rotated.params), b256(&golden["rotation"]["paramsHash"]));
    assert_eq!(result.journal.output_root, b256(&golden["rotation"]["outputRoot"]));
    for (index, expected) in
        golden["rotation"]["sourceQuotas"].as_array().unwrap().iter().enumerate()
    {
        let actual = &result.source_allocations[index];
        assert_eq!(actual.source_id, b256(&expected["sourceId"]));
        assert_eq!(actual.quota.to_string(), expected["quota"].as_str().unwrap());
    }
}
