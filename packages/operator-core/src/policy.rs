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
    /// Refuse instances whose proof would exceed this. Must name the same boundary as the vault's
    /// top fee band; that agreement is a test, not a comment.
    pub cycle_limit: u64,
    /// Crude cycles-per-input used with `cycle_limit`. Measured, not guessed: the trust-graph
    /// guest runs ~1.83M cycles on the 3-edge golden fixture, and the M1 spike measured ~27.3k
    /// cycles per ecrecover.
    pub cycles_per_input: u64,
    pub base_cycles: u64,
    /// Programs this binary has a guest for.
    pub supported_programs: BTreeSet<Program>,
    pub loss_budget: LossBudget,
}

impl Default for Policy {
    fn default() -> Self {
        Self {
            curated: false,
            subsidy_min_blocks: 216_000,     // ~1 month at 12s blocks
            max_basefee_wei: 40_000_000_000, // 40 gwei
            confirmations: 12,
            cycle_limit: 1_000_000_000,
            cycles_per_input: 40_000,
            base_cycles: 2_000_000,
            supported_programs: BTreeSet::from([
                Program::TrustGraph,
                Program::Contributions,
                Program::Signer,
            ]),
            loss_budget: LossBudget::default(),
        }
    }
}

impl Policy {
    /// A curated policy for the hosted subsidy set.
    pub fn curated() -> Self {
        Self { curated: true, ..Self::default() }
    }
}
