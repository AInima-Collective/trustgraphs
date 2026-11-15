use alloy_primitives::{Address, B256, U256};
use mutual_recognition_core::{
    compute::compute,
    encode,
    manifest::{canonical_manifest, manifest_digest, normalize, prior_root},
    rank::apportion,
    Binding, GuestInput, Params, RawEdge, RawPriorEntry, PARAMS_VERSION,
};
use serde_json::Value;

fn address(byte: u8) -> Address {
    Address::from([byte; 20])
}

fn edge(from: u8, to: u8, uid: u8, timestamp: u64, weight: u64) -> RawEdge {
    let mut data = vec![0u8; 64];
    data[56..].copy_from_slice(&weight.to_be_bytes());
    RawEdge {
        kind: 0,
        attester: address(from),
        recipient: address(to),
        uid: B256::from([uid; 32]),
        block_timestamp: timestamp,
        data,
    }
}

fn hex(value: B256) -> String {
    format!("{value:#x}")
}

#[test]
fn rust_pipeline_consumes_the_production_golden() {
    let golden: Value = serde_json::from_str(include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../tests/golden/mutual-recognition.json"
    )))
    .unwrap();
    let prior = normalize(&[
        RawPriorEntry { account: address(0x11), weight: "10".into() },
        RawPriorEntry { account: address(0x22), weight: "2.5".into() },
        RawPriorEntry { account: address(0x33), weight: "1".into() },
    ])
    .unwrap();
    let manifest = canonical_manifest(10, &prior).unwrap();
    let params = Params {
        version: PARAMS_VERSION,
        damping_fp: 850_000_000_000_000_000,
        tolerance_fp: 0,
        max_iterations: 40,
        min_weight: 0,
        max_weight: 100,
        prior_root: prior_root(&prior).unwrap(),
        prior_count: 3,
        manifest_sha256: manifest_digest(&manifest),
        schema_uid: B256::from([0xAB; 32]),
        weight_field_index: 1,
        accumulator: address(0xAC),
        chain_id: 10,
    };
    let input = GuestInput {
        edges: vec![
            edge(0x11, 0x22, 1, 100, 3),
            edge(0x11, 0x33, 3, 102, 4),
            edge(0x22, 0x11, 2, 101, 1),
            edge(0x22, 0x33, 4, 103, 5),
            edge(0x33, 0x22, 5, 104, 2),
            edge(0x33, 0x33, 6, 105, 99),
            edge(0x44, 0x55, 7, 106, 1),
            edge(0x55, 0x44, 8, 107, 1),
        ],
        params,
        manifest,
        binding: Binding {
            recipient: address(0xBE),
            instance_domain: zk_core::journal::instance_domain(address(0x5A), 10),
        },
    };
    let result = compute(&input).unwrap();

    let tie_prior = normalize(&[
        RawPriorEntry { account: address(1), weight: "1".into() },
        RawPriorEntry { account: address(2), weight: "1".into() },
        RawPriorEntry { account: address(3), weight: "1".into() },
    ])
    .unwrap();
    let tie_allocation =
        apportion(&[(address(1), 1), (address(2), 1), (address(3), 1)], 2, 3).unwrap();
    assert_eq!(
        tie_prior.iter().map(|entry| entry.weight.to_string()).collect::<Vec<_>>(),
        golden["ties"]["normalizedWeights"]
            .as_array()
            .unwrap()
            .iter()
            .map(|value| value.as_str().unwrap().to_owned())
            .collect::<Vec<_>>()
    );
    assert_eq!(
        tie_prior
            .iter()
            .map(|entry| tie_allocation[&entry.account].to_string())
            .collect::<Vec<_>>(),
        golden["ties"]["apportionValues"]
            .as_array()
            .unwrap()
            .iter()
            .map(|value| value.as_str().unwrap().to_owned())
            .collect::<Vec<_>>()
    );

    assert_eq!(hex(input.params.prior_root), golden["prior"]["root"]);
    assert_eq!(hex(input.params.manifest_sha256), golden["prior"]["manifestSha256"]);
    assert_eq!(hex(encode::params_hash(&input.params)), golden["params"]["paramsHash"]);
    assert_eq!(hex(result.journal.output_root), golden["output"]["root"]);
    assert_eq!(hex(result.journal.ipfs_hash), golden["cid"]["ipfsHash"]);
    assert_eq!(result.cid, golden["cid"]["cid"]);
    assert_eq!(hex(encode::journal_digest(&result.journal)), golden["journal"]["digest"]);
    assert_eq!(result.iterations, golden["compute"]["iterations"].as_u64().unwrap() as u32);
    let values = result.scores.iter().map(|(_, value)| *value).collect::<Vec<U256>>();
    let expected = golden["compute"]["scores"]
        .as_array()
        .unwrap()
        .iter()
        .map(|score| U256::from(score["value"].as_str().unwrap().parse::<u64>().unwrap()))
        .collect::<Vec<U256>>();
    assert_eq!(values, expected);
}
