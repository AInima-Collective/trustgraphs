//! `operator` — the daemon that keeps proven scores fresh without a human in the loop.
//!
//! See `docs/build/run-a-prover.md`. Structurally: this binary reads the chain, hands the facts to
//! `operator-core::plan`, and does what it is told. It contains no policy of its own.
mod chain;
mod config;
mod handlers;
mod ops;
mod run;
mod tx;

use anyhow::Result;
use clap::Parser;
use std::path::PathBuf;

#[derive(Parser)]
#[command(name = "operator", about = "Keep proven TrustGraph scores fresh, unattended")]
struct Cli {
    /// Path to the operator config (docs/build/run-a-prover.md §2).
    #[arg(long)]
    config: PathBuf,
    /// Run exactly one tick and exit. What CI and the e2e drive.
    #[arg(long)]
    once: bool,
    /// Decide and report, but never send a transaction or request a proof.
    #[arg(long)]
    dry_run: bool,
}

fn main() -> Result<()> {
    let cli = Cli::parse();
    let cfg = config::Config::load(&cli.config)?;
    run::run(cfg, cli.once, cli.dry_run)
}
