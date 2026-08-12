//! contributions-core — the contributions program's semantics: EAS contribution
//! claims/responses/valuations → a rep-weighted funding split
//! (`research/CONTRIBUTION_FUNDING.md` §2–§6), Params/Journal, and every byte encoding this
//! program owns. Single source of truth for the contributions SP1 guest, the host, and the TS
//! view — same discipline as `pagerank-core`: NO floats, BTree-only iteration, deterministic
//! everything.
//!
//! Interface contract: `docs/build/contributions/interfaces.md` (FROZEN). Golden vectors:
//! `test/golden/contributions.json` (Rust ⟷ Solidity ⟷ guest ⟷ TS four-way parity).
//!
//! Stage-1 reputation is `pagerank-core`'s algorithm, imported — never forked. This crate owns
//! only the contribution record decoding, the stage-2 aggregation, and the program's params
//! encoding. The journal is v2, reused unmodified from `pagerank-core`.

use alloy_primitives::{Address, B256, U256};
use serde::{Deserialize, Serialize};

pub mod compute;
pub mod kind;
pub mod params;
pub mod reconcile;
pub mod records;
pub mod testutil;

// Re-export the shared primitives every consumer needs alongside this crate.
pub use pagerank_core::{encode, Journal};
pub use zk_core::{cid, fixed, fold, merkle};

/// Governance-pinned parameters for one contributions round. All `*_fp` fields are scaled by
/// `precision_scale` (1e18). The exact 21-word ABI tuple that hashes to `paramsHash` is frozen
/// in [`params::params_hash`] (INTERFACES.md §3).
///
/// Slots 1–11 mirror the trust program's reputation params (the guest re-runs the exact
/// `pagerank-core` algorithm over the trust accumulator's edges); the rest are the round params.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Params {
    // --- stage-1 reputation (mirror of the trust program) ---
    pub damping_fp: U256,
    pub tolerance_fp: U256,
    pub max_iterations: u32,
    pub min_weight_fp: U256,
    pub max_weight_fp: U256,
    pub trust_multiplier_fp: U256,
    pub trust_share_fp: U256,
    pub trust_decay_fp: U256,
    /// Trusted seed addresses. `seedSetRoot` is computed over the *sorted* set.
    pub trusted_seeds: Vec<Address>,
    /// Internal fixed-point scale S (1e18).
    pub precision_scale: U256,
    /// ABI head-slot index of the confidence field in vouch attestation `data` (currently 1).
    pub weight_field_index: u32,
    // --- contributions round ---
    /// Claims count only if `block_timestamp ∈ [round_start, round_end]` (inclusive).
    pub round_start: u64,
    pub round_end: u64,
    /// Consent multiplier for contributor shares with no response (default 0.5 · S).
    pub unaccepted_mult_fp: U256,
    /// Same-round co-claim rater discount (default 0.5 · S; 0 = hard exclusion).
    pub collaborator_mult_fp: U256,
    /// Raters with rep below this are ignored (and earn no carve-out).
    pub min_rater_rep_fp: U256,
    /// Evaluator carve-out β in basis points (default 100 = 1%; 0 disables).
    pub evaluator_carveout_bps: u32,
    /// The distribution scale fed to `distribute_points_generic`.
    pub total_pool: U256,
    /// Bind the fold kind tags (INTERFACES.md §2) to concrete schemas inside the proven statement.
    pub claim_schema_uid: B256,
    pub response_schema_uid: B256,
    pub valuation_schema_uid: B256,
}

impl Params {
    /// The fixed-point scale S.
    pub fn scale(&self) -> U256 {
        self.precision_scale
    }
}
