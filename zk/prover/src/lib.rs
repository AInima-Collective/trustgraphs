//! The prover, as a library.
//!
//! Everything the CLI does is available here as a value-returning call. That exists for one
//! reason: before it, the only way for another program to get a root out of the prover was to
//! scrape stdout —
//!
//! ```text
//! OUTPUT_ROOT=$(awk '/^outputRoot:/{print $2}' <<<"$EXEC")
//! ```
//!
//! — which is what `taskfile/instances.sh` does, and which breaks silently the first time a log
//! line is reworded. `zk/operator` calls [`common::execute_values`] and [`common::prove_values`]
//! instead, and the CLI in `main.rs` is a thin printing wrapper over the same functions, so the
//! two can never drift.
//!
//! This crate lives in the detached `zk/` workspace because it carries the sp1-sdk dependency
//! graph. Everything that can be *wrong* about the proving loop — when to trigger, which
//! checkpoint to prove, when to hold — is deliberately NOT here; it is in
//! `packages/operator-core`, in the root workspace, where `cargo test --workspace` runs it.

pub mod common;
pub mod programs;
#[cfg(any(feature = "witness-atproto", feature = "witness-nostr"))]
pub mod witness;

pub use common::{Execution, Proof};
