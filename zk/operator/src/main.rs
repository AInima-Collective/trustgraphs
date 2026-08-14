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
mod weighted;

use alloy_primitives::B256;
use anyhow::{Context, Result};
use clap::{Parser, Subcommand};
use std::path::PathBuf;

#[derive(Parser)]
#[command(name = "operator", about = "Keep proven trustgraphs scores fresh, unattended")]
struct Cli {
    /// Path to the operator config (docs/build/run-a-prover.md §2).
    #[arg(long, global = true)]
    config: Option<PathBuf>,
    /// Run exactly one tick and exit. What CI and the e2e drive.
    #[arg(long)]
    once: bool,
    /// Decide and report, but never send a transaction or request a proof.
    #[arg(long)]
    dry_run: bool,
    #[command(subcommand)]
    command: Option<Command>,
}

#[derive(Subcommand)]
enum Command {
    /// Reconstruct and republish an already-landed checkpoint's canonical score blob.
    Republish {
        /// Registry instance id (0x-prefixed bytes32).
        #[arg(long)]
        instance: String,
        /// Accumulator checkpoint id whose landed state should be repaired.
        #[arg(long)]
        checkpoint: u64,
    },
}

fn main() -> Result<()> {
    let cli = Cli::parse();
    let config_path = cli.config.context("--config is required")?;
    let cfg = config::Config::load(&config_path)?;
    match cli.command {
        Some(Command::Republish { instance, checkpoint }) => {
            let id = instance.parse::<B256>().with_context(|| {
                format!("invalid --instance {instance:?}; expected bytes32 hex")
            })?;
            run::republish(cfg, id, checkpoint)
        }
        None => run::run(cfg, cli.once, cli.dry_run),
    }
}

#[cfg(test)]
mod cli_tests {
    use super::{Cli, Command};
    use clap::Parser;
    use std::path::PathBuf;

    #[test]
    fn one_global_config_argument_serves_the_republish_subcommand() {
        let cli = Cli::try_parse_from([
            "operator",
            "--config",
            "operator.toml",
            "republish",
            "--instance",
            "0x1111111111111111111111111111111111111111111111111111111111111111",
            "--checkpoint",
            "42",
        ])
        .unwrap();
        assert_eq!(cli.config.unwrap(), PathBuf::from("operator.toml"));
        assert!(matches!(cli.command, Some(Command::Republish { checkpoint: 42, .. })));
    }
}
