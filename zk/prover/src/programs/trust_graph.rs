//! Trust-graph root-producer program: proves correct fixed-point Trust-Aware PageRank and emits the
//! `{account -> score}` merkle root + score blob.

use alloy_primitives::{Address, B256, U256};
use anyhow::Result;
use clap::Subcommand;
use pagerank_core::{compute::compute, encode, GuestInput, Params, RawEdge};
use sp1_sdk::{include_elf, Elf};

use crate::common;

/// The root-producer guest ELF, built by build.rs (`sp1_build::build_program`).
fn load_elf() -> Elf {
    include_elf!("trustgraph-program")
}

fn scale() -> U256 {
    U256::from(10u64).pow(U256::from(18u64))
}
fn fp(n: u64, d: u64) -> U256 {
    scale() * U256::from(n) / U256::from(d)
}
fn addr(b: u8) -> Address {
    Address::from([b; 20])
}
fn edge(kind: u8, from: u8, to: u8, uid: u8, ts: u64, w: u64) -> RawEdge {
    let mut data = vec![0u8; 64];
    data[32..64].copy_from_slice(&U256::from(w).to_be_bytes::<32>());
    RawEdge {
        kind,
        attester: addr(from),
        recipient: addr(to),
        uid: B256::from([uid; 32]),
        block_timestamp: ts,
        data,
    }
}

/// The built-in sample scenario (matches test/golden/trust-graph.json).
pub fn sample_input() -> GuestInput {
    let s = scale();
    let params = Params {
        damping_fp: fp(85, 100),
        tolerance_fp: s / U256::from(1_000_000u64),
        max_iterations: 100,
        min_weight_fp: U256::ZERO,
        max_weight_fp: U256::from(100u64) * s,
        trust_multiplier_fp: U256::from(2u64) * s,
        trust_share_fp: fp(15, 100),
        trust_decay_fp: fp(80, 100),
        trusted_seeds: vec![addr(1), addr(3)],
        total_pool: U256::from(1_000_000_000_000_000_000_000_000u128),
        precision_scale: s,
        schema_uid: B256::from([0xAB; 32]),
        weight_field_index: 1,
    };
    let edges =
        vec![edge(0, 1, 2, 1, 100, 50), edge(0, 2, 3, 2, 101, 75), edge(0, 3, 1, 3, 102, 90)];
    GuestInput { edges, params }
}

fn load_input(path: Option<&String>) -> Result<GuestInput> {
    match path {
        Some(p) => Ok(serde_json::from_str(&std::fs::read_to_string(p)?)?),
        None => Ok(sample_input()),
    }
}

/// `trust-graph` subcommands. `input.json` is a serialized `pagerank_core::GuestInput`; omit it to
/// use the built-in sample (identical to test/golden/trust-graph.json).
#[derive(Subcommand)]
pub enum Command {
    /// Print the guest program verification key (bytes32) for deployment.
    Vkey,
    /// Print keccak256 of the canonical params (for the operational timelock).
    Paramshash { input: Option<String> },
    /// Run the guest via the SP1 executor and assert it matches native `compute` (no proof).
    Execute { input: Option<String> },
    /// Generate a proof (core, or Groth16-wrapped), verify it locally, and write the on-chain proof
    /// blob `abi.encode(publicValues, seal)` to proof.bin.
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
            println!("0x{}", hex::encode(encode::params_hash(&input.params)));
            Ok(())
        }
        Command::Execute { input } => cmd_execute(load_input(input.as_ref())?),
        Command::Prove { input, groth16 } => cmd_prove(load_input(input.as_ref())?, groth16),
    }
}

fn cmd_execute(input: GuestInput) -> Result<()> {
    let native = compute(&input);
    let native_pub = encode::journal_encoded(&native.journal);

    common::execute_and_check(load_elf(), &input, &native_pub)?;

    println!("journalDigest: 0x{}", hex::encode(encode::journal_digest(&native.journal)));
    println!("outputRoot:    0x{}", hex::encode(native.journal.output_root));
    println!("paramsHash:    0x{}", hex::encode(native.journal.params_hash));
    println!("ipfsHash:      0x{}", hex::encode(native.journal.ipfs_hash));
    println!("cid:           {}", native.cid);
    println!("totalValue:    {}", native.journal.total_value);
    println!("skippedDigest: 0x{}", hex::encode(native.journal.skipped_digest));

    // The canonical score blob whose sha256 is `ipfsHash` and whose CID is `cid`. Write it out so it
    // can be pinned (the UI/indexer fetch the {account -> score} scores from IPFS at that cid).
    std::fs::write("blob.json", &native.blob)?;
    println!("wrote blob.json ({} bytes) — pin at the cid above", native.blob.len());
    Ok(())
}

fn cmd_prove(input: GuestInput, groth16: bool) -> Result<()> {
    // The score blob is a pure function of the input; recompute it here so `prove` emits blob.json
    // next to proof.bin (same bytes execute writes — its sha256 is the journal's ipfsHash).
    let native = compute(&input);

    let (public_values, seal) = common::prove_and_verify(load_elf(), &input, groth16)?;

    let blob = common::abi_encode_two_bytes(&public_values, &seal);
    std::fs::write("proof.bin", &blob)?;
    std::fs::write("public_values.bin", &public_values)?;
    std::fs::write("blob.json", &native.blob)?;
    println!("wrote proof.bin ({} blob bytes, {} seal bytes)", blob.len(), seal.len());
    println!("wrote blob.json ({} bytes) — pin at the cid for the UI", native.blob.len());
    println!("publicValues: 0x{}", hex::encode(&public_values));
    Ok(())
}
