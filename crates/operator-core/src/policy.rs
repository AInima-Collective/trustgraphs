//! What the operator is willing to do, as data.
//!
//! Split from [`crate::types`] because the state is what the chain says and the policy is what we
//! chose. Everything here has a default, so a missing config key is a recorded decision rather
//! than a stall.

use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;

use crate::types::Program;
use crate::work::CapabilityProfile;

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
    /// This is a separate flag from `curated` because there are THREE states, not two. A curated instance is proven on
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
    /// Operator-local cycle envelope. It is independent of the vault's fee bands: another prover
    /// may accept a checkpoint this host refuses.
    pub cycle_limit: u64,
    /// Operator-local prepared-work envelope. Like `cycle_limit`, this is host policy rather than
    /// a protocol or verification-key assertion.
    pub capability_profile: CapabilityProfile,
    /// Programs this binary has a guest for.
    pub supported_programs: BTreeSet<Program>,
    pub loss_budget: LossBudget,
}

/// The protocol/payment ceiling, in proof inputs (edges or anchors).
///
/// This is the SAME number as `InputCapacity.MAX_TOTAL_INPUTS` and
/// `ProvingVault.MAX_PRICED_INPUTS`. It is not this host's proving capacity: configurable
/// `Policy::capability_profile` and `Policy::cycle_limit` may refuse much earlier. It lives in
/// both languages because the on-chain constant cannot be imported into Rust; hand-written tests
/// pin the value on each side.
pub const MAX_PRICED_INPUTS: u64 = 200_000;

impl Default for Policy {
    fn default() -> Self {
        Self {
            curated: false,
            requires_vault: false,
            subsidy_min_blocks: 216_000,     // ~1 month at 12s blocks
            max_basefee_wei: 40_000_000_000, // 40 gwei
            confirmations: 12,
            cycle_limit: crate::work::OPERATOR_CYCLE_LIMIT,
            capability_profile: CapabilityProfile::default(),
            supported_programs: BTreeSet::from([
                Program::Trustgraphs,
                Program::Contributions,
                Program::Weighted,
                Program::Composition,
                Program::NostrWorkspace,
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn protocol_input_ceiling_stays_cross_language_pinned() {
        assert_eq!(MAX_PRICED_INPUTS, 200_000);
    }

    #[test]
    fn shipped_cycle_limit_is_unchanged_and_independent_of_protocol_ceiling() {
        let policy = Policy::default();
        assert_eq!(policy.cycle_limit, 8_000_000_000);
        assert_eq!(policy.capability_profile.max_raw_records, 1_800);
        assert_ne!(policy.cycle_limit, MAX_PRICED_INPUTS);
    }
}
