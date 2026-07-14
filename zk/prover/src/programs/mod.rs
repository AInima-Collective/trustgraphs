//! One module per SP1 program. Each exposes a clap `Command` subcommand group and a `run` dispatcher;
//! the shared prove/execute/encode plumbing lives in [`crate::common`].

pub mod signer;
pub mod trust_graph;
