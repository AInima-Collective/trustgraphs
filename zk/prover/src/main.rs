//! Trustgraphs prover host.
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
//!   trustgraph-prover contributions {vkey|paramshash|fetch|execute|prove}
//!                                                         the contributions program (fetch needs
//!                                                         `--features fetch`)
//!   trustgraph-prover trust-graph-weighted {vkey|paramshash|execute|prove}
//!   trustgraph-prover trust-compose {vkey|paramshash|execute|prove}
//!   trustgraph-prover trust-compose-v2 {vkey|paramshash|execute|prove}
//!   trustgraph-prover manifest [--commit SHA] [--tag vX.Y.Z]
//!                                                         every program's ELF sha256 + vkey, JSON
//!
//! For `trust-graph`, `input.json` is a serialized `trustgraph_core::GuestInput`; for `signer` it is a
//! `pagerank_core::SignerInput`; for `trust-graph-weighted`, `trust-compose`, and `contributions`
//! it is their core crate's `GuestInput`. Omit it to use the relevant built-in golden sample.

use anyhow::Result;
use clap::{Args, Parser, Subcommand};
#[cfg(any(feature = "witness-atproto", feature = "witness-nostr"))]
use trustgraph_prover::witness;
use trustgraph_prover::{common, programs};

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
    Trustgraphs {
        #[command(subcommand)]
        cmd: programs::trust_graph::Command,
    },
    /// Weighted-prior trust-graph root producer (persistent personalized teleport prior).
    #[command(name = "trust-graph-weighted")]
    Weighted {
        #[command(subcommand)]
        cmd: programs::weighted::Command,
    },
    /// Normalized final-distribution composition over captured complete source outputs.
    #[command(name = "trust-compose")]
    Composition {
        #[command(subcommand)]
        cmd: programs::composition::Command,
    },
    /// Mixed standard/weighted composition (params/manifest V2, closed compatibility class).
    #[command(name = "trust-compose-v2")]
    CompositionV2 {
        #[command(subcommand)]
        cmd: programs::composition_v2::Command,
    },
    /// Signer-sync (top-N Safe signer set + threshold from the proven scores).
    Signer {
        #[command(subcommand)]
        cmd: programs::signer::Command,
    },
    /// Hypercerts root producer (lane-2-only: atproto repo graph -> journal-v2 merkle root).
    Hypercerts {
        #[command(subcommand)]
        cmd: programs::hypercerts::Command,
    },
    /// Buzz/Nostr workspace root producer (mixed relay-audit and self-log envelope-2 inputs).
    #[command(name = "nostr-workspace")]
    NostrWorkspace {
        #[command(subcommand)]
        cmd: programs::nostr_workspace::Command,
    },
    /// Contributions root producer (rep-weighted funding split over EAS contribution
    /// claims/responses/valuations -> journal-v2 merkle root).
    Contributions {
        #[command(subcommand)]
        cmd: programs::contributions::Command,
    },
    /// Envelope-1 (atproto) conformance harness: run the guest over a CAR + PLC witness and
    /// byte-assert guest == native (M3 exit; not a production program).
    #[command(name = "atproto-conformance")]
    AtprotoConformance {
        #[command(subcommand)]
        cmd: programs::atproto_conformance::Command,
    },
    /// Host-side lane-2 (atproto) witness assembly: fetch + archive repo CARs and PLC logs into an
    /// offline-reproducible bundle. Requires `--features witness-atproto`.
    #[cfg(feature = "witness-atproto")]
    Witness {
        #[command(subcommand)]
        cmd: witness::Command,
    },
    /// Buzz/Nostr inspection, immutable export, anchoring, and offline checkpoint assembly.
    /// Requires `--features witness-nostr`.
    #[command(name = "nostr-witness")]
    #[cfg(feature = "witness-nostr")]
    NostrWitness {
        #[command(subcommand)]
        cmd: witness::nostr::Command,
    },
    /// Every program's ELF sha256 and vkey, as JSON, for the build this binary was compiled from.
    ///
    /// This is the reproducible-build artifact `research/UPGRADE_GOVERNANCE.md` promises: the
    /// table anyone can check a deployed vkey against, from source, without trusting whoever
    /// deployed it. The release workflow publishes it and then re-derives it INSIDE the published
    /// image, so the table and the image cannot describe different builds.
    Manifest(ManifestArgs),
}

#[derive(Args)]
struct ManifestArgs {
    /// Source commit this build came from. Recorded verbatim; nothing here verifies it.
    #[arg(long)]
    commit: Option<String>,
    /// Release tag, when the table is being cut for one.
    #[arg(long)]
    tag: Option<String>,
}

fn manifest(args: &ManifestArgs) -> Result<()> {
    let mut programs = Vec::new();
    for (name, elf) in programs::all() {
        let elf_sha256 = common::elf_sha256(&elf);
        let vkey = common::vkey(elf)?;
        programs.push(serde_json::json!({
            "program": name,
            "elf_sha256": elf_sha256,
            "vkey": vkey,
        }));
    }
    let doc = serde_json::json!({
        "version": 1,
        "commit": args.commit,
        "tag": args.tag,
        "sp1": sp1_sdk::SP1_CIRCUIT_VERSION,
        "programs": programs,
    });
    println!("{}", serde_json::to_string_pretty(&doc)?);
    Ok(())
}

fn main() -> Result<()> {
    sp1_sdk::utils::setup_logger();
    let cli = Cli::parse();
    match cli.program {
        Program::Trustgraphs { cmd } => programs::trust_graph::run(cmd),
        Program::Weighted { cmd } => programs::weighted::run(cmd),
        Program::Composition { cmd } => programs::composition::run(cmd),
        Program::CompositionV2 { cmd } => programs::composition_v2::run(cmd),
        Program::Signer { cmd } => programs::signer::run(cmd),
        Program::Hypercerts { cmd } => programs::hypercerts::run(cmd),
        Program::NostrWorkspace { cmd } => programs::nostr_workspace::run(cmd),
        Program::Contributions { cmd } => programs::contributions::run(cmd),
        Program::AtprotoConformance { cmd } => programs::atproto_conformance::run(cmd),
        #[cfg(feature = "witness-atproto")]
        Program::Witness { cmd } => witness::run(cmd),
        #[cfg(feature = "witness-nostr")]
        Program::NostrWitness { cmd } => witness::nostr::run(cmd),
        Program::Manifest(args) => manifest(&args),
    }
}
