//! Hypercerts root-producer program (lane-2-only): proves the §3 edge semantics + fixed-point
//! Trust-Aware PageRank over anchored atproto repos and emits the journal-v2 merkle root + score
//! blob. Mirrors `trust_graph.rs`; the built-in sample is the seeded-PDS fixture
//! (`spike/hypercerts-fixture`) so `execute`/`prove` run with no external witness.

use alloy_primitives::{B256, U256};
use anyhow::{anyhow, Result};
use clap::Subcommand;
use envelopes::atproto::{plc::PlcOpWitness, AtprotoWitness};
use hypercerts_core::compute::{compute, params_hash, GuestInput, Params, ENVELOPE_ATPROTO};
use hypercerts_core::semantics::did_node_id;
use ipld_core::ipld::Ipld;
use pagerank_core::{encode, AnchorRecord};
use sha2::Digest;
use sp1_sdk::{include_elf, Elf};
use std::collections::BTreeMap;

use crate::common;

/// The hypercerts guest ELF, built by build.rs (`sp1_build::build_program`).
fn load_elf() -> Elf {
    include_elf!("trustgraph-hypercerts-program")
}

fn s() -> U256 {
    U256::from(1_000_000_000_000_000_000u64)
}
fn fp(n: u64, d: u64) -> U256 {
    s() * U256::from(n) / U256::from(d)
}

/// §6.1 governance-pinned launch parameters (identical to the crate's compute fixture). The
/// sole partner-curated trusted seed is the fixture's own repo owner (`seed_did`).
fn params(seed_did: &str) -> Params {
    Params {
        damping_fp: fp(85, 100),
        tolerance_fp: s() / U256::from(1_000_000u64),
        max_iterations: 100,
        trust_multiplier_fp: U256::from(2) * s(),
        trust_share_fp: fp(15, 100),
        trust_decay_fp: fp(80, 100),
        precision_scale: s(),
        total_pool: U256::from(1_000_000_000_000_000_000_000_000u128),
        trusted_seed_dids: vec![seed_did.to_string()],
        w_follow_fp: fp(2, 10),
        w_badge_fp: fp(5, 10),
        w_eval_fp: s(),
        w_attrib_fp: fp(8, 10),
        ack_boost_fp: U256::from(2) * s(),
        unacked_attrib_fp: fp(5, 10),
        pds_attested_weight_fp: fp(5, 10),
        lane2_max_head_age: 1_000_000,
    }
}

/// JSON → Ipld for the PLC audit-log ops (strings/lists/maps/null/bool/int only) — canonicality
/// is re-checked in-guest by `plc::decode_op`. Same conversion as `tests/compute_fixture.rs`.
fn json_to_ipld(v: &serde_json::Value) -> Ipld {
    match v {
        serde_json::Value::Null => Ipld::Null,
        serde_json::Value::Bool(b) => Ipld::Bool(*b),
        serde_json::Value::Number(n) => Ipld::Integer(n.as_i64().unwrap() as i128),
        serde_json::Value::String(x) => Ipld::String(x.clone()),
        serde_json::Value::Array(a) => Ipld::List(a.iter().map(json_to_ipld).collect()),
        serde_json::Value::Object(o) => {
            let mut m = BTreeMap::new();
            for (k, val) in o {
                m.insert(k.clone(), json_to_ipld(val));
            }
            Ipld::Map(m)
        }
    }
}

/// The built-in sample scenario: the seeded-PDS fixture (matches
/// `packages/hypercerts-core/tests/compute_fixture.rs` and `test/golden/hypercerts.json`).
pub fn sample_input() -> GuestInput {
    let root = concat!(env!("CARGO_MANIFEST_DIR"), "/../..");
    let car =
        std::fs::read(format!("{root}/spike/hypercerts-fixture/fixtures/hypercerts.car")).unwrap();
    let plc_json: serde_json::Value = serde_json::from_str(
        &std::fs::read_to_string(format!(
            "{root}/spike/hypercerts-fixture/fixtures/hypercerts.plc.json"
        ))
        .unwrap(),
    )
    .unwrap();
    let entries = plc_json.as_array().unwrap();
    // The seed DID is the fixture repo's own owner (PLC log subject) — read it so the sample
    // tracks whatever the generator currently pins, rather than a hard-coded DID.
    let seed_did = entries[0]["did"].as_str().expect("plc entry did").to_string();
    let mut plc_ops = Vec::new();
    for entry in entries {
        plc_ops.push(PlcOpWitness {
            op_bytes: serde_ipld_dagcbor::to_vec(&json_to_ipld(&entry["operation"])).unwrap(),
            created_at: 0,
            nullified: entry["nullified"].as_bool().unwrap_or(false),
        });
    }
    let parsed = envelopes::atproto::carset::Car::parse(&car).unwrap();
    let commit = parsed.get(&parsed.roots[0]).unwrap();
    let head = B256::from(<[u8; 32]>::from(sha2::Sha256::digest(commit)));

    GuestInput {
        params: params(&seed_did),
        anchors: vec![AnchorRecord {
            node_id: did_node_id(&seed_did),
            envelope_kind: ENVELOPE_ATPROTO,
            head,
            data_commitment: B256::ZERO,
            block_timestamp: 1_000,
        }],
        witnesses: vec![AtprotoWitness { did: seed_did.clone(), car, plc_ops }],
        strongref_targets: BTreeMap::new(),
    }
}

fn load_input(path: Option<&String>) -> Result<GuestInput> {
    match path {
        Some(p) => Ok(serde_json::from_str(&std::fs::read_to_string(p)?)?),
        None => Ok(sample_input()),
    }
}

/// `hypercerts` subcommands. `input.json` is a serialized `hypercerts_core::compute::GuestInput`;
/// omit it to use the built-in sample (the seeded fixture; identical to test/golden/hypercerts.json).
#[derive(Subcommand)]
pub enum Command {
    /// Print the guest program verification key (bytes32) for deployment.
    Vkey,
    /// Print keccak256 of the canonical params (17-word tuple, §6.1).
    Paramshash { input: Option<String> },
    /// Assemble the atproto witness bundle for the seed DID (host-only, network). Not wired here:
    /// witness fetching lives in the `witness fetch` group behind `--features witness-atproto`.
    Fetch,
    /// Run the guest via the SP1 executor and assert it matches native `compute` (no proof).
    Execute { input: Option<String> },
    /// Generate a proof (core, or Groth16-wrapped), verify it locally, and write the on-chain proof
    /// blob `abi.encode(publicValues, seal)` to hypercerts_proof.bin.
    Prove {
        input: Option<String>,
        #[arg(long)]
        groth16: bool,
    },
}

pub fn run(cmd: Command) -> Result<()> {
    match cmd {
        Command::Vkey => common::print_vkey(load_elf()),
        Command::Paramshash { input } => {
            let input = load_input(input.as_ref())?;
            println!("0x{}", hex::encode(params_hash(&input.params)));
            Ok(())
        }
        Command::Fetch => Err(anyhow!(
            "hypercerts witness assembly is not part of this group; build the prover with \
             `--features witness-atproto` and run `trustgraph-prover witness fetch --did <did>` \
             to archive the CAR + PLC log, then pass the assembled bundle to `hypercerts execute`."
        )),
        Command::Execute { input } => cmd_execute(load_input(input.as_ref())?),
        Command::Prove { input, groth16 } => cmd_prove(load_input(input.as_ref())?, groth16),
    }
}

fn cmd_execute(input: GuestInput) -> Result<()> {
    let native = compute(&input);
    let native_pub = encode::journal_encoded(&native.journal);

    common::execute_and_check(load_elf(), &input, &native_pub)?;

    println!("journalDigest: 0x{}", hex::encode(encode::journal_digest(&native.journal)));
    println!("anchorAcc:     0x{}", hex::encode(native.journal.anchor_acc));
    println!("outputRoot:    0x{}", hex::encode(native.journal.output_root));
    println!("paramsHash:    0x{}", hex::encode(native.journal.params_hash));
    println!("ipfsHash:      0x{}", hex::encode(native.journal.ipfs_hash));
    println!("cid:           {}", native.cid);
    println!("totalValue:    {}", native.journal.total_value);
    println!("skippedDigest: 0x{}", hex::encode(native.journal.skipped_digest));

    // The canonical nodeId-keyed score blob whose sha256 is `ipfsHash` and whose CID is `cid`.
    std::fs::write("hypercerts_blob.json", &native.blob)?;
    println!("wrote hypercerts_blob.json ({} bytes) — pin at the cid above", native.blob.len());
    Ok(())
}

fn cmd_prove(input: GuestInput, groth16: bool) -> Result<()> {
    let native = compute(&input);

    let (public_values, seal) = common::prove_and_verify(load_elf(), &input, groth16)?;

    let blob = common::abi_encode_two_bytes(&public_values, &seal);
    std::fs::write("hypercerts_proof.bin", &blob)?;
    std::fs::write("hypercerts_public_values.bin", &public_values)?;
    std::fs::write("hypercerts_blob.json", &native.blob)?;
    println!("wrote hypercerts_proof.bin ({} blob bytes, {} seal bytes)", blob.len(), seal.len());
    println!(
        "wrote hypercerts_blob.json ({} bytes) — pin at the cid for the UI",
        native.blob.len()
    );
    println!("publicValues: 0x{}", hex::encode(&public_values));
    Ok(())
}
