//! Host/prover for the isolated `trust-compose` mixed-source params/manifest SP1 program.

use anyhow::Result;
use clap::Subcommand;
use composition_core::{codec, compute::compute, fixture, GuestInput};
use sp1_sdk::{include_elf, Elf};

use crate::common;

pub fn elf() -> Elf {
    include_elf!("trustgraph-compose-program")
}

pub fn sample_input() -> GuestInput {
    fixture::mixed_input()
}

pub fn benchmark_input(source_count: usize, aggregate_entries: usize) -> GuestInput {
    fixture::benchmark_input(source_count, aggregate_entries)
}

pub fn parity_inputs() -> Vec<(&'static str, GuestInput)> {
    vec![
        ("mixed-standard-weighted", fixture::mixed_input()),
        ("source-reordered", fixture::reversed_mixed_input()),
        ("rotated-equal-weights", fixture::rotated_mixed_input()),
        ("representative-eight-source", fixture::benchmark_input(8, 1_024)),
    ]
}

fn load_input(path: Option<&String>) -> Result<GuestInput> {
    match path {
        Some(path) => Ok(serde_json::from_str(&std::fs::read_to_string(path)?)?),
        None => Ok(sample_input()),
    }
}

#[derive(Subcommand)]
pub enum Command {
    /// Print the V2 composition guest verification key (bytes32).
    Vkey,
    /// Print keccak256 of the frozen composition V2 params tuple.
    Paramshash { input: Option<String> },
    /// Execute the guest and byte-assert its journal against native computation.
    Execute {
        input: Option<String>,
        #[arg(long)]
        out_dir: Option<String>,
    },
    /// Prove and locally verify a mixed composition root.
    Prove {
        input: Option<String>,
        #[arg(long)]
        groth16: bool,
        #[arg(long)]
        out_dir: Option<String>,
    },
}

const OUT_DIR: &str = "trust-compose";

pub fn run(command: Command) -> Result<()> {
    match command {
        Command::Vkey => common::print_vkey(elf()),
        Command::Paramshash { input } => {
            let input = load_input(input.as_ref())?;
            println!("0x{}", hex::encode(codec::params_hash(&input.params)));
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

fn execute(input: GuestInput, out: std::path::PathBuf) -> Result<()> {
    let native = compute(&input)?;
    let public_values = codec::journal_encoded(&native.journal);
    let execution = common::execute_values_untraced(elf(), &input, &public_values)?;
    println!("guest cycles: {}", execution.cycles);
    println!("guest == native  ✓");
    println!("journalDigest: 0x{}", hex::encode(codec::journal_digest(&native.journal)));
    println!("outputRoot:    0x{}", hex::encode(native.journal.output_root));
    println!("paramsHash:    0x{}", hex::encode(native.journal.params_hash));
    println!("capture:       0x{}", hex::encode(native.journal.acc));
    println!("cid:           {}", native.cid);
    let blob_path = common::write_out(&out, "blob.json", &native.blob)?;
    let attribution_path = common::write_out(
        &out,
        "attribution.json",
        serde_json::to_vec_pretty(&native.source_allocations)?,
    )?;
    println!("wrote {} ({} bytes)", blob_path.display(), native.blob.len());
    println!("wrote {}", attribution_path.display());
    Ok(())
}

fn prove(input: GuestInput, groth16: bool, out: std::path::PathBuf) -> Result<()> {
    let native = compute(&input)?;
    let proof = common::prove_values(elf(), &input, groth16)?;
    anyhow::ensure!(
        proof.public_values == codec::journal_encoded(&native.journal),
        "proved journal differs from native computation"
    );
    let proof_path = common::write_out(&out, "proof.bin", proof.blob())?;
    common::write_out(&out, "public_values.bin", &proof.public_values)?;
    let blob_path = common::write_out(&out, "blob.json", &native.blob)?;
    let attribution_path = common::write_out(
        &out,
        "attribution.json",
        serde_json::to_vec_pretty(&native.source_allocations)?,
    )?;
    println!("vkey: {}", proof.vkey);
    println!("local verify ✓");
    println!("wrote {}", proof_path.display());
    println!("wrote {}", blob_path.display());
    println!("wrote {}", attribution_path.display());
    Ok(())
}
