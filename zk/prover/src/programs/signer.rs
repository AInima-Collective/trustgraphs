//! Signer-sync program: proves the selected Safe signer set (top-N by proven PageRank score) and its
//! threshold, for `SignerSyncZkModule`.

use alloy_primitives::{B256, U256};
use anyhow::Result;
use clap::Subcommand;
use pagerank_core::{
    encode,
    signer::{compute_signers, fold_activity},
    ActivityCheckpoint, SelectionParams, SignerActivity, SignerInput,
};
use sp1_sdk::{include_elf, Elf};

use crate::common;
use crate::programs::trust_graph::sample_input;

/// The signer-sync guest ELF (second bin of the program crate).
/// This program's guest ELF, for callers that drive the prover as a library (`zk/operator`).
/// The vkey it derives is the one the deployed `SignerSyncZkModule`'s verifier must be pinned to.
pub fn elf() -> Elf {
    load_signer_elf()
}

fn load_signer_elf() -> Elf {
    include_elf!("trustgraph-signer-program")
}

/// The built-in signer sample (same edges/params as the root sample + two authenticated direct
/// votes and the production selection/liveness floors).
/// The zero `instance_domain` is fine for local execute/vkey smoke tests but no deployed module
/// will accept a proof of it — real inputs come from `input-exporter --signer --module <addr>`,
/// which derives the domain from the module address + chain id (audit M-3).
pub fn sample_signer_input() -> SignerInput {
    let g = sample_input();
    let scored = trustgraph_core::compute::compute(&g).scores;
    let current_signer = scored[0].0;
    let activity = vec![
        SignerActivity { account: scored[0].0, proposal_id: U256::from(1), block_number: 100 },
        SignerActivity { account: scored[1].0, proposal_id: U256::from(2), block_number: 101 },
    ];
    let activity_acc = activity
        .iter()
        .enumerate()
        .fold(B256::ZERO, |acc, (index, record)| fold_activity(acc, (index + 1) as u64, record));
    SignerInput {
        edges: g.edges,
        params: g.params,
        selection: SelectionParams {
            top_n: 3,
            min_threshold: 2,
            target_threshold_bps: 5000,
            max_inactive_blocks: 151_200,
            min_activity_witnesses: 2,
        },
        activity,
        activity_checkpoint: ActivityCheckpoint { acc: activity_acc, count: 2, block_number: 101 },
        activity_checkpoint_id: 1,
        current_signers: vec![current_signer],
        current_threshold: U256::from(1u8),
        was_initialized: false,
        instance_domain: Default::default(),
    }
}

fn load_signer_input(path: Option<&String>) -> Result<SignerInput> {
    match path {
        Some(p) => Ok(serde_json::from_str(&std::fs::read_to_string(p)?)?),
        None => Ok(sample_signer_input()),
    }
}

/// `signer` subcommands. `input.json` is a serialized `pagerank_core::SignerInput`; omit it to use
/// the built-in sample.
#[derive(Subcommand)]
pub enum Command {
    /// Print the signer guest program verification key (bytes32) for deployment.
    Vkey,
    /// Print keccak256 of the canonical selection params.
    Selectionparamshash { input: Option<String> },
    /// Run the signer guest via the SP1 executor and assert it matches native (no proof).
    Execute { input: Option<String> },
    /// Generate a proof (core, or Groth16-wrapped), verify it locally, and write the on-chain proof
    /// blob to signer_proof.bin.
    Prove {
        input: Option<String>,
        #[arg(long)]
        groth16: bool,
        /// Output directory (default: `<repo root>/.trustgraph/signer-sync/`).
        #[arg(long)]
        out_dir: Option<String>,
    },
}

/// The default generated-output directory for this program.
const OUT_DIR: &str = "signer-sync";

pub fn run(cmd: Command) -> Result<()> {
    match cmd {
        Command::Vkey => common::print_vkey(load_signer_elf()),
        Command::Selectionparamshash { input } => {
            let input = load_signer_input(input.as_ref())?;
            println!("0x{}", hex::encode(encode::selection_params_hash(&input.selection)));
            Ok(())
        }
        Command::Execute { input } => cmd_signer_execute(load_signer_input(input.as_ref())?),
        Command::Prove { input, groth16, out_dir } => cmd_signer_prove(
            load_signer_input(input.as_ref())?,
            groth16,
            common::out_dir(out_dir.as_ref(), OUT_DIR)?,
        ),
    }
}

fn cmd_signer_execute(input: SignerInput) -> Result<()> {
    let native = compute_signers(&input);
    let native_pub = encode::signer_journal_encoded(&native.journal);

    common::execute_and_check(load_signer_elf(), &input, &native_pub)?;

    println!(
        "signerJournalDigest: 0x{}",
        hex::encode(encode::signer_journal_digest(&native.journal))
    );
    println!("signerSetRoot:       0x{}", hex::encode(native.journal.signer_set_root));
    println!("paramsHash:          0x{}", hex::encode(native.journal.params_hash));
    println!("selectionParamsHash: 0x{}", hex::encode(native.journal.selection_params_hash));
    println!("targetThreshold:     {}", native.journal.target_threshold);
    println!("instanceDomain:      0x{}", hex::encode(native.journal.instance_domain));
    println!("signers ({}):", native.signers.len());
    for s in &native.signers {
        println!("  0x{}", hex::encode(s));
    }
    Ok(())
}

fn cmd_signer_prove(input: SignerInput, groth16: bool, out: std::path::PathBuf) -> Result<()> {
    let (public_values, seal) = common::prove_and_verify(load_signer_elf(), &input, groth16)?;

    let blob = common::abi_encode_two_bytes(&public_values, &seal);
    let proof_path = common::write_out(&out, "signer_proof.bin", &blob)?;
    common::write_out(&out, "signer_public_values.bin", &public_values)?;
    println!(
        "wrote {} ({} blob bytes, {} seal bytes)",
        proof_path.display(),
        blob.len(),
        seal.len()
    );
    println!("publicValues: 0x{}", hex::encode(&public_values));
    Ok(())
}
