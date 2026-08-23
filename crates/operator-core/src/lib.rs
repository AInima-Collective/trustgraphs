//! The proof operator's decision engine.
//!
//! A daemon watches the chain and keeps proven scores fresh without a human in the loop: it
//! freezes checkpoints on the contract-fixed cadence, proves them, and lands them. This crate is
//! everything about that loop that can be *wrong* — when to trigger, which checkpoint to prove,
//! when to hold, when to claim — with no sp1-sdk, no keys, and no sends.
//!
//! The split is deliberate. The root workspace's CI runs `cargo test --workspace`, so every branch
//! here is exercised on every commit; the detached `zk/` workspace (which carries the sp1-sdk
//! dependency graph) holds only the thin adapter that turns an [`Action`] into a network call.
//! When the question is "would it have paid twice?", the answer is in [`decide`] and [`journal`],
//! not in the daemon.
//!
//! ```text
//!   catalog::scan ──► InstanceState ──► decide::plan ──► Action
//!        ▲                 ▲                                │
//!    manifest          finality                        guard (re-read)
//!                                                           │
//!                                                       journal (fsync)
//! ```
//!
//! Design: [`research/PROOF_SCHEDULER.md`](../../../research/PROOF_SCHEDULER.md) §2 (operator),
//! §5 (failure semantics). Operation: [`docs/build/run-a-prover.md`](../../../docs/build/run-a-prover.md).

pub mod capacity;
pub mod catalog;
pub mod decide;
pub mod finality;
pub mod guard;
pub mod journal;
pub mod manifest;
pub mod policy;
pub mod types;
pub mod weighted_manifest;
pub mod work;

pub use capacity::{limiting_capacity, CapacityCeiling, CapacityUsage};
pub use decide::plan;
pub use journal::SubmitFailureClass;
pub use policy::{LossBudget, Policy, Spend};
pub use types::{
    Action, AvailabilityStage, CheckpointRef, Commitments, HoldReason, IdleReason, InFlight,
    InFlightState, InstanceSize, InstanceState, Program, SkipReason, VaultView,
};
pub use work::{CapabilityProfile, CostEstimate, WorkProfile};
