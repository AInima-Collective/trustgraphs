//! Consensus core for the isolated `trust-graph-weighted` V1 program.
//!
//! The existing binary-seed program does not import this crate. The core owns the compact `TGWP`
//! manifest, persistent personalized-prior PageRank, exact Hamilton apportionment, and the frozen
//! params/journal encodings used by its SP1 guest. It contains no floating point, async code, or
//! platform-dependent iteration.

use alloy_primitives::{Address, B256, U256};
use serde::{Deserialize, Serialize};

pub mod compute;
pub mod encode;
pub mod manifest;
pub mod rank;
pub mod reconcile;

pub const SCALE: u64 = 1_000_000_000_000_000_000;
pub const PARAMS_VERSION: u32 = 1;
pub const MAX_PRIOR_ENTRIES: usize = 2_048;
pub const MAX_ITERATIONS: u32 = 40;
pub const MANIFEST_MAGIC: &[u8; 4] = b"TGWP";
pub const MANIFEST_VERSION: u16 = 1;

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum WeightedError {
    EmptyPrior,
    TooManyPriorEntries(usize),
    NonCanonicalDecimal(String),
    ZeroAddress,
    DuplicateAccount(Address),
    AccountsNotStrictlySorted(Address),
    ZeroWeight(Address),
    ZeroAfterNormalization(Address),
    InvalidNormalizedSum(u64),
    ManifestTooShort(usize),
    InvalidManifestLength { expected: usize, actual: usize },
    InvalidManifestMagic,
    UnsupportedManifestVersion(u16),
    WrongManifestChain { expected: u64, actual: u64 },
    ManifestCountMismatch { expected: u32, actual: u32 },
    PriorRootMismatch { expected: B256, actual: B256 },
    ManifestDigestMismatch { expected: B256, actual: B256 },
    UnsupportedParamsVersion(u32),
    InvalidDamping(u64),
    InvalidTolerance(u64),
    InvalidIterationCount(u32),
    InvalidWeightBounds { min: u64, max: u64 },
    InvalidParamsChain(u64),
    InvalidApportionment,
    ArithmeticOverflow,
}

impl core::fmt::Display for WeightedError {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        write!(f, "{self:?}")
    }
}

impl std::error::Error for WeightedError {}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct RawPriorEntry {
    pub account: Address,
    pub weight: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct PriorEntry {
    pub account: Address,
    pub weight: u64,
}

pub use zk_core::edge::RawEdge;

/// Governance-pinned weighted-program parameters. Edge weights remain relative integers; the
/// prior and every rank vector use the constitutional [`SCALE`].
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Params {
    pub version: u32,
    pub damping_fp: u64,
    pub tolerance_fp: u64,
    pub max_iterations: u32,
    pub min_weight: u64,
    pub max_weight: u64,
    pub prior_root: B256,
    pub prior_count: u32,
    pub manifest_sha256: B256,
    pub schema_uid: B256,
    pub weight_field_index: u32,
    pub accumulator: Address,
    pub chain_id: u64,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Binding {
    #[serde(default)]
    pub recipient: Address,
    #[serde(default)]
    pub instance_domain: B256,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct GuestInput {
    pub edges: Vec<RawEdge>,
    pub params: Params,
    /// Exact canonical `TGWP` bytes. The guest revalidates every commitment and list invariant.
    #[serde(with = "zk_core::serde_hex")]
    pub manifest: Vec<u8>,
    #[serde(default)]
    pub binding: Binding,
}

pub use zk_core::journal::Journal;

#[derive(Clone, Debug)]
pub struct ComputeResult {
    pub journal: Journal,
    /// Nonzero normalized scores, ascending by address. Their values sum exactly to [`SCALE`].
    pub scores: Vec<(Address, U256)>,
    pub blob: Vec<u8>,
    pub cid: String,
    pub iterations: u32,
}

impl Params {
    pub fn validate(&self) -> Result<(), WeightedError> {
        if self.version != PARAMS_VERSION {
            return Err(WeightedError::UnsupportedParamsVersion(self.version));
        }
        if self.damping_fp == 0 || self.damping_fp >= SCALE {
            return Err(WeightedError::InvalidDamping(self.damping_fp));
        }
        if self.tolerance_fp > SCALE {
            return Err(WeightedError::InvalidTolerance(self.tolerance_fp));
        }
        if self.max_iterations == 0 || self.max_iterations > MAX_ITERATIONS {
            return Err(WeightedError::InvalidIterationCount(self.max_iterations));
        }
        if self.max_weight == 0 || self.min_weight > self.max_weight {
            return Err(WeightedError::InvalidWeightBounds {
                min: self.min_weight,
                max: self.max_weight,
            });
        }
        if self.prior_count == 0 || self.prior_count as usize > MAX_PRIOR_ENTRIES {
            return Err(WeightedError::TooManyPriorEntries(self.prior_count as usize));
        }
        if self.chain_id == 0 {
            return Err(WeightedError::InvalidParamsChain(self.chain_id));
        }
        Ok(())
    }
}
