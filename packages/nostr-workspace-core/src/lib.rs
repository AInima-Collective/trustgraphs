//! Consensus core for the `nostr-workspace` program.
//!
//! The crate is guest-safe: integer-only, BTree-backed, deterministic, and shared verbatim by
//! native tests, the SP1 guest, and golden-vector exporters.

pub mod binding;
pub mod compute;
pub mod params;
pub mod semantics;

pub use compute::{compute, ComputeError, ComputeResult, GuestInput, HeadWitness};
pub use params::{
    output_domain, params_encoded, params_hash, program_id, seed_set_root, Params, ParamsError,
};
