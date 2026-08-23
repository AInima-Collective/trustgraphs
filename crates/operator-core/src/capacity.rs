//! Operator-local capacity telemetry.
//!
//! Admission and alerting must use the same configured policy. The protocol/payment ceiling is a
//! separate on-chain fact, represented by the instance's global-or-lower immutable ingress cap.

use crate::policy::Policy;
use crate::types::{InstanceSize, InstanceState};
use crate::work::{CapabilityDimension, WorkProfile};
use serde::Serialize;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CapacityCeiling {
    Capability(CapabilityDimension),
    CycleLimit,
    InputCapacity,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CapacityUsage {
    pub ceiling: CapacityCeiling,
    pub observed: u64,
    pub limit: u64,
    pub input_work: u64,
    pub profile_version: u16,
}

impl CapacityUsage {
    pub fn percent(self) -> u64 {
        let percent = u128::from(self.observed) * 100 / u128::from(self.limit.max(1));
        u64::try_from(percent).unwrap_or(u64::MAX)
    }

    pub fn approaching(self) -> bool {
        u128::from(self.observed) * 5 >= u128::from(self.limit) * 4
    }
}

/// The nearest irreversible-input ceiling under this host's actual configured policy.
pub fn limiting_capacity(state: &InstanceState, policy: &Policy) -> CapacityUsage {
    let live_anchor_work = state.live_input_work.saturating_sub(state.live_commitments.leaf_count);
    let live_size = InstanceSize {
        leaf_count: state.live_commitments.leaf_count,
        anchor_count: live_anchor_work,
        max_iterations: state.size.max_iterations,
        seed_count: state.size.seed_count,
        authenticated_cycles: None,
    };
    let work = WorkProfile::from_raw_bounds(state.program, live_size);
    let capability = policy.capability_profile.limiting_ingress_dimension(work);
    let mut limiting = CapacityUsage {
        ceiling: CapacityCeiling::Capability(capability.dimension),
        observed: capability.observed,
        limit: capability.limit.max(1),
        input_work: state.live_input_work,
        profile_version: capability.profile_version,
    };

    let cycle = CapacityUsage {
        ceiling: CapacityCeiling::CycleLimit,
        observed: work.estimate().total,
        limit: policy.cycle_limit.max(1),
        input_work: state.live_input_work,
        profile_version: capability.profile_version,
    };
    if more_consumed(cycle, limiting) {
        limiting = cycle;
    }

    let input = CapacityUsage {
        ceiling: CapacityCeiling::InputCapacity,
        observed: state.live_input_work,
        limit: state.input_capacity.max(1),
        input_work: state.live_input_work,
        profile_version: capability.profile_version,
    };
    if more_consumed(input, limiting) {
        limiting = input;
    }
    limiting
}

fn more_consumed(candidate: CapacityUsage, current: CapacityUsage) -> bool {
    u128::from(candidate.observed) * u128::from(current.limit)
        > u128::from(current.observed) * u128::from(candidate.limit)
}
