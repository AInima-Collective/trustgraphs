//! Consensus core for the mutual-recognition `trust-graph-mutual` V1 program.
//!
//! The existing binary-seed and weighted-prior programs do not import this crate. The core owns
//! the compact `TGMR` manifest, the mutual-gate edge derivation (`w(a→b) = min(a→b, b→a)`, flow
//! only where vouching is reciprocated), persistent personalized-prior PageRank, exact Hamilton
//! apportionment, and the frozen params/journal encodings used by its SP1 guest. It contains no
//! floating point, async code, or platform-dependent iteration.
//!
//! Scoring semantics: after the same EAS fold-order reconciliation as the weighted program, the
//! transition graph keeps only *mutual* pairs — a directed edge a→b carries influence exactly when
//! b→a exists too, with weight `min(w(a→b), w(b→a))`. One-way vouches move no trust: an account can
//! vouch freely but gains inbound rank only through reciprocated recognition, so a ring of
//! unreciprocated vouches is inert. The trusted-start prior is unchanged — seeds still anchor the
//! teleport mass, so mutuality is a second Sybil gate layered on top, not a replacement.

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
pub const MANIFEST_MAGIC: &[u8; 4] = b"TGMR";
pub const MANIFEST_VERSION: u16 = 1;

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum MutualError {
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

impl core::fmt::Display for MutualError {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        write!(f, "{self:?}")
    }
}

impl std::error::Error for MutualError {}

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

/// Governance-pinned mutual-program parameters. The tuple layout is the weighted program's (same
/// EAS input stream and commitment needs); the mutual gate is fixed program semantics, not a
/// parameter. Edge weights remain relative integers; the prior and every rank vector use the
/// constitutional [`SCALE`].
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
    /// Exact canonical `TGMR` bytes. The guest revalidates every commitment and list invariant.
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
    pub fn validate(&self) -> Result<(), MutualError> {
        if self.version != PARAMS_VERSION {
            return Err(MutualError::UnsupportedParamsVersion(self.version));
        }
        if self.damping_fp == 0 || self.damping_fp >= SCALE {
            return Err(MutualError::InvalidDamping(self.damping_fp));
        }
        if self.tolerance_fp > SCALE {
            return Err(MutualError::InvalidTolerance(self.tolerance_fp));
        }
        if self.max_iterations == 0 || self.max_iterations > MAX_ITERATIONS {
            return Err(MutualError::InvalidIterationCount(self.max_iterations));
        }
        if self.max_weight == 0 || self.min_weight > self.max_weight {
            return Err(MutualError::InvalidWeightBounds {
                min: self.min_weight,
                max: self.max_weight,
            });
        }
        if self.prior_count == 0 || self.prior_count as usize > MAX_PRIOR_ENTRIES {
            return Err(MutualError::TooManyPriorEntries(self.prior_count as usize));
        }
        if self.chain_id == 0 {
            return Err(MutualError::InvalidParamsChain(self.chain_id));
        }
        Ok(())
    }
}
