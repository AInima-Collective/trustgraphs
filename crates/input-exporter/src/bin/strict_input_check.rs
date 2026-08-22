//! Read-only native execution gate for an exported strict Trustgraphs input.
//!
//! The SP1 guest calls the same `trustgraph_core::compute` function. This small host binary keeps
//! the local e2e fast while still proving that omission or corruption of lane 2 aborts before a
//! prover request is made.

use anyhow::{bail, Context, Result};
use clap::Parser;
use std::path::PathBuf;

#[derive(Parser, Debug)]
#[command(name = "strict-input-check")]
struct Args {
    #[arg(long)]
    input: PathBuf,
    /// Optional exact canonical score blob, for local mock-verifier publication/submission tests.
    #[arg(long)]
    score_blob: Option<PathBuf>,
}

fn main() -> Result<()> {
    let args = Args::parse();
    let input: trustgraph_core::GuestInput = serde_json::from_slice(
        &std::fs::read(&args.input)
            .with_context(|| format!("read exported input {}", args.input.display()))?,
    )
    .with_context(|| format!("decode exported input {}", args.input.display()))?;
    let result = std::panic::catch_unwind(|| trustgraph_core::compute::compute(&input));
    let Ok(result) = result else {
        bail!("strict input execution aborted (invalid, unavailable, or omitted lane witness)");
    };
    println!("anchorAcc: {:#x}", result.journal.anchor_acc);
    println!("anchorCount: {}", result.journal.anchor_count);
    println!("outputRoot: {:#x}", result.journal.output_root);
    println!("ipfsHash: {:#x}", result.journal.ipfs_hash);
    println!("cid: {}", result.cid);
    println!("totalValue: {}", result.journal.total_value);
    println!("skippedDigest: {:#x}", result.journal.skipped_digest);
    if let Some(path) = args.score_blob {
        std::fs::write(&path, &result.blob)
            .with_context(|| format!("write canonical score blob {}", path.display()))?;
    }
    Ok(())
}
