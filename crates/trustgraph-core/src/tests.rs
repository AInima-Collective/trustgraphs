use crate::compute::compute;
use crate::{GuestInput, Params, RawEdge};
use alloy_primitives::{Address, B256, U256};

fn scale() -> U256 {
    U256::from(10u64).pow(U256::from(18u64))
}

pub(crate) fn default_params() -> Params {
    let scale = scale();
    Params {
        damping_fp: scale * U256::from(85) / U256::from(100),
        tolerance_fp: scale / U256::from(1_000_000u64),
        max_iterations: 100,
        min_weight_fp: U256::ZERO,
        max_weight_fp: U256::from(100) * scale,
        trust_share_fp: U256::ZERO,
        trust_decay_fp: U256::ZERO,
        trusted_seeds: Vec::new(),
        total_pool: U256::from(1_000_000_000_000_000_000_000_000u128),
        precision_scale: scale,
        schema_uid: B256::ZERO,
        weight_field_index: 1,
        envelope0_domain_separators: Vec::new(),
        lane2_max_head_age: 0,
        accumulator: Address::ZERO,
        chain_id: 0,
    }
}
use crate::lane2::{self, Lane2Error};
use crate::{AnchorRecord, Envelope0AnchorAuthorization, Envelope0PayloadWitness, Lane2Witness};
use eas_offchain::{eip712_digest, payload};
use k256::ecdsa::SigningKey;
use serde_json::Value;
use std::path::PathBuf;

struct Fixture {
    params: Params,
    witness: Lane2Witness,
    owner: Address,
}

fn fixture_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../tests/fixtures/eas-offchain/v1")
}

fn manifest() -> Value {
    serde_json::from_slice(&std::fs::read(fixture_dir().join("manifest.json")).unwrap()).unwrap()
}

fn b256(value: &Value) -> B256 {
    value.as_str().unwrap().parse().unwrap()
}

fn address(value: &Value) -> Address {
    value.as_str().unwrap().parse().unwrap()
}

fn u64_string(value: &Value) -> u64 {
    value.as_str().unwrap().parse().unwrap()
}

fn signature(value: &Value) -> Vec<u8> {
    alloy_primitives::hex::decode(value.as_str().unwrap().trim_start_matches("0x")).unwrap()
}

fn official_fixture(full_history: bool) -> Fixture {
    let manifest = manifest();
    let history = manifest["positive"]["anchorHistory"].as_array().unwrap();
    let history_len = if full_history { history.len() } else { 1 };
    let mut anchors = Vec::with_capacity(history_len);
    let mut authorizations = Vec::with_capacity(history_len);
    for (fold_index, record) in history[..history_len].iter().enumerate() {
        let authorization = &record["authorization"];
        let message = &authorization["message"];
        anchors.push(AnchorRecord {
            node_id: b256(&message["nodeId"]),
            envelope_kind: message["envelopeKind"].as_u64().unwrap() as u8,
            head: b256(&message["head"]),
            count: u64_string(&message["count"]),
            data_commitment: b256(&message["dataCommitment"]),
            block_timestamp: u64_string(&record["blockTimestamp"]),
        });
        authorizations.push(Envelope0AnchorAuthorization {
            fold_index: fold_index as u64,
            head_signature: signature(&authorization["signature"]),
        });
    }
    let latest = &history[history_len - 1];
    let node_id = anchors.last().unwrap().node_id;
    let payload =
        std::fs::read(fixture_dir().join(latest["payloadFile"].as_str().unwrap())).unwrap();
    let mut params = default_params();
    params.schema_uid = b256(&manifest["schemaUid"]);
    params.envelope0_domain_separators =
        vec![b256(&manifest["easDomain"]["separator"]), b256(&manifest["headDomain"]["separator"])];
    params.lane2_max_head_age = 0;
    params.chain_id = u64_string(&manifest["headDomain"]["chainId"]);
    Fixture {
        params,
        witness: Lane2Witness {
            anchors,
            authorizations,
            payloads: vec![Envelope0PayloadWitness { node_id, payload }],
        },
        owner: address(&manifest["owner"]),
    }
}

fn sign_prehash(sk: &SigningKey, prehash: &B256) -> Vec<u8> {
    let (signature, _) = sk.sign_prehash_recoverable(prehash.as_slice()).unwrap();
    let signature = signature.normalize_s().unwrap_or(signature);
    for parity in 0u8..=1 {
        let recovery_id = k256::ecdsa::RecoveryId::from_byte(parity).unwrap();
        if let Ok(verifying_key) = k256::ecdsa::VerifyingKey::recover_from_prehash(
            prehash.as_slice(),
            &signature,
            recovery_id,
        ) {
            if verifying_key == *sk.verifying_key() {
                let mut bytes = signature.to_bytes().to_vec();
                bytes.push(parity + 27);
                return bytes;
            }
        }
    }
    unreachable!("one recovery id must match")
}

fn resign_history(fixture: &mut Fixture) {
    let key = SigningKey::from_slice(&[0x42; 32]).unwrap();
    let head_domain = fixture.params.envelope0_domain_separators[lane2::HEAD_DOMAIN_INDEX];
    let mut previous_head = B256::ZERO;
    for (fold_index, anchor) in fixture.witness.anchors.iter().enumerate() {
        let message = payload::AnchorMessage {
            node_id: anchor.node_id,
            envelope_kind: anchor.envelope_kind,
            schema_uid: fixture.params.schema_uid,
            previous_head,
            head: anchor.head,
            count: anchor.count,
            data_commitment: anchor.data_commitment,
        };
        let digest = eip712_digest(head_domain, payload::anchor_struct_hash(&message));
        fixture.witness.authorizations[fold_index].head_signature = sign_prehash(&key, &digest);
        previous_head = anchor.head;
    }
}

fn lane1_edge(
    attester: Address,
    recipient: Address,
    uid: B256,
    timestamp: u64,
    confidence: u64,
) -> RawEdge {
    let mut data = vec![0u8; 64];
    data[32..].copy_from_slice(&U256::from(confidence).to_be_bytes::<32>());
    RawEdge {
        kind: eas_offchain::ENTRY_ATTEST,
        attester,
        recipient,
        uid,
        block_timestamp: timestamp,
        data,
    }
}

#[test]
fn official_sdk_payload_emits_the_complete_ordered_mutation_stream() {
    let fixture = official_fixture(true);
    let result = lane2::process(&fixture.params, &fixture.witness).unwrap();
    assert_eq!(result.anchor_count, 2);
    assert_ne!(result.anchor_acc, B256::ZERO);
    assert!(result.skips.is_empty());
    assert_eq!(result.edges.len(), 3, "attest, attest, revoke must all survive decoding");
    assert_eq!(result.edges[0].kind, eas_offchain::ENTRY_ATTEST);
    assert_eq!(result.edges[1].kind, eas_offchain::ENTRY_ATTEST);
    assert_eq!(result.edges[2].kind, eas_offchain::ENTRY_REVOKE);
    assert_eq!(result.edges[2].uid, result.edges[0].uid);
    assert_eq!(result.edges[2].recipient, result.edges[0].recipient);
    assert_eq!(
        result.edges[2].block_timestamp, fixture.witness.anchors[1].block_timestamp,
        "revoke time is its earliest covering anchor"
    );
}

#[test]
fn missing_latest_payload_aborts_instead_of_degrading() {
    let mut fixture = official_fixture(true);
    fixture.witness.payloads.clear();
    assert_eq!(
        lane2::process(&fixture.params, &fixture.witness).unwrap_err(),
        Lane2Error::MissingPayload
    );
}

#[test]
fn same_count_anchor_is_a_conflict() {
    let mut fixture = official_fixture(true);
    fixture.witness.anchors[1].count = fixture.witness.anchors[0].count;
    assert_eq!(
        lane2::process(&fixture.params, &fixture.witness).unwrap_err(),
        Lane2Error::SameCountConflict
    );
}

#[test]
fn future_time_is_checked_against_the_first_committing_anchor() {
    let mut fixture = official_fixture(true);
    fixture.witness.anchors[0].block_timestamp = 1;
    assert_eq!(
        lane2::process(&fixture.params, &fixture.witness).unwrap_err(),
        Lane2Error::Payload(payload::PayloadError::FutureTime)
    );
}

#[test]
fn validly_signed_higher_count_fork_fails_the_prefix_rule() {
    let mut fixture = official_fixture(true);
    fixture.witness.anchors[0].head = B256::from([0x55; 32]);
    resign_history(&mut fixture);
    assert_eq!(
        lane2::process(&fixture.params, &fixture.witness).unwrap_err(),
        Lane2Error::PrefixFork
    );
}

#[test]
fn full_compute_commits_zero_skips_for_a_valid_hybrid_checkpoint() {
    let fixture = official_fixture(true);
    let result = compute(&GuestInput {
        edges: vec![],
        params: fixture.params,
        lane2: Some(fixture.witness),
        binding: Default::default(),
    });
    assert_eq!(result.journal.anchor_count, 2);
    assert_eq!(result.journal.skipped_digest, B256::ZERO);
    assert_ne!(result.journal.output_root, B256::ZERO);
}

#[test]
fn mixed_lane_replacement_and_revoke_never_resurrect_an_older_pair() {
    let fixture = official_fixture(true);
    let lane2 = lane2::process(&fixture.params, &fixture.witness).unwrap();
    let first = lane2.edges[0].clone();
    let second = lane2.edges[1].clone();

    // on-chain old -> off-chain replacement -> off-chain revoke: the pair is absent, while
    // the independent second off-chain recipient remains.
    let mut events = vec![lane1_edge(
        fixture.owner,
        first.recipient,
        B256::from([0x90; 32]),
        first.block_timestamp - 1,
        99,
    )];
    events.extend(lane2.edges.clone());
    let graph = pagerank_core::reconcile::build_graph(&events, &fixture.params);
    assert!(graph
        .outgoing
        .get(&fixture.owner)
        .is_none_or(|recipients| !recipients.contains_key(&first.recipient)));
    assert!(graph.outgoing[&fixture.owner].contains_key(&second.recipient));

    // off-chain old -> later on-chain replacement -> old off-chain revoke: the revoke names
    // the superseded UID and must not clear the current on-chain edge.
    let replacement = lane1_edge(
        fixture.owner,
        first.recipient,
        B256::from([0x91; 32]),
        first.block_timestamp + 60,
        88,
    );
    let mut events = vec![replacement];
    events.extend(lane2.edges);
    let graph = pagerank_core::reconcile::build_graph(&events, &fixture.params);
    assert_eq!(
        graph.outgoing[&fixture.owner][&first.recipient],
        U256::from(88) * fixture.params.precision_scale
    );
}

#[test]
fn lane2_wins_an_exact_timestamp_tie_after_lane1() {
    let fixture = official_fixture(false);
    let lane2 = lane2::process(&fixture.params, &fixture.witness).unwrap();
    let offchain = lane2.edges[0].clone();
    let lane1 = lane1_edge(
        fixture.owner,
        offchain.recipient,
        B256::from([0x92; 32]),
        offchain.block_timestamp,
        1,
    );
    let mut events = vec![lane1];
    events.extend(lane2.edges);
    let graph = pagerank_core::reconcile::build_graph(&events, &fixture.params);
    let expected = pagerank_core::encode::decode_weight(&offchain.data, 1).unwrap()
        * fixture.params.precision_scale;
    assert_eq!(graph.outgoing[&fixture.owner][&offchain.recipient], expected);
}

#[test]
fn disabled_lane_is_byte_identical_to_the_frozen_lane1_core() {
    let mut params = default_params();
    params.accumulator = Address::from([0xAC; 20]);
    params.chain_id = 31_337;
    let edges = vec![
        lane1_edge(Address::from([1; 20]), Address::from([2; 20]), B256::from([1; 32]), 100, 50),
        lane1_edge(Address::from([2; 20]), Address::from([3; 20]), B256::from([2; 32]), 101, 75),
    ];
    let binding = pagerank_core::Binding {
        recipient: Address::from([0xBE; 20]),
        instance_domain: pagerank_core::encode::instance_domain(Address::from([0x5A; 20]), 31_337),
    };
    let frozen_input =
        pagerank_core::GuestInput { edges: edges.clone(), params: params.clone(), binding };
    let hybrid_capable_input = GuestInput { edges, params, lane2: None, binding };
    let expected = pagerank_core::compute::compute(&frozen_input);
    let actual = compute(&hybrid_capable_input);
    assert_eq!(actual.journal, expected.journal);
    assert_eq!(actual.scores, expected.scores);
    assert_eq!(actual.blob, expected.blob);
    assert_eq!(actual.cid, expected.cid);
}
