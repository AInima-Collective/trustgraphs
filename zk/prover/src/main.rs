//! TrustGraph prover host.
//!
//! Programs are grouped as clap subcommands, one group per SP1 program:
//!
//!   trustgraph-prover trust-graph vkey                    print the guest vkey (bytes32)
//!   trustgraph-prover trust-graph paramshash [input.json] keccak256 of the canonical params
//!   trustgraph-prover trust-graph execute    [input.json] executor-run + guest-vs-native assert
//!   trustgraph-prover trust-graph prove      [input.json] [--groth16]
//!                                                         proof + local verify + on-chain blob
//!   trustgraph-prover signer vkey                         print the signer guest vkey (bytes32)
//!   trustgraph-prover signer selectionparamshash [input.json]
//!                                                         keccak256 of the canonical selection params
//!   trustgraph-prover signer execute    [input.json]      executor-run + guest-vs-native assert
//!   trustgraph-prover signer prove      [input.json] [--groth16]
//!
//! For `trust-graph`, `input.json` is a serialized `pagerank_core::GuestInput`; for `signer` it is a
//! `pagerank_core::SignerInput`. Omit it to use the built-in sample (identical to
//! test/golden/trust-graph.json).

mod common;
mod programs;

use anyhow::Result;
use clap::{Parser, Subcommand};

#[derive(Parser)]
#[command(name = "trustgraph-prover")]
struct Cli {
    #[command(subcommand)]
    program: Program,
}

#[derive(Subcommand)]
enum Program {
    /// Trust-graph root producer (fixed-point Trust-Aware PageRank -> merkle root).
    #[command(name = "trust-graph")]
    TrustGraph {
        #[command(subcommand)]
        cmd: programs::trust_graph::Command,
    },
    /// Signer-sync (top-N Safe signer set + threshold from the proven scores).
    Signer {
        #[command(subcommand)]
        cmd: programs::signer::Command,
    },
}

fn main() -> Result<()> {
    sp1_sdk::utils::setup_logger();
    let cli = Cli::parse();
    match cli.program {
        Program::TrustGraph { cmd } => programs::trust_graph::run(cmd),
        Program::Signer { cmd } => programs::signer::run(cmd),
    }
}
