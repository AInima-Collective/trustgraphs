//! One module per SP1 program. Each exposes a clap `Command` subcommand group and a `run` dispatcher;
//! the shared prove/execute/encode plumbing lives in [`crate::common`].

pub mod atproto_conformance;
pub mod composition;
pub mod composition_v2;
pub mod contributions;
pub mod hypercerts;
pub mod nostr_workspace;
pub mod signer;
pub mod trust_graph;
pub mod weighted;

/// Every production program, in a stable order, with the ELF it is compiled from.
///
/// The order is the release manifest's order and must not depend on a hash map, a directory
/// listing, or anything else that can differ between two machines producing the same table.
pub fn all() -> Vec<(&'static str, sp1_sdk::Elf)> {
    vec![
        ("trust-graph", trust_graph::elf()),
        ("trust-graph-weighted", weighted::elf()),
        ("trust-compose", composition::elf()),
        ("trust-compose-v2", composition_v2::elf()),
        ("signer-sync", signer::elf()),
        ("contributions", contributions::elf()),
        ("hypercerts", hypercerts::elf()),
        ("nostr-workspace", nostr_workspace::elf()),
    ]
}
