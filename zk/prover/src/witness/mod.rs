//! Host-side lane-2 (atproto) witness assembly — the `witness` subcommand group.
//!
//! This whole module is gated behind the `witness-atproto` cargo feature (default OFF) so the
//! network/DAG-CBOR/date dependency graph never lands in the lean `execute`/`prove` builds. Build
//! and run it with:
//!
//!   cargo build --release --features witness-atproto
//!   cargo run   --release --features witness-atproto -- \
//!       witness fetch --did did:plc:ewvi7nxzyoun6zhxrhs64oiz
//!
//! `fetch` materializes a self-contained, offline-reproducible bundle (archived CARs + PLC logs +
//! a manifest of head digests and content hashes) and, as a soundness self-check, re-verifies each
//! assembled witness with the very `envelopes` code the guest runs.

pub mod atproto;

use std::path::PathBuf;

use anyhow::Result;
use clap::Subcommand;

use atproto::{FetchConfig, DEFAULT_ARCHIVE_DIR, DEFAULT_PLC_URL, DEFAULT_RELAY_URL};

/// `witness` subcommands.
#[derive(Subcommand)]
pub enum Command {
    /// Fetch + archive the repo CAR and PLC audit log for each DID, write the bundle manifest, and
    /// print the head digests (the values the AnchorRegistry anchors). Reproducible offline after.
    Fetch {
        /// A registered DID to assemble (repeatable).
        #[arg(long = "did", required = true)]
        dids: Vec<String>,
        /// Relay/PDS entry URL for getRepo (302-redirects to the PDS host are followed).
        #[arg(long, default_value = DEFAULT_RELAY_URL)]
        relay_url: String,
        /// PLC directory (or mirror) base URL.
        #[arg(long, default_value = DEFAULT_PLC_URL)]
        plc_url: String,
        /// Archive/bundle root directory.
        #[arg(long, default_value = DEFAULT_ARCHIVE_DIR)]
        archive_dir: PathBuf,
        /// Skip the post-assembly `envelopes::verify` self-check (assembly only).
        #[arg(long)]
        no_verify: bool,
    },
}

pub fn run(cmd: Command) -> Result<()> {
    match cmd {
        Command::Fetch { dids, relay_url, plc_url, archive_dir, no_verify } => {
            let cfg = FetchConfig { relay_url, plc_url, archive_dir };
            let (manifest_path, bundle) = atproto::assemble(&dids, &cfg)?;

            println!("manifest: {}", manifest_path.display());
            for entry in &bundle.entries {
                println!();
                println!("did:          {}", entry.did);
                println!("rev:          {}", entry.rev);
                println!("head sha256:  {}", entry.head_sha256);
                println!("car:          {} ({})", entry.car_path, entry.car_sha256);
                println!("plc:          {} ({})", entry.plc_path, entry.plc_sha256);
                println!("source:       {} -> {}", entry.source.relay_url, entry.source.pds_url);

                if !no_verify {
                    let counts = atproto::self_check(&cfg.archive_dir, entry)?;
                    let total: usize = counts.iter().map(|(_, n)| *n).sum();
                    println!("verify:       envelopes::verify OK — {total} records across self-check collections");
                    for (c, n) in counts {
                        println!("                {c}: {n}");
                    }
                }
            }
            Ok(())
        }
    }
}
