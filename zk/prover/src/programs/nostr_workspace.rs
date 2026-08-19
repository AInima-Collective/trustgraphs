//! Host/prover commands for the isolated production `nostr-workspace` guest.

use std::path::{Path, PathBuf};

use alloy_primitives::{Address, B256, U256};
use anyhow::Result;
use clap::Subcommand;
use nostr_envelope::nostr::event::decode_hex;
use nostr_envelope::nostr::tgnw;
use nostr_envelope::nostr::{community_node_id, nostr_node_id, CommitmentVariant, NostrLimits};
use nostr_workspace_core::compute::{compute, GuestInput, HeadWitness, ENVELOPE_NOSTR};
use nostr_workspace_core::params::{output_domain, params_hash, Params, PARAMS_VERSION};
use pagerank_core::{encode, AnchorRecord, Binding};
use sha2::{Digest, Sha256};
use sp1_sdk::{include_elf, Elf};

use crate::common;

pub fn elf() -> Elf {
    include_elf!("nostr-workspace")
}

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
    let bundle = tgnw::decode(bytes, &NostrLimits::HARD).expect("built-in TGNW");
    let (node_id, head, count) = match bundle.variant {
        CommitmentVariant::BuzzAuditV1 => (
            community_node_id(&bundle.community_id),
            B256::from(bundle.audit.last().expect("audit head").hash),
            bundle.audit.len() as u64,
        ),
        CommitmentVariant::SelfLogV1 => {
            let head = bundle
                .head_event
                .as_ref()
                .expect("self-log head event")
                .tags
                .iter()
                .find(|tag| tag.first().map(String::as_str) == Some("head"))
                .expect("head tag");
            (
                nostr_node_id(&bundle.authority),
                B256::from(decode_hex::<32>(&head[1]).expect("head hex")),
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

pub fn sample_input() -> GuestInput {
    let a = std::fs::read(fixture().join("source-option-a.tgnw")).expect("Option-A fixture");
    let c = std::fs::read(fixture().join("source-option-c.tgnw")).expect("Option-C fixture");
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

fn load_input(path: Option<&String>) -> Result<GuestInput> {
    match path {
        Some(path) => Ok(serde_json::from_str(&std::fs::read_to_string(path)?)?),
        None => Ok(sample_input()),
    }
}

#[derive(Subcommand)]
pub enum Command {
    /// Print the production guest verification key.
    Vkey,
    /// Print the frozen 39-word params hash.
    Paramshash { input: Option<String> },
    /// Execute the guest and byte-assert its journal against native computation.
    Execute {
        input: Option<String>,
        #[arg(long)]
        out_dir: Option<String>,
    },
    /// Prove, locally verify, and write the on-chain proof blob.
    Prove {
        input: Option<String>,
        #[arg(long)]
        groth16: bool,
        #[arg(long)]
        out_dir: Option<String>,
    },
}

const OUT_DIR: &str = "nostr-workspace";

pub fn run(command: Command) -> Result<()> {
    match command {
        Command::Vkey => common::print_vkey(elf()),
        Command::Paramshash { input } => {
            let input = load_input(input.as_ref())?;
            println!("0x{}", hex::encode(params_hash(&input.params)));
            Ok(())
        }
        Command::Execute { input, out_dir } => {
            execute(load_input(input.as_ref())?, common::out_dir(out_dir.as_ref(), OUT_DIR)?)
        }
        Command::Prove { input, groth16, out_dir } => {
            prove(load_input(input.as_ref())?, groth16, common::out_dir(out_dir.as_ref(), OUT_DIR)?)
        }
    }
}

fn write_artifacts(native: &nostr_workspace_core::ComputeResult, out: &Path) -> Result<()> {
    common::write_out(out, "nostr_workspace_blob.json", &native.blob)?;
    common::write_out(
        out,
        "nostr_workspace_journal.json",
        serde_json::to_string_pretty(&native.journal)?,
    )?;
    common::write_out(
        out,
        "nostr_workspace_skips.json",
        serde_json::to_string_pretty(&native.skips)?,
    )?;
    let metadata = serde_json::json!({
        "format": "trustgraphs.nostr.indexer-sidecar.v1",
        "roster": native.roster.iter().map(|pubkey| serde_json::json!({
            "pubkey": format!("0x{}", hex::encode(pubkey)),
            "nodeId": format!("0x{}", hex::encode(nostr_node_id(pubkey))),
        })).collect::<Vec<_>>(),
        "agents": native.agents.iter().map(|link| serde_json::json!({
            "agentPubkey": format!("0x{}", hex::encode(link.agent)),
            "agentNodeId": format!("0x{}", hex::encode(nostr_node_id(&link.agent))),
            "ownerPubkey": format!("0x{}", hex::encode(link.owner)),
            "ownerNodeId": format!("0x{}", hex::encode(nostr_node_id(&link.owner))),
        })).collect::<Vec<_>>(),
        "bindings": native.bindings.iter().map(|(node, address)| {
            (format!("0x{}", hex::encode(node)), format!("0x{}", hex::encode(address)))
        }).collect::<std::collections::BTreeMap<_, _>>(),
        "skips": native.skips,
        "skipSummary": native.skips.iter().fold(std::collections::BTreeMap::<u8, u64>::new(), |mut out, skip| {
            *out.entry(skip.reason).or_default() += 1;
            out
        }),
    });
    common::write_out(
        out,
        "nostr_workspace_metadata.json",
        serde_json::to_string_pretty(&metadata)?,
    )?;
    Ok(())
}

fn print_result(native: &nostr_workspace_core::ComputeResult) {
    println!("journalDigest: 0x{}", hex::encode(encode::journal_digest(&native.journal)));
    println!("anchorAcc:     0x{}", hex::encode(native.journal.anchor_acc));
    println!("anchorCount:   {}", native.journal.anchor_count);
    println!("outputRoot:    0x{}", hex::encode(native.journal.output_root));
    println!("paramsHash:    0x{}", hex::encode(native.journal.params_hash));
    println!("ipfsHash:      0x{}", hex::encode(native.journal.ipfs_hash));
    println!("cid:           {}", native.cid);
    println!("totalValue:    {}", native.journal.total_value);
    println!("skippedDigest: 0x{}", hex::encode(native.journal.skipped_digest));
    println!("recipient:     0x{}", hex::encode(native.journal.recipient));
    println!("instanceDomain: 0x{}", hex::encode(native.journal.instance_domain));
}

fn execute(input: GuestInput, out: PathBuf) -> Result<()> {
    let native = compute(&input).map_err(|error| anyhow::anyhow!("native compute: {error:?}"))?;
    let public_values = encode::journal_encoded(&native.journal);
    common::execute_and_check(elf(), &input, &public_values)?;
    write_artifacts(&native, &out)?;
    print_result(&native);
    Ok(())
}

fn prove(input: GuestInput, groth16: bool, out: PathBuf) -> Result<()> {
    let native = compute(&input).map_err(|error| anyhow::anyhow!("native compute: {error:?}"))?;
    let (public_values, seal) = common::prove_and_verify(elf(), &input, groth16)?;
    let blob = common::abi_encode_two_bytes(&public_values, &seal);
    common::write_out(&out, "nostr_workspace_proof.bin", &blob)?;
    common::write_out(&out, "nostr_workspace_public_values.bin", &public_values)?;
    write_artifacts(&native, &out)?;
    print_result(&native);
    println!("publicValues: 0x{}", hex::encode(public_values));
    Ok(())
}
