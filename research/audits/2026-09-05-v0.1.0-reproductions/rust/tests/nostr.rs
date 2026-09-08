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
        .join("../../../../tests/fixtures/nostr/buzz/a362fecc2389955f942c9581bdfeba379ab115b3")
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
        trust_share_fp: scale(),
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
fn nostr_omitted_valid_witness_changes_root_under_same_checkpoint() {
    let full = input(true);
    let honest = compute(&full).unwrap();
    let mut omitted = full.clone();
    omitted.witnesses.remove(0);
    let manipulated = compute(&omitted).unwrap();
    assert_eq!(honest.journal.anchor_acc, manipulated.journal.anchor_acc);
    assert_eq!(honest.journal.params_hash, manipulated.journal.params_hash);
    assert_ne!(honest.journal.output_root, manipulated.journal.output_root);
    println!(
        "same checkpoint roots full={} omitted={}",
        honest.journal.output_root, manipulated.journal.output_root
    );
}
#[test]
fn absent_configured_seed_disables_trust_gate() {
    let missing_seed =
        decode_hex::<32>("62c0a046dacce86ddd0343c6d3c7c79c2208ba0d9c9cf24a6d046d21d21f90f7")
            .unwrap();
    let mut absent = input(true);
    absent.params.trusted_seed_pubkeys = vec![missing_seed];
    let seeded = compute(&absent).unwrap();
    assert!(seeded.scores.iter().all(|(node, _)| *node != nostr_node_id(&missing_seed)));
    absent.params.trusted_seed_pubkeys.clear();
    let unseeded = compute(&absent).unwrap();
    assert_eq!(seeded.scores, unseeded.scores);
    assert_eq!(seeded.journal.total_value, absent.params.total_pool);
    println!("absent configured seed gives entire pool={} to {} untrusted nodes exactly as unseeded mode",seeded.journal.total_value,seeded.scores.len());
}
