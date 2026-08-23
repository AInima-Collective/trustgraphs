//! Versioned operator-local proving capability and the M1 full-guest cost model.
//!
//! These limits are not consensus rules. A checkpoint this operator refuses remains valid and
//! another prover with a larger capability envelope may accept it.

use crate::types::{InstanceSize, Program};
use serde::{Deserialize, Serialize};

pub const COST_MODEL_VERSION: u16 = 1;
pub const CAPABILITY_PROFILE_VERSION: u16 = 2;
pub const OPERATOR_CYCLE_LIMIT: u64 = 8_000_000_000;

/// Largest fully calibrated raw/live-record row in the published SP1 v6.3.1 matrix.
pub const DEFAULT_MAX_RAW_RECORDS: u64 = 1_800;
/// Stage-1 must admit the calibrated row before reconstruction: two endpoints per raw record.
pub const DEFAULT_MAX_UNIQUE_NODES: u64 = DEFAULT_MAX_RAW_RECORDS * 2;
/// Independent memory-safety ceiling. The published matrix does not establish a byte maximum.
pub const DEFAULT_MAX_WITNESS_BYTES: u64 = 128 * 1024 * 1024;

fn default_profile_version() -> u16 {
    CAPABILITY_PROFILE_VERSION
}

fn default_max_raw_records() -> u64 {
    DEFAULT_MAX_RAW_RECORDS
}

fn default_max_unique_nodes() -> u64 {
    DEFAULT_MAX_UNIQUE_NODES
}

fn default_max_witness_bytes() -> u64 {
    DEFAULT_MAX_WITNESS_BYTES
}

fn default_max_iterations() -> u64 {
    100
}

/// Authenticated work shape known after input reconstruction and native execution.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkProfile {
    pub version: u16,
    pub program: Program,
    pub raw_records: u64,
    pub live_edges: u64,
    pub unique_nodes: u64,
    pub max_out_degree: u64,
    pub witness_bytes: u64,
    pub lane2_anchors: u64,
    pub signature_checks: u64,
    pub max_iterations: u32,
    pub iterations_run: u32,
    pub output_leaves: u64,
    /// Program-authenticated conservative cycle bound (currently composition and Nostr).
    pub authenticated_cycle_bound: Option<u64>,
}

impl Default for WorkProfile {
    fn default() -> Self {
        Self {
            version: COST_MODEL_VERSION,
            program: Program::Trustgraphs,
            raw_records: 0,
            live_edges: 0,
            unique_nodes: 0,
            max_out_degree: 0,
            witness_bytes: 0,
            lane2_anchors: 0,
            signature_checks: 0,
            max_iterations: 0,
            iterations_run: 0,
            output_leaves: 0,
            authenticated_cycle_bound: None,
        }
    }
}

impl WorkProfile {
    /// Stage 2: exact graph and loop shape retained by the native computation of a prepared
    /// input. Keeping this constructor in the policy crate prevents the operator and calibration
    /// benchmark from silently assigning rank telemetry to different cost terms.
    pub fn ranked(
        program: Program,
        raw_records: u64,
        witness_bytes: u64,
        lane2_anchors: u64,
        signature_checks: u64,
        output_leaves: u64,
        rank: pagerank_core::RankTelemetry,
    ) -> Self {
        Self {
            version: COST_MODEL_VERSION,
            program,
            raw_records,
            live_edges: rank.live_edges,
            unique_nodes: rank.unique_nodes,
            max_out_degree: rank.max_out_degree,
            witness_bytes,
            lane2_anchors,
            signature_checks,
            max_iterations: rank.max_iterations,
            iterations_run: rank.iterations_run,
            output_leaves,
            authenticated_cycle_bound: None,
        }
    }

    /// Stage 1: bounds available from checkpoint counts and governance-pinned parameters, before
    /// downloading or decoding the complete witness.
    pub fn from_raw_bounds(program: Program, size: InstanceSize) -> Self {
        let raw_records = size.leaf_count.saturating_add(size.anchor_count);
        let live_edges = raw_records;
        let unique_nodes = raw_records.saturating_mul(2).saturating_add(size.seed_count);
        Self {
            version: COST_MODEL_VERSION,
            program,
            raw_records,
            live_edges,
            unique_nodes,
            max_out_degree: live_edges,
            witness_bytes: 0,
            lane2_anchors: size.anchor_count,
            signature_checks: size.anchor_count,
            max_iterations: size.max_iterations,
            // The cheap gate must price the worst allowed loop count; the prepared gate replaces
            // this with the exact deterministic count learned by native execution.
            iterations_run: size.max_iterations,
            output_leaves: unique_nodes,
            authenticated_cycle_bound: size.authenticated_cycles,
        }
    }

    pub fn estimate(self) -> CostEstimate {
        if let Some(total) = self.authenticated_cycle_bound {
            return CostEstimate {
                version: COST_MODEL_VERSION,
                authenticated: total,
                total,
                ..CostEstimate::default()
            };
        }

        let base = match self.program {
            Program::Trustgraphs | Program::Signer => 3_000_000,
            Program::Contributions => 4_000_000,
            Program::Hypercerts | Program::NostrWorkspace => 5_000_000,
            Program::Weighted => 3_000_000,
            Program::Composition => 5_000_000,
        };
        let decode_authenticate = sat(u128::from(self.witness_bytes) * 64
            + u128::from(self.raw_records) * 8_000
            + u128::from(self.signature_checks) * 75_000);
        let reconcile = sat(u128::from(self.raw_records)
            * u128::from(ceil_log2(self.raw_records.max(2)))
            * 2_000);
        let graph_build = sat((u128::from(self.unique_nodes) + u128::from(self.live_edges))
            * 4_000
            + u128::from(self.max_out_degree) * 2_000);
        let rank = sat(u128::from(self.iterations_run)
            * (u128::from(self.unique_nodes) * 5_000 + u128::from(self.live_edges) * 10_000));
        let output_and_merkle = sat(u128::from(self.output_leaves)
            * u128::from(ceil_log2(self.output_leaves.max(2)))
            * 10_000);
        let total = [base, decode_authenticate, reconcile, graph_build, rank, output_and_merkle]
            .into_iter()
            .fold(0u64, u64::saturating_add);
        CostEstimate {
            version: COST_MODEL_VERSION,
            base,
            decode_authenticate,
            reconcile,
            graph_build,
            rank,
            output_and_merkle,
            authenticated: 0,
            total,
        }
    }
}

fn sat(value: u128) -> u64 {
    u64::try_from(value).unwrap_or(u64::MAX)
}

fn ceil_log2(value: u64) -> u32 {
    u64::BITS - value.saturating_sub(1).leading_zeros()
}

/// Named cost terms, retained in logs/benchmarks so model drift is attributable.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CostEstimate {
    pub version: u16,
    pub base: u64,
    pub decode_authenticate: u64,
    pub reconcile: u64,
    pub graph_build: u64,
    pub rank: u64,
    pub output_and_merkle: u64,
    pub authenticated: u64,
    pub total: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CapabilityDimension {
    RawRecords,
    LiveEdges,
    UniqueNodes,
    MaxOutDegree,
    WitnessBytes,
    Lane2Anchors,
    SignatureChecks,
    MaxIterations,
    IterationsRun,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CapabilityViolation {
    pub profile_version: u16,
    pub dimension: CapabilityDimension,
    pub observed: u64,
    pub limit: u64,
}

/// Published host capability. None of these ceilings are asserted by a guest or pinned in a vkey.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CapabilityProfile {
    /// The binary owns the profile schema version; configuration may tune limits, not relabel it.
    #[serde(skip_deserializing, default = "default_profile_version")]
    pub version: u16,
    #[serde(default = "default_max_raw_records", alias = "max_raw_records")]
    pub max_raw_records: u64,
    #[serde(default = "default_max_raw_records", alias = "max_live_edges")]
    pub max_live_edges: u64,
    #[serde(default = "default_max_unique_nodes", alias = "max_unique_nodes")]
    pub max_unique_nodes: u64,
    #[serde(default = "default_max_raw_records", alias = "max_out_degree")]
    pub max_out_degree: u64,
    #[serde(default = "default_max_witness_bytes", alias = "max_witness_bytes")]
    pub max_witness_bytes: u64,
    #[serde(default = "default_max_raw_records", alias = "max_lane2_anchors")]
    pub max_lane2_anchors: u64,
    #[serde(default = "default_max_raw_records", alias = "max_signature_checks")]
    pub max_signature_checks: u64,
    #[serde(default = "default_max_iterations", alias = "max_iterations")]
    pub max_iterations: u64,
}

impl Default for CapabilityProfile {
    fn default() -> Self {
        Self {
            version: CAPABILITY_PROFILE_VERSION,
            max_raw_records: DEFAULT_MAX_RAW_RECORDS,
            max_live_edges: DEFAULT_MAX_RAW_RECORDS,
            max_unique_nodes: DEFAULT_MAX_UNIQUE_NODES,
            max_out_degree: DEFAULT_MAX_RAW_RECORDS,
            max_witness_bytes: DEFAULT_MAX_WITNESS_BYTES,
            max_lane2_anchors: DEFAULT_MAX_RAW_RECORDS,
            max_signature_checks: DEFAULT_MAX_RAW_RECORDS,
            max_iterations: default_max_iterations(),
        }
    }
}

/// Most-consumed monotonic-ingress dimension in a capability profile.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct CapabilityDimensionUsage {
    pub profile_version: u16,
    pub dimension: CapabilityDimension,
    pub observed: u64,
    pub limit: u64,
}

impl CapabilityProfile {
    pub fn check(self, work: WorkProfile) -> Result<(), CapabilityViolation> {
        let checks = [
            (CapabilityDimension::RawRecords, work.raw_records, self.max_raw_records),
            (CapabilityDimension::LiveEdges, work.live_edges, self.max_live_edges),
            (CapabilityDimension::UniqueNodes, work.unique_nodes, self.max_unique_nodes),
            (CapabilityDimension::MaxOutDegree, work.max_out_degree, self.max_out_degree),
            (CapabilityDimension::WitnessBytes, work.witness_bytes, self.max_witness_bytes),
            (CapabilityDimension::Lane2Anchors, work.lane2_anchors, self.max_lane2_anchors),
            (
                CapabilityDimension::SignatureChecks,
                work.signature_checks,
                self.max_signature_checks,
            ),
            (
                CapabilityDimension::MaxIterations,
                u64::from(work.max_iterations),
                self.max_iterations,
            ),
            (
                CapabilityDimension::IterationsRun,
                u64::from(work.iterations_run),
                self.max_iterations,
            ),
        ];
        for (dimension, observed, limit) in checks {
            if observed > limit {
                return Err(CapabilityViolation {
                    profile_version: self.version,
                    dimension,
                    observed,
                    limit,
                });
            }
        }
        Ok(())
    }

    /// Returns the input-growing dimension nearest its configured ceiling. Witness bytes and
    /// iteration limits are deliberately excluded: they are prepared-input/parameter gates, not
    /// monotonic ingress counters, so using them for the irreversible-input alert would page on a
    /// healthy empty instance whose configured `max_iterations` equals the host maximum.
    pub fn limiting_ingress_dimension(self, work: WorkProfile) -> CapabilityDimensionUsage {
        let checks = [
            (CapabilityDimension::RawRecords, work.raw_records, self.max_raw_records),
            (CapabilityDimension::LiveEdges, work.live_edges, self.max_live_edges),
            (CapabilityDimension::UniqueNodes, work.unique_nodes, self.max_unique_nodes),
            (CapabilityDimension::MaxOutDegree, work.max_out_degree, self.max_out_degree),
            (CapabilityDimension::Lane2Anchors, work.lane2_anchors, self.max_lane2_anchors),
            (
                CapabilityDimension::SignatureChecks,
                work.signature_checks,
                self.max_signature_checks,
            ),
        ];
        let mut limiting = checks[0];
        for candidate in checks.into_iter().skip(1) {
            let (_, observed, limit) = limiting;
            let (_, candidate_observed, candidate_limit) = candidate;
            if u128::from(candidate_observed) * u128::from(limit)
                > u128::from(observed) * u128::from(candidate_limit)
            {
                limiting = candidate;
            }
        }
        let (dimension, observed, limit) = limiting;
        CapabilityDimensionUsage { profile_version: self.version, dimension, observed, limit }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_cap_accepts_boundary_and_rejects_one_over() {
        let cap = CapabilityProfile::default();
        let fields: [(CapabilityDimension, u64); 9] = [
            (CapabilityDimension::RawRecords, cap.max_raw_records),
            (CapabilityDimension::LiveEdges, cap.max_live_edges),
            (CapabilityDimension::UniqueNodes, cap.max_unique_nodes),
            (CapabilityDimension::MaxOutDegree, cap.max_out_degree),
            (CapabilityDimension::WitnessBytes, cap.max_witness_bytes),
            (CapabilityDimension::Lane2Anchors, cap.max_lane2_anchors),
            (CapabilityDimension::SignatureChecks, cap.max_signature_checks),
            (CapabilityDimension::MaxIterations, cap.max_iterations),
            (CapabilityDimension::IterationsRun, cap.max_iterations),
        ];
        for (dimension, limit) in fields {
            let mut work = WorkProfile {
                version: COST_MODEL_VERSION,
                program: Program::Trustgraphs,
                ..Default::default()
            };
            set(&mut work, dimension, limit);
            assert_eq!(cap.check(work), Ok(()));
            set(&mut work, dimension, limit + 1);
            assert_eq!(cap.check(work).unwrap_err().dimension, dimension);
        }
    }

    #[test]
    fn shipped_profile_is_anchored_to_the_largest_calibrated_graph_row() {
        let cap = CapabilityProfile::default();
        let calibrated = WorkProfile::from_raw_bounds(
            Program::Trustgraphs,
            InstanceSize {
                leaf_count: 1_800,
                anchor_count: 0,
                max_iterations: 100,
                seed_count: 0,
                authenticated_cycles: None,
            },
        );
        assert_eq!(calibrated.raw_records, 1_800);
        assert_eq!(calibrated.unique_nodes, 3_600);
        assert_eq!(cap.check(calibrated), Ok(()));

        let one_over = WorkProfile::from_raw_bounds(
            Program::Trustgraphs,
            InstanceSize { leaf_count: 1_801, ..InstanceSize::default() },
        );
        assert_eq!(cap.check(one_over).unwrap_err().dimension, CapabilityDimension::RawRecords);
    }

    #[test]
    fn unchanged_cycle_limit_would_bind_at_3468_if_the_profile_were_raised() {
        let estimate = |inputs| {
            WorkProfile::from_raw_bounds(
                Program::Trustgraphs,
                InstanceSize {
                    leaf_count: inputs,
                    anchor_count: 0,
                    max_iterations: 100,
                    seed_count: 0,
                    authenticated_cycles: None,
                },
            )
            .estimate()
            .total
        };
        assert!(estimate(3_467) <= OPERATOR_CYCLE_LIMIT);
        assert!(estimate(3_468) > OPERATOR_CYCLE_LIMIT);
    }

    #[test]
    fn partial_configuration_uses_profile_defaults_and_cannot_relabel_version() {
        let cap: CapabilityProfile =
            serde_json::from_str(r#"{"version":999,"maxRawRecords":42}"#).unwrap();
        assert_eq!(cap.version, CAPABILITY_PROFILE_VERSION);
        assert_eq!(cap.max_raw_records, 42);
        assert_eq!(cap.max_unique_nodes, DEFAULT_MAX_UNIQUE_NODES);
        assert_eq!(cap.max_witness_bytes, DEFAULT_MAX_WITNESS_BYTES);
    }

    #[test]
    fn ingress_utilization_ignores_static_iteration_and_witness_limits() {
        let cap = CapabilityProfile::default();
        let work = WorkProfile {
            raw_records: 900,
            live_edges: 900,
            unique_nodes: 1_800,
            max_out_degree: 900,
            witness_bytes: cap.max_witness_bytes,
            max_iterations: 100,
            iterations_run: 100,
            ..WorkProfile::default()
        };
        let usage = cap.limiting_ingress_dimension(work);
        assert_eq!(usage.dimension, CapabilityDimension::RawRecords);
        assert_eq!((usage.observed, usage.limit), (900, 1_800));
    }

    fn set(work: &mut WorkProfile, dimension: CapabilityDimension, value: u64) {
        match dimension {
            CapabilityDimension::RawRecords => work.raw_records = value,
            CapabilityDimension::LiveEdges => work.live_edges = value,
            CapabilityDimension::UniqueNodes => work.unique_nodes = value,
            CapabilityDimension::MaxOutDegree => work.max_out_degree = value,
            CapabilityDimension::WitnessBytes => work.witness_bytes = value,
            CapabilityDimension::Lane2Anchors => work.lane2_anchors = value,
            CapabilityDimension::SignatureChecks => work.signature_checks = value,
            CapabilityDimension::MaxIterations => work.max_iterations = value as u32,
            CapabilityDimension::IterationsRun => work.iterations_run = value as u32,
        }
    }

    #[test]
    fn stage_one_bounds_hold_for_any_reconciled_edge_set() {
        let size = InstanceSize {
            leaf_count: 123,
            anchor_count: 17,
            max_iterations: 40,
            seed_count: 5,
            authenticated_cycles: None,
        };
        let bound = WorkProfile::from_raw_bounds(Program::Trustgraphs, size);
        assert_eq!(bound.live_edges, 140);
        assert_eq!(bound.unique_nodes, 285);
        assert_eq!(bound.iterations_run, 40);
        // A reconciled pair has at most one live edge; each edge names at most two nodes.
        for (live_edges, unique_nodes) in [(0, 5), (90, 180), (140, 285)] {
            assert!(live_edges <= bound.live_edges);
            assert!(unique_nodes <= bound.unique_nodes);
        }
    }

    #[test]
    fn named_terms_are_parameter_aware_and_saturating() {
        let small = WorkProfile {
            version: 1,
            program: Program::Trustgraphs,
            raw_records: 10,
            live_edges: 8,
            unique_nodes: 12,
            max_out_degree: 3,
            witness_bytes: 1_024,
            lane2_anchors: 0,
            signature_checks: 0,
            max_iterations: 10,
            iterations_run: 5,
            output_leaves: 12,
            authenticated_cycle_bound: None,
        };
        let mut larger = small;
        larger.iterations_run = 10;
        larger.witness_bytes = 2_048;
        assert!(larger.estimate().total > small.estimate().total);
        assert!(larger.estimate().rank > small.estimate().rank);
        assert!(larger.estimate().decode_authenticate > small.estimate().decode_authenticate);
    }
}
