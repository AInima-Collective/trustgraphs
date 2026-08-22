use std::path::{Path, PathBuf};

use alloy_primitives::{Address, B256, U256};
use nostr_envelope::nostr::event::decode_hex;
use nostr_envelope::nostr::tgnw;
use nostr_envelope::nostr::{community_node_id, nostr_node_id, CommitmentVariant, NostrLimits};
use nostr_workspace_core::compute::{compute, GuestInput, HeadWitness, ENVELOPE_NOSTR};
use nostr_workspace_core::params::{output_domain, Params, PARAMS_VERSION};
use pagerank_core::{AnchorRecord, Binding};
use sha2::{Digest, Sha256};

fn fixture() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../tests/fixtures/nostr/buzz/a362fecc2389955f942c9581bdfeba379ab115b3")
}

fn scale() -> U256 {
    U256::from(1_000_000_000_000_000_000u64)
}

fn fp(numerator: u64, denominator: u64) -> U256 {
    scale() * U256::from(numerator) / U256::from(denominator)
}

fn anchor(bytes: &[u8], timestamp: u64) -> AnchorRecord {
    let bundle = tgnw::decode(bytes, &NostrLimits::HARD).unwrap();
    let (node_id, head, count) = match bundle.variant {
        CommitmentVariant::BuzzAuditV1 => (
            community_node_id(&bundle.community_id),
            B256::from(bundle.audit.last().unwrap().hash),
            bundle.audit.len() as u64,
        ),
        CommitmentVariant::SelfLogV1 => {
            let head = bundle
                .head_event
                .as_ref()
                .unwrap()
                .tags
                .iter()
                .find(|tag| tag.first().map(String::as_str) == Some("head"))
                .unwrap();
            (
                nostr_node_id(&bundle.authority),
                B256::from(decode_hex::<32>(&head[1]).unwrap()),
                bundle.events.len() as u64,
            )
        }
    };
    AnchorRecord {
        node_id,
        envelope_kind: ENVELOPE_NOSTR,
        head,
        count,
        data_commitment: B256::from(<[u8; 32]>::from(Sha256::digest(bytes))),
        block_timestamp: timestamp,
    }
}

fn params() -> Params {
    Params {
        version: PARAMS_VERSION,
        output_domain: output_domain(),
        damping_fp: fp(85, 100),
        tolerance_fp: scale() / U256::from(1_000_000u64),
        max_iterations: 100,
        trust_multiplier_fp: scale() * U256::from(2),
        trust_share_fp: fp(15, 100),
        trust_decay_fp: fp(80, 100),
        precision_scale: scale(),
        total_pool: U256::from(1_000_000_000_000_000_000_000_000u128),
        trusted_seed_pubkeys: vec![decode_hex(
            "4d4b6cd1361032ca9bd2aeb9d900aa4d45d9ead80ac9423374c451a7254d0766",
        )
        .unwrap()],
        community_id: decode_hex("01915f7a6b4c7d2e8f10112233445566").unwrap(),
        instance_domain: [0x42; 32],
        relay_pubkey: decode_hex(
            "1b84c5567b126440995d3ed5aaba0565d71e1834604819ff9c17f5e9d5dd078f",
        )
        .unwrap(),
        chain_id: 31_337,
        allowed_variants: 0b11,
        w_vouch_fp: scale(),
        w_merge_fp: fp(8, 10),
        w_job_fp: fp(1, 10),
        w_forum_fp: fp(5, 100),
        relay_attested_weight_fp: fp(25, 100),
        forum_pair_cap: 3,
        job_pair_cap: 2,
        lane2_max_head_age: 1_000,
        max_anchor_records: 200_000,
        max_estimated_pgu: 400_000_000,
        limits: NostrLimits::PILOT,
    }
}

fn input(include_c: bool) -> GuestInput {
    let a = std::fs::read(fixture().join("source-option-a.tgnw")).unwrap();
    let c = std::fs::read(fixture().join("source-option-c.tgnw")).unwrap();
    let mut anchors = vec![anchor(&a, 100)];
    let mut witnesses = vec![HeadWitness { bytes: a }];
    if include_c {
        anchors.push(anchor(&c, 101));
        witnesses.push(HeadWitness { bytes: c });
    }
    GuestInput {
        params: params(),
        anchors,
        witnesses,
        binding: Binding {
            recipient: Address::from([0xbe; 20]),
            instance_domain: pagerank_core::encode::instance_domain(
                Address::from([0x5a; 20]),
                31_337,
            ),
        },
    }
}

#[test]
fn two_epoch_fixture_mutates_state_and_exercises_carry_and_drop() {
    let a1 = std::fs::read(fixture().join("source-option-a.tgnw")).unwrap();
    let c1 = std::fs::read(fixture().join("source-option-c.tgnw")).unwrap();
    let a2 = std::fs::read(fixture().join("epoch2/source-option-a.tgnw")).unwrap();
    let c2 = std::fs::read(fixture().join("epoch2/source-option-c.tgnw")).unwrap();

    let epoch_one_input = input(true);
    let epoch_one = compute(&epoch_one_input).unwrap();
    let a1_anchor = anchor(&a1, 100);
    let c1_anchor = anchor(&c1, 101);
    let a2_anchor = anchor(&a2, 102);
    let c2_anchor = anchor(&c2, 104);
    let community_node = a2_anchor.node_id;
    let self_log_node = c2_anchor.node_id;
    assert_eq!(a1_anchor.count, 23);
    assert_eq!(a2_anchor.count, 30);
    assert_eq!(c1_anchor.count, 2);
    assert_eq!(c2_anchor.count, 3);

    // A newer malformed claim at the same maximum A count carries the preceding valid A2 head.
    // The higher-count C2 claim is deliberately withheld; H-5 forbids resurrection of C1.
    let bad_a = b"not-a-valid-second-epoch-tgnw".to_vec();
    let malformed_a2_anchor = AnchorRecord {
        node_id: a2_anchor.node_id,
        envelope_kind: ENVELOPE_NOSTR,
        head: B256::repeat_byte(0x77),
        count: a2_anchor.count,
        data_commitment: B256::from(<[u8; 32]>::from(Sha256::digest(&bad_a))),
        block_timestamp: 103,
    };
    let epoch_two_input = GuestInput {
        params: params(),
        anchors: vec![a1_anchor, c1_anchor, a2_anchor, malformed_a2_anchor, c2_anchor],
        witnesses: vec![
            HeadWitness { bytes: a1 },
            HeadWitness { bytes: c1 },
            HeadWitness { bytes: a2 },
            HeadWitness { bytes: bad_a },
        ],
        binding: epoch_one_input.binding,
    };
    let epoch_two = compute(&epoch_two_input).unwrap();
    let alice: [u8; 32] =
        decode_hex("4d4b6cd1361032ca9bd2aeb9d900aa4d45d9ead80ac9423374c451a7254d0766").unwrap();
    let bob: [u8; 32] =
        decode_hex("531fe6068134503d2723133227c867ac8fa6c83c537e9a44c3c5bdbdcb1fe337").unwrap();
    let agent: [u8; 32] =
        decode_hex("462779ad4aad39514614751a71085f2f10e1c7a593e4e030efb5b8721ce55b0b").unwrap();
    let added: [u8; 32] =
        decode_hex("62c0a046dacce86ddd0343c6d3c7c79c2208ba0d9c9cf24a6d046d21d21f90f7").unwrap();
    let alice_node = nostr_node_id(&alice);
    let bob_node = nostr_node_id(&bob);
    let agent_node = nostr_node_id(&agent);
    let added_node = nostr_node_id(&added);

    // The relay roster is canonical pubkey order, not announcement order.
    let mut expected_roster = vec![alice, bob, added];
    expected_roster.sort();
    assert_eq!(epoch_two.roster, expected_roster);
    assert_eq!(epoch_two.agents.len(), 1);
    assert_eq!(epoch_two.agents[0].agent, agent);
    assert_eq!(epoch_two.agents[0].owner, alice);

    // Replacement changes Alice's vouch to 55%; the flipped forum vote and merge are now live.
    assert_eq!(epoch_two.outgoing[&alice_node][&bob_node], fp(35, 100));
    // Bob's vouch was validly deleted; only Bob's forum upvote toward Alice remains.
    assert_eq!(epoch_two.outgoing[&bob_node][&alice_node], fp(125, 10_000));
    // The newly admitted member's completed J1 lifecycle targets the delegated agent.
    assert_eq!(epoch_two.outgoing[&added_node][&agent_node], fp(25, 1_000));
    // With C2 unavailable, the agent vouch remains only relay/exporter-attested and discounted.
    assert_eq!(epoch_two.outgoing[&agent_node][&bob_node], fp(1625, 10_000));

    assert_eq!(epoch_two.journal.anchor_count, 5);
    assert_eq!(epoch_two.journal.total_value, epoch_two_input.params.total_pool);
    assert_ne!(epoch_one.journal.output_root, epoch_two.journal.output_root);
    assert_ne!(epoch_one.journal.skipped_digest, epoch_two.journal.skipped_digest);
    assert!(epoch_two.skips.iter().any(|skip| {
        skip.node_id == community_node
            && skip.reason == pagerank_core::skip_reason::CARRIED
            && skip.epoch_observed == 102
    }));
    assert!(epoch_two.skips.iter().any(|skip| {
        skip.node_id == self_log_node
            && skip.reason == pagerank_core::skip_reason::DROPPED
            && skip.epoch_observed == 104
    }));
    assert_eq!(compute(&epoch_two_input).unwrap().journal, epoch_two.journal);
}

#[test]
fn mixed_a_c_fixture_derives_all_four_rules_once() {
    let result = compute(&input(true)).unwrap();
    let alice: [u8; 32] =
        decode_hex("4d4b6cd1361032ca9bd2aeb9d900aa4d45d9ead80ac9423374c451a7254d0766").unwrap();
    let bob: [u8; 32] =
        decode_hex("531fe6068134503d2723133227c867ac8fa6c83c537e9a44c3c5bdbdcb1fe337").unwrap();
    let agent: [u8; 32] =
        decode_hex("462779ad4aad39514614751a71085f2f10e1c7a593e4e030efb5b8721ce55b0b").unwrap();
    let alice_node = nostr_node_id(&alice);
    let bob_node = nostr_node_id(&bob);
    let agent_node = nostr_node_id(&agent);

    assert_eq!(result.roster, vec![alice, bob]);
    assert_eq!(result.agents.len(), 1);
    assert_eq!(result.agents[0].agent, agent);
    assert_eq!(result.agents[0].owner, alice);
    assert_eq!(
        result.bindings[&alice_node],
        "0x4a62316623ad457f02cdc5d997ded67a383ec569".parse::<Address>().unwrap()
    );

    // Alice→Bob: 25%-vouch (same-second lower id wins) + one merge, both A-discounted.
    assert_eq!(result.outgoing[&alice_node][&bob_node], fp(2625, 10_000));
    // Bob→Alice: 70%-vouch + one live forum vote, both A-discounted.
    assert_eq!(result.outgoing[&bob_node][&alice_node], fp(1875, 10_000));
    // The duplicated agent vouch is included once at its stronger Option-C provenance.
    assert_eq!(result.outgoing[&agent_node][&bob_node], fp(65, 100));
    // J1 needs the A request and C result, so joint provenance remains A-discounted.
    assert_eq!(result.outgoing[&alice_node][&agent_node], fp(25, 1_000));
    assert_eq!(result.journal.total_value, input(true).params.total_pool);
    assert_eq!(result.journal.anchor_count, 2);
}

#[test]
fn option_c_strengthens_but_does_not_duplicate_the_same_event() {
    let only_a = compute(&input(false)).unwrap();
    let mixed = compute(&input(true)).unwrap();
    let agent = nostr_node_id(
        &decode_hex("462779ad4aad39514614751a71085f2f10e1c7a593e4e030efb5b8721ce55b0b").unwrap(),
    );
    let bob = nostr_node_id(
        &decode_hex("531fe6068134503d2723133227c867ac8fa6c83c537e9a44c3c5bdbdcb1fe337").unwrap(),
    );
    assert_eq!(only_a.outgoing[&agent][&bob], fp(1625, 10_000));
    assert_eq!(mixed.outgoing[&agent][&bob], fp(65, 100));
}

#[test]
fn rule_phi_carries_the_newest_valid_head_past_malformed_bytes() {
    let good = std::fs::read(fixture().join("source-option-a.tgnw")).unwrap();
    let bad = b"not-a-tgnw-bundle".to_vec();
    let good_anchor = anchor(&good, 100);
    let node_id = good_anchor.node_id;
    let bad_anchor = AnchorRecord {
        node_id,
        envelope_kind: ENVELOPE_NOSTR,
        head: B256::repeat_byte(0x55),
        count: good_anchor.count,
        data_commitment: B256::from(<[u8; 32]>::from(Sha256::digest(&bad))),
        block_timestamp: 101,
    };
    let result = compute(&GuestInput {
        params: params(),
        anchors: vec![good_anchor, bad_anchor],
        witnesses: vec![HeadWitness { bytes: good }, HeadWitness { bytes: bad }],
        binding: Binding::default(),
    })
    .unwrap();

    assert_eq!(result.roster.len(), 2);
    assert!(result.skips.iter().any(|skip| {
        skip.node_id == node_id
            && skip.reason == pagerank_core::skip_reason::CARRIED
            && skip.epoch_observed == 100
    }));
}

#[test]
fn rule_phi_never_resurrects_a_lower_signed_count() {
    let good = std::fs::read(fixture().join("source-option-a.tgnw")).unwrap();
    let bad = b"not-a-tgnw-bundle".to_vec();
    let good_anchor = anchor(&good, 100);
    let node_id = good_anchor.node_id;
    let bad_anchor = AnchorRecord {
        node_id,
        envelope_kind: ENVELOPE_NOSTR,
        head: B256::repeat_byte(0x55),
        count: good_anchor.count + 1,
        data_commitment: B256::from(<[u8; 32]>::from(Sha256::digest(&bad))),
        block_timestamp: 101,
    };
    let result = compute(&GuestInput {
        params: params(),
        anchors: vec![good_anchor, bad_anchor],
        witnesses: vec![HeadWitness { bytes: good }, HeadWitness { bytes: bad }],
        binding: Binding::default(),
    })
    .unwrap();

    assert!(result.roster.is_empty());
    assert_eq!(result.skips.len(), 1);
    assert_eq!(result.skips[0].node_id, node_id);
    assert_eq!(result.skips[0].reason, pagerank_core::skip_reason::DROPPED);
    assert_eq!(result.skips[0].epoch_observed, 101);
}

#[test]
fn rule_phi_drops_a_withheld_head_without_aborting_the_epoch() {
    let bytes = std::fs::read(fixture().join("source-option-a.tgnw")).unwrap();
    let withheld = anchor(&bytes, 100);
    let node_id = withheld.node_id;
    let result = compute(&GuestInput {
        params: params(),
        anchors: vec![withheld],
        witnesses: Vec::new(),
        binding: Binding::default(),
    })
    .unwrap();

    assert!(result.roster.is_empty());
    assert!(result.scores.is_empty());
    assert!(result.outgoing.is_empty());
    assert_eq!(result.skips.len(), 1);
    assert_eq!(result.skips[0].node_id, node_id);
    assert_eq!(result.skips[0].reason, pagerank_core::skip_reason::DROPPED);
    assert_eq!(result.journal.total_value, U256::ZERO);
}

#[test]
fn invalid_consensus_bounds_fail_before_witness_processing() {
    let mut bad = params();
    bad.max_anchor_records = 0;
    let error = compute(&GuestInput {
        params: bad,
        anchors: Vec::new(),
        witnesses: Vec::new(),
        binding: Binding::default(),
    })
    .unwrap_err();
    assert_eq!(
        error,
        nostr_workspace_core::compute::ComputeError::Params(
            nostr_workspace_core::params::ParamsError::Limits
        )
    );
}

#[test]
fn unsafe_rank_and_seed_params_are_rejected() {
    let mut wrong_domain = params();
    wrong_domain.output_domain[0] ^= 1;
    assert_eq!(
        wrong_domain.validate(),
        Err(nostr_workspace_core::params::ParamsError::OutputDomain)
    );

    let mut bad_scale = params();
    bad_scale.precision_scale /= U256::from(10);
    assert_eq!(bad_scale.validate(), Err(nostr_workspace_core::params::ParamsError::Rank));

    let mut runaway = params();
    runaway.trust_multiplier_fp = scale() * U256::from(100);
    runaway.max_iterations = nostr_workspace_core::params::MAX_ITERATIONS;
    assert_eq!(runaway.validate(), Err(nostr_workspace_core::params::ParamsError::Rank));

    let mut zero_seed = params();
    zero_seed.trusted_seed_pubkeys = vec![[0; 32]];
    assert_eq!(zero_seed.validate(), Err(nostr_workspace_core::params::ParamsError::Seed));
}

#[test]
fn an_address_shaped_node_leaf_still_cannot_cross_program_domains() {
    let address = alloy_primitives::Address::from([0x44; 20]);
    let mut key = [0u8; 32];
    key[12..].copy_from_slice(address.as_slice());
    let value = U256::from(7);
    assert_eq!(
        nostr_workspace_core::compute::node_output_leaf(B256::from(key), value),
        pagerank_core::merkle::output_leaf(address, value)
    );

    let foreign_domain = alloy_primitives::keccak256(b"trustgraphs.output.hypercerts-node.v1");
    assert_ne!(foreign_domain, output_domain());
    let mut wrong_program = params();
    wrong_program.output_domain = foreign_domain;
    assert_eq!(
        wrong_program.validate(),
        Err(nostr_workspace_core::params::ParamsError::OutputDomain)
    );
}

#[test]
fn checked_in_golden_locks_params_journal_blob_and_cid() {
    let golden: serde_json::Value = serde_json::from_str(
        &std::fs::read_to_string(
            Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/golden/nostr-workspace.json"),
        )
        .unwrap(),
    )
    .unwrap();
    let input = input(true);
    let result = compute(&input).unwrap();

    assert_eq!(
        format!(
            "0x{}",
            alloy_primitives::hex::encode(nostr_workspace_core::params_hash(&input.params))
        ),
        golden["paramsHash"]
    );
    assert_eq!(
        format!(
            "0x{}",
            alloy_primitives::hex::encode(pagerank_core::encode::journal_encoded(&result.journal))
        ),
        golden["journal"]["encoded"]
    );
    assert_eq!(
        format!(
            "0x{}",
            alloy_primitives::hex::encode(pagerank_core::encode::journal_digest(&result.journal))
        ),
        golden["journal"]["digest"]
    );
    assert_eq!(String::from_utf8(result.blob).unwrap(), golden["cid"]["blob"]);
    assert_eq!(result.cid, golden["cid"]["cid"]);
}
