use std::path::{Path, PathBuf};

use alloy_primitives::{Address, B256, U256};
use nostr_envelope::nostr::event::decode_hex;
use nostr_envelope::nostr::tgnw;
use nostr_envelope::nostr::{community_node_id, nostr_node_id, CommitmentVariant, NostrLimits};
use nostr_workspace_core::compute::{
    compute, node_output_leaf, GuestInput, HeadWitness, ENVELOPE_NOSTR,
};
use nostr_workspace_core::params::{
    output_domain, params_encoded, params_hash, program_id, seed_set_root, Params, PARAMS_VERSION,
};
use pagerank_core::{encode, merkle, AnchorRecord, Binding};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use zk_core::anchor::{anchor_leaf, skip_leaf};

fn fixture() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../test/fixtures/nostr/buzz/a362fecc2389955f942c9581bdfeba379ab115b3")
}

fn scale() -> U256 {
    U256::from(1_000_000_000_000_000_000u64)
}

fn fp(numerator: u64, denominator: u64) -> U256 {
    scale() * U256::from(numerator) / U256::from(denominator)
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

fn sample_input() -> GuestInput {
    let a = std::fs::read(fixture().join("source-option-a.tgnw")).unwrap();
    let c = std::fs::read(fixture().join("source-option-c.tgnw")).unwrap();
    GuestInput {
        params: params(),
        anchors: vec![anchor(&a, 100), anchor(&c, 101)],
        witnesses: vec![HeadWitness { bytes: a }, HeadWitness { bytes: c }],
        binding: Binding {
            recipient: Address::from([0xbe; 20]),
            instance_domain: encode::instance_domain(Address::from([0x5a; 20]), 31_337),
        },
    }
}

fn hx(bytes: &[u8]) -> String {
    format!("0x{}", alloy_primitives::hex::encode(bytes))
}

fn event_json(event: &nostr_workspace_core::semantics::SemanticEvent) -> Value {
    let disposition = match event.disposition {
        nostr_envelope::nostr::EventDisposition::Accepted => json!({ "accepted": true }),
        nostr_envelope::nostr::EventDisposition::Skipped(reason) => {
            json!({ "accepted": false, "reason": reason as u8 })
        }
    };
    json!({
        "id": hx(&event.event.id),
        "pubkey": hx(&event.event.pubkey),
        "createdAt": event.event.created_at.to_string(),
        "kind": event.event.kind,
        "tags": event.event.tags,
        "content": event.event.content,
        "oaOwner": event.oa_owner.map(|owner| hx(&owner)),
        "disposition": disposition,
        "provenance": event.provenance as u8,
        "order": [event.order.0.to_string(), event.order.1],
        "observedAt": event.observed_at.to_string(),
    })
}

fn main() {
    let input = sample_input();
    input.params.validate().unwrap();
    let result = compute(&input).unwrap();
    let p = &input.params;
    let j = &result.journal;

    let params = json!({
        "version": p.version,
        "outputDomain": hx(p.output_domain.as_slice()),
        "dampingFp": p.damping_fp.to_string(),
        "toleranceFp": p.tolerance_fp.to_string(),
        "maxIterations": p.max_iterations,
        "trustMultiplierFp": p.trust_multiplier_fp.to_string(),
        "trustShareFp": p.trust_share_fp.to_string(),
        "trustDecayFp": p.trust_decay_fp.to_string(),
        "precisionScale": p.precision_scale.to_string(),
        "totalPool": p.total_pool.to_string(),
        "trustedSeedPubkeys": p.trusted_seed_pubkeys.iter().map(|key| hx(key)).collect::<Vec<_>>(),
        "seedSetRoot": hx(seed_set_root(p).as_slice()),
        "communityId": hx(&p.community_id),
        "instanceDomain": hx(&p.instance_domain),
        "relayPubkey": hx(&p.relay_pubkey),
        "chainId": p.chain_id.to_string(),
        "allowedVariants": p.allowed_variants,
        "wVouchFp": p.w_vouch_fp.to_string(),
        "wMergeFp": p.w_merge_fp.to_string(),
        "wJobFp": p.w_job_fp.to_string(),
        "wForumFp": p.w_forum_fp.to_string(),
        "relayAttestedWeightFp": p.relay_attested_weight_fp.to_string(),
        "forumPairCap": p.forum_pair_cap,
        "jobPairCap": p.job_pair_cap,
        "lane2MaxHeadAge": p.lane2_max_head_age.to_string(),
        "maxAnchorRecords": p.max_anchor_records,
        "maxEstimatedPgu": p.max_estimated_pgu.to_string(),
        "limits": {
            "envelopeBytes": p.limits.envelope_bytes,
            "selectedHeads": p.limits.selected_heads,
            "auditEntries": p.limits.audit_entries,
            "events": p.limits.events,
            "encodedEventBytes": p.limits.encoded_event_bytes,
            "contentBytes": p.limits.content_bytes,
            "tagsPerEvent": p.limits.tags_per_event,
            "elementsPerTag": p.limits.elements_per_tag,
            "tagStringBytes": p.limits.tag_string_bytes,
            "allTagStringsBytes": p.limits.all_tag_strings_bytes,
            "auditDetailBytes": p.limits.audit_detail_bytes,
            "nip01Signatures": p.limits.nip01_signatures,
            "oaSignatures": p.limits.oa_signatures,
        },
        "encoded": hx(&params_encoded(p)),
        "hash": hx(params_hash(p).as_slice()),
    });

    let anchors: Vec<_> = input
        .anchors
        .iter()
        .map(|anchor| {
            json!({
                "nodeId": hx(anchor.node_id.as_slice()),
                "envelopeKind": anchor.envelope_kind,
                "head": hx(anchor.head.as_slice()),
                "count": anchor.count.to_string(),
                "dataCommitment": hx(anchor.data_commitment.as_slice()),
                "blockTimestamp": anchor.block_timestamp.to_string(),
                "leaf": hx(anchor_leaf(
                    anchor.node_id,
                    anchor.envelope_kind,
                    anchor.head,
                    anchor.count,
                    anchor.data_commitment,
                    anchor.block_timestamp,
                ).as_slice()),
            })
        })
        .collect();
    let edges: Vec<_> = result
        .outgoing
        .iter()
        .flat_map(|(source, targets)| {
            targets.iter().map(move |(target, weight)| {
                json!({
                    "source": hx(source.as_slice()),
                    "target": hx(target.as_slice()),
                    "weightFp": weight.to_string(),
                })
            })
        })
        .collect();
    let scores: Vec<_> = result
        .scores
        .iter()
        .map(|(node, value)| {
            json!({
                "nodeId": hx(node.as_slice()),
                "value": value.to_string(),
                "nodeLeaf": hx(node_output_leaf(*node, *value).as_slice()),
                "address": result.bindings.get(node).map(|address| hx(address.as_slice())),
                "addressLeaf": result.bindings.get(node).map(|address| hx(merkle::output_leaf(*address, *value).as_slice())),
            })
        })
        .collect();
    let skips: Vec<_> = result
        .skips
        .iter()
        .map(|skip| {
            json!({
                "nodeId": hx(skip.node_id.as_slice()),
                "reason": skip.reason,
                "epochObserved": skip.epoch_observed.to_string(),
                "leaf": hx(skip_leaf(skip).as_slice()),
            })
        })
        .collect();
    let agents: Vec<_> = result
        .agents
        .iter()
        .map(|agent| {
            json!({
                "agentPubkey": hx(&agent.agent),
                "agentNodeId": hx(nostr_node_id(&agent.agent).as_slice()),
                "ownerPubkey": hx(&agent.owner),
                "ownerNodeId": hx(nostr_node_id(&agent.owner).as_slice()),
            })
        })
        .collect();
    let bindings: Vec<_> = result
        .bindings
        .iter()
        .map(|(node, address)| json!({ "nodeId": hx(node.as_slice()), "address": hx(address.as_slice()) }))
        .collect();
    let rows: Vec<_> = result.events.iter().map(event_json).collect();

    let output = json!({
        "note": "generated from the pinned mixed Option-A/Option-C Buzz fixture",
        "programId": hx(program_id().as_slice()),
        "outputDomain": hx(output_domain().as_slice()),
        "params": params,
        "paramsHash": hx(j.params_hash.as_slice()),
        "anchors": anchors,
        "journal": {
            "acc": hx(j.acc.as_slice()),
            "leafCount": j.leaf_count.to_string(),
            "anchorAcc": hx(j.anchor_acc.as_slice()),
            "anchorCount": j.anchor_count.to_string(),
            "paramsHash": hx(j.params_hash.as_slice()),
            "outputRoot": hx(j.output_root.as_slice()),
            "ipfsHash": hx(j.ipfs_hash.as_slice()),
            "cidDigest": hx(j.cid_digest.as_slice()),
            "totalValue": j.total_value.to_string(),
            "skippedDigest": hx(j.skipped_digest.as_slice()),
            "recipient": hx(j.recipient.as_slice()),
            "instanceDomain": hx(j.instance_domain.as_slice()),
            "encoded": hx(&encode::journal_encoded(j)),
            "digest": hx(encode::journal_digest(j).as_slice()),
        },
        "cid": {
            "blob": String::from_utf8(result.blob.clone()).unwrap(),
            "blobHex": hx(&result.blob),
            "cid": result.cid,
        },
        "scores": {
            "count": scores.len(),
            "entries": scores,
        },
        "skipped": {
            "count": skips.len(),
            "entries": skips,
            "digest": hx(j.skipped_digest.as_slice()),
        },
        "metadata": {
            "rosterPubkeys": result.roster.iter().map(|key| hx(key)).collect::<Vec<_>>(),
            "agents": agents,
            "bindings": bindings,
        },
        "recompute": {
            "note": "authenticated, envelope-verified rows for reduced-tier semantic and root recomputation",
            "events": rows,
            "edges": edges,
        },
    });
    print!("{}", serde_json::to_string_pretty(&output).unwrap());
}
