//! Trust-graph root-producer program: proves correct fixed-point Trust-Aware PageRank and emits the
//! `{account -> score}` merkle root + score blob.

use alloy_primitives::{Address, B256, U256};
use anyhow::Result;
use clap::Subcommand;
use pagerank_core::encode;
use sp1_sdk::{include_elf, Elf};
use trustgraph_core::{compute::compute, Binding, GuestInput, Params, RawEdge};

use crate::common;

/// This program's guest ELF, for callers that drive the prover as a library (`zk/operator`).
/// The vkey it derives is the one the deployed `SP1JournalVerifier` must be pinned to; the daemon
/// checks that at startup rather than discovering it on a failed submit.
pub fn elf() -> Elf {
    include_elf!("trustgraph-program-v2")
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

/// The built-in sample scenario (matches tests/golden/trust-graph.json).
pub fn sample_input() -> GuestInput {
    let s = scale();
    let params = Params {
        damping_fp: fp(85, 100),
        tolerance_fp: s / U256::from(1_000_000u64),
        max_iterations: 100,
        min_weight_fp: U256::ZERO,
        max_weight_fp: U256::from(100u64) * s,
        trust_share_fp: s,
        trust_decay_fp: fp(80, 100),
        trusted_seeds: vec![addr(1), addr(3)],
        total_pool: U256::from(1_000_000_000_000_000_000_000_000u128),
        precision_scale: s,
        schema_uid: B256::from([0xAB; 32]),
        weight_field_index: 1,
        envelope0_domain_separators: vec![],
        lane2_max_head_age: 0,
        accumulator: addr(0xAC),
        chain_id: 31337,
    };
    let edges = vec![
        edge(0, 1, 2, 1, 100, 50),
        edge(0, 2, 3, 2, 101, 75),
        edge(0, 3, 1, 3, 102, 90),
        // Regression for pair-state reconciliation: revoking the current replacement must not
        // resurrect the older 100-weight vouch.
        edge(0, 4, 5, 4, 103, 100),
        edge(0, 4, 5, 5, 104, 20),
        edge(1, 4, 5, 5, 105, 20),
    ];
    // Journal-v3 bindings use the same fixed deployment domain as the golden fixture. The strict
    // guest's built-in smoke keeps lane 2 disabled; the canonical legacy golden separately pins
    // the complete non-default lane-2 params preimage.
    let binding = Binding {
        recipient: addr(0xBE),
        instance_domain: encode::instance_domain(addr(0x5A), 31337),
    };
    GuestInput { edges, params, lane2: None, binding }
}

fn load_input(path: Option<&String>) -> Result<GuestInput> {
    match path {
        Some(p) => Ok(serde_json::from_str(&std::fs::read_to_string(p)?)?),
        None => Ok(sample_input()),
    }
}

/// `trust-graph` subcommands. `input.json` is a serialized `trustgraph_core::GuestInput`; omit it to
/// use the built-in sample (identical to tests/golden/trust-graph.json).
#[derive(Subcommand)]
pub enum Command {
    /// Print the guest program verification key (bytes32) for deployment.
    Vkey,
    /// Print keccak256 of the canonical params (for the operational timelock).
    ///
    /// Reads a `GuestInput` by default. `--params <params.json>` reads a bare
    /// `pagerank_core::Params` instead, which is what a DEPLOY needs: the snapshot's params hash
    /// has to exist before the snapshot does, and the snapshot has to exist before any checkpoint
    /// (and therefore any `GuestInput`) can be produced.
    Paramshash {
        input: Option<String>,
        #[arg(long)]
        params: Option<String>,
    },
    /// Run the guest via the SP1 executor and assert it matches native `compute` (no proof).
    Execute {
        input: Option<String>,
        /// Output directory (default: `<repo root>/.trustgraph/trust-graph/`).
        #[arg(long)]
        out_dir: Option<String>,
    },
    /// Generate a proof (core, or Groth16-wrapped), verify it locally, and write the on-chain proof
    /// blob `abi.encode(publicValues, seal)` to proof.bin.
    Prove {
        input: Option<String>,
        #[arg(long)]
        groth16: bool,
        /// Output directory (default: `<repo root>/.trustgraph/trust-graph/`).
        #[arg(long)]
        out_dir: Option<String>,
    },
}

/// The default generated-output directory for this program.
const OUT_DIR: &str = "trust-graph";

pub fn run(cmd: Command) -> Result<()> {
    match cmd {
        Command::Vkey => common::print_vkey(elf()),
        Command::Paramshash { input, params } => {
            let p: Params = match params {
                Some(path) => serde_json::from_str(&std::fs::read_to_string(path)?)?,
                None => load_input(input.as_ref())?.params,
            };
            println!("0x{}", hex::encode(encode::params_hash(&p)));
            Ok(())
        }
        Command::Execute { input, out_dir } => {
            cmd_execute(load_input(input.as_ref())?, common::out_dir(out_dir.as_ref(), OUT_DIR)?)
        }
        Command::Prove { input, groth16, out_dir } => cmd_prove(
            load_input(input.as_ref())?,
            groth16,
            common::out_dir(out_dir.as_ref(), OUT_DIR)?,
        ),
    }
}

fn cmd_execute(input: GuestInput, out: std::path::PathBuf) -> Result<()> {
    let native = compute(&input);
    let native_pub = encode::journal_encoded(&native.journal);

    common::execute_and_check(elf(), &input, &native_pub)?;

    println!("journalDigest: 0x{}", hex::encode(encode::journal_digest(&native.journal)));
    println!("outputRoot:    0x{}", hex::encode(native.journal.output_root));
    println!("paramsHash:    0x{}", hex::encode(native.journal.params_hash));
    println!("ipfsHash:      0x{}", hex::encode(native.journal.ipfs_hash));
    println!("cid:           {}", native.cid);
    println!("totalValue:    {}", native.journal.total_value);
    println!("skippedDigest: 0x{}", hex::encode(native.journal.skipped_digest));
    // The two journal-v3 pass-throughs. `submitProof` takes `recipient` as an argument and folds
    // it into the digest, so a submitter must echo exactly what the guest committed; it is printed
    // here so the submit step never has to guess.
    println!("recipient:     0x{}", hex::encode(native.journal.recipient));
    println!("instanceDomain: 0x{}", hex::encode(native.journal.instance_domain));

    // The canonical score blob whose sha256 is `ipfsHash` and whose CID is `cid`. Write it out so it
    // can be pinned (the UI/indexer fetch the {account -> score} scores from IPFS at that cid).
    let p = common::write_out(&out, "blob.json", &native.blob)?;
    println!("wrote {} ({} bytes) — pin at the cid above", p.display(), native.blob.len());
    Ok(())
}

fn cmd_prove(input: GuestInput, groth16: bool, out: std::path::PathBuf) -> Result<()> {
    // The score blob is a pure function of the input; recompute it here so `prove` emits blob.json
    // next to proof.bin (same bytes execute writes — its sha256 is the journal's ipfsHash).
    let native = compute(&input);

    let (public_values, seal) = common::prove_and_verify(elf(), &input, groth16)?;

    let blob = common::abi_encode_two_bytes(&public_values, &seal);
    let proof_path = common::write_out(&out, "proof.bin", &blob)?;
    common::write_out(&out, "public_values.bin", &public_values)?;
    let blob_path = common::write_out(&out, "blob.json", &native.blob)?;
    println!(
        "wrote {} ({} blob bytes, {} seal bytes)",
        proof_path.display(),
        blob.len(),
        seal.len()
    );
    println!(
        "wrote {} ({} bytes) — pin at the cid for the UI",
        blob_path.display(),
        native.blob.len()
    );
    println!("publicValues: 0x{}", hex::encode(&public_values));
    Ok(())
}
