//! What the operator is willing to do, as data.
//!
//! Split from [`crate::types`] because the state is what the chain says and the policy is what we
//! chose. Everything here has a default, so a missing config key is a recorded decision rather
//! than a stall.

use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;

use crate::types::Program;

/// Per-instance and global spend ceilings, in USD-cents to stay integral.
///
/// Preventable spend (a params mismatch, a pending rotation, an unfinalized checkpoint, an empty
/// vault, an oversized instance) is a hold or a skip *before* the request. This is for the rest:
/// a creator-admin can rotate config one block after any preflight, so some waste cannot be
/// prevented. When a budget is exceeded the instance HALTS and alerts. It is not retried, because
/// the failure mode of retrying an unexplained loss is a larger unexplained loss.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct LossBudget {
    pub per_instance_cents_per_day: u64,
    pub global_cents_per_day: u64,
}

impl Default for LossBudget {
    fn default() -> Self {
        Self { per_instance_cents_per_day: 2_500, global_cents_per_day: 25_000 }
    }
}

/// Rolling spend, supplied by the caller from the request journal.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Spend {
    pub instance_cents_today: u64,
    pub global_cents_today: u64,
}

impl LossBudget {
    pub fn exceeded_by(&self, spend: Spend) -> Option<BudgetBreach> {
        if spend.instance_cents_today >= self.per_instance_cents_per_day {
            Some(BudgetBreach::Instance {
                spent_cents: spend.instance_cents_today,
                cap_cents: self.per_instance_cents_per_day,
            })
        } else if spend.global_cents_today >= self.global_cents_per_day {
            Some(BudgetBreach::Global {
                spent_cents: spend.global_cents_today,
                cap_cents: self.global_cents_per_day,
            })
        } else {
            None
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BudgetBreach {
    Instance { spent_cents: u64, cap_cents: u64 },
    Global { spent_cents: u64, cap_cents: u64 },
}

/// How this operator run treats one instance.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Policy {
    /// Proven on us, via plain `submitProof`, never drawing a vault. This flag IS the free tier;
    /// there is no unconditional one. A permissionless factory plus an unconditional free tier is
    /// unbounded liability: an attacker pays ~1 attestation of gas per epoch to make us pay a
    /// ~600k-gas submit.
    pub curated: bool,
    /// Whether a vault must cover this instance before we prove it.
    ///
    /// This is a separate flag from `curated` because there are THREE states, not two, and
    /// collapsing them broke the one the GOAL calls out by name. A curated instance is proven on
    /// us. A funded instance draws a vault. And an operator run with `[paid]` off — a community
    /// self-proving with its own keys, which the hosted service is explicitly not supposed to gate
    /// — pays for everything itself and has no vault to consult. Overloading `curated` for that
    /// third case would also throttle a self-prover to our monthly subsidy cadence, which is our
    /// budget decision and none of their business.
    pub requires_vault: bool,
    /// How often we will pay for a curated instance. Distinct from the factory's creation floor
    /// (anti-spam) and from the vault's `minPaidIntervalBlocks` (the only enforceable one) — see
    /// `INSTANCE_FACTORY.md` §2.2 and `PROOF_SCHEDULER.md` §4.2, both corrected.
    pub subsidy_min_blocks: u64,
    /// Above this, hold. A root that lands six hours late still files at its input-freeze block,
    /// so waiting costs correctness nothing.
    pub max_basefee_wei: u128,
    /// Blocks before a checkpoint is safe to spend on. A reorg must not erase a checkpoint we
    /// already paid to prove.
    pub confirmations: u64,
    /// Refuse instances whose proof would exceed this.
    ///
    /// It must name the same boundary as the vault's top fee band, or one of two things is true:
    /// we price proofs we will not produce, or we produce proofs nobody will pay for. So it is
    /// DERIVED from [`MAX_PRICED_INPUTS`] rather than chosen, and both sides assert the boundary
    /// (`packages/operator-core/tests/decide.rs` and `test/unit/vault/ProvingVault.t.sol`).
    pub cycle_limit: u64,
    /// Crude cycles-per-input used with `cycle_limit`. See [`CYCLES_PER_INPUT`].
    pub cycles_per_input: u64,
    pub base_cycles: u64,
    /// Programs this binary has a guest for.
    pub supported_programs: BTreeSet<Program>,
    pub loss_budget: LossBudget,
}

/// The largest instance the operator will prove, in proof inputs (edges or anchors).
///
/// The SAME number as `ProvingVault.MAX_PRICED_INPUTS`. It lives in both places rather than being
/// read across the seam because the vault is on-chain and the operator is not; what makes them
/// agree is a test on each side, not a shared constant.
pub const MAX_PRICED_INPUTS: u64 = 200_000;

/// Measured, not guessed: the trust-graph guest runs ~1.83M cycles on the 3-edge golden fixture
/// (so the fixed cost dominates at small sizes), and the M1 atproto spike measured ~27.3k cycles
/// per ecrecover. 40k per input leaves headroom over that.
pub const CYCLES_PER_INPUT: u64 = 40_000;
pub const BASE_CYCLES: u64 = 2_000_000;

impl Default for Policy {
    fn default() -> Self {
        Self {
            curated: false,
            requires_vault: false,
            subsidy_min_blocks: 216_000,     // ~1 month at 12s blocks
            max_basefee_wei: 40_000_000_000, // 40 gwei
            confirmations: 12,
            cycle_limit: BASE_CYCLES + MAX_PRICED_INPUTS * CYCLES_PER_INPUT,
            cycles_per_input: CYCLES_PER_INPUT,
            base_cycles: BASE_CYCLES,
            supported_programs: BTreeSet::from([
                Program::Trustgraphs,
                Program::Contributions,
                Program::Signer,
            ]),
            loss_budget: LossBudget::default(),
        }
    }
}

impl Policy {
    /// A curated policy for the hosted subsidy set: proven on us, no vault.
    pub fn curated() -> Self {
        Self { curated: true, requires_vault: false, ..Self::default() }
    }

    /// A funded policy: not ours to subsidize, so a vault must cover it first.
    pub fn funded() -> Self {
        Self { curated: false, requires_vault: true, ..Self::default() }
    }
}
