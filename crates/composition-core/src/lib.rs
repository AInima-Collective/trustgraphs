//! Consensus core for the isolated `trust-compose` V1 program.
//!
//! The core consumes an exact compact captured-state manifest plus every complete canonical source
//! blob. It validates the static source policy, capture/freshness commitments, source output roots,
//! and two-stage Hamilton allocation without floating point or iteration-order dependence. The
//! existing TrustGraph, weighted, Contributions, and Hypercerts programs do not import this crate.

use alloy_primitives::{keccak256, Address, B256, U256};
use serde::{Deserialize, Serialize};

pub mod blob;
pub mod codec;
pub mod compute;
pub mod fixture;
pub mod hamilton;

pub const PARAMS_VERSION: u32 = 1;
pub const MANIFEST_VERSION: u16 = 1;
pub const CAPTURE_MAGIC: &[u8; 4] = b"TGCM";
pub const POLICY_MAGIC: &[u8; 4] = b"TGCP";
pub const WEIGHT_SCALE: u64 = 1_000_000_000_000_000_000;
pub const MIN_SOURCES: usize = 2;
pub const MAX_SOURCES: usize = 8;
pub const MAX_ENTRIES_PER_SOURCE: usize = 4_096;
pub const MAX_AGGREGATE_ENTRIES: usize = 8_192;
pub const MAX_UNION_ACCOUNTS: usize = 8_192;
pub const MAX_AGGREGATE_BLOB_BYTES: usize = 1_048_576;
pub const MAX_SOURCE_AGE_BLOCKS: u64 = 500_000;

pub fn program_id() -> B256 {
    keccak256(b"trust-compose")
}

pub fn identity_domain() -> B256 {
    keccak256(b"eip155-address")
}

pub fn output_kind() -> B256 {
    keccak256(b"allocation")
}

pub fn output_domain() -> B256 {
    keccak256(b"trustgraphs.output.trust-compose-account.v1")
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum CompositionError {
    UnsupportedParamsVersion(u32),
    WrongProgramId,
    InvalidScope,
    WrongIdentityDomain,
    WrongOutputKind,
    WrongOutputDomain,
    InvalidAdmittedProgram,
    InvalidWeightScale(u64),
    InvalidOutputPool,
    InvalidSourceCount(usize),
    InvalidBounds,
    InvalidMaxSourceAge(u64),
    InvalidAccumulator,
    InvalidChain(u64),
    InvalidPolicyCommitment,
    CaptureManifestTooShort(usize),
    InvalidCaptureManifestLength { expected: usize, actual: usize },
    InvalidCaptureMagic,
    UnsupportedCaptureVersion(u16),
    WrongCaptureChain { expected: u64, actual: u64 },
    CaptureCountMismatch { expected: usize, actual: usize },
    CaptureCommitmentMismatch { expected: B256, actual: B256 },
    SourcePreimageCountMismatch { expected: usize, actual: usize },
    ZeroSourceId,
    SourceIdsNotStrictlySorted,
    ZeroSnapshot,
    DuplicateSnapshot(Address),
    ZeroFamilyId,
    UnadmittedSourceProgram(B256),
    CompositeSourceForbidden,
    OptionalSourceUnsupported,
    InvalidSourceWeight(B256),
    InvalidSourceWeightSum(u128),
    InvalidSourceAge { source_id: B256, max_age: u64 },
    StaleSource(B256),
    InvalidSourceTotal(B256),
    PolicyManifestMismatch { expected: B256, actual: B256 },
    SourcePolicyRootMismatch { expected: B256, actual: B256 },
    CidDigestMismatch(B256),
    BlobSha256Mismatch(B256),
    CidMismatch(B256),
    SourceBlobNotJson,
    SourceBlobNotCanonical,
    EmptySourceBlob,
    InvalidSourceAccount(String),
    InvalidSourceValue { account: String, value: String },
    TooManyEntries { source_id: B256, count: usize },
    AggregateEntryLimit(usize),
    AggregateBlobByteLimit(usize),
    UnionAccountLimit(usize),
    SourceTotalMismatch(B256),
    SourceRootMismatch(B256),
    InvalidHamiltonInputs,
    RequiredSourceReceivedZero(B256),
    ArithmeticOverflow,
    OutputPoolMismatch,
}

impl core::fmt::Display for CompositionError {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        write!(f, "{self:?}")
    }
}

impl std::error::Error for CompositionError {}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Params {
    pub version: u32,
    pub program_id: B256,
    pub scope_hash: B256,
    pub identity_domain: B256,
    pub output_kind: B256,
    pub output_domain: B256,
    pub admitted_program_id: B256,
    pub weight_scale: u64,
    pub output_pool: u128,
    pub source_policy_root: B256,
    pub source_count: u8,
    pub policy_manifest_sha256: B256,
    pub max_sources: u8,
    pub max_entries_per_source: u32,
    pub max_aggregate_entries: u32,
    pub max_union_accounts: u32,
    pub max_aggregate_blob_bytes: u32,
    pub max_source_age_blocks: u64,
    pub accumulator: Address,
    pub chain_id: u64,
}

impl Params {
    pub fn validate(&self) -> Result<(), CompositionError> {
        if self.version != PARAMS_VERSION {
            return Err(CompositionError::UnsupportedParamsVersion(self.version));
        }
        if self.program_id != program_id() {
            return Err(CompositionError::WrongProgramId);
        }
        if self.scope_hash == B256::ZERO {
            return Err(CompositionError::InvalidScope);
        }
        if self.identity_domain != identity_domain() {
            return Err(CompositionError::WrongIdentityDomain);
        }
        if self.output_kind != output_kind() {
            return Err(CompositionError::WrongOutputKind);
        }
        if self.output_domain != output_domain() {
            return Err(CompositionError::WrongOutputDomain);
        }
        if self.admitted_program_id == B256::ZERO {
            return Err(CompositionError::InvalidAdmittedProgram);
        }
        if self.admitted_program_id == program_id() {
            return Err(CompositionError::CompositeSourceForbidden);
        }
        if self.weight_scale != WEIGHT_SCALE {
            return Err(CompositionError::InvalidWeightScale(self.weight_scale));
        }
        if self.output_pool == 0 {
            return Err(CompositionError::InvalidOutputPool);
        }
        let source_count = self.source_count as usize;
        if !(MIN_SOURCES..=MAX_SOURCES).contains(&source_count)
            || source_count > self.max_sources as usize
        {
            return Err(CompositionError::InvalidSourceCount(source_count));
        }
        if self.source_policy_root == B256::ZERO || self.policy_manifest_sha256 == B256::ZERO {
            return Err(CompositionError::InvalidPolicyCommitment);
        }
        if (self.max_sources as usize) > MAX_SOURCES
            || (self.max_sources as usize) < MIN_SOURCES
            || self.max_entries_per_source == 0
            || (self.max_entries_per_source as usize) > MAX_ENTRIES_PER_SOURCE
            || self.max_aggregate_entries == 0
            || (self.max_aggregate_entries as usize) > MAX_AGGREGATE_ENTRIES
            || self.max_union_accounts == 0
            || (self.max_union_accounts as usize) > MAX_UNION_ACCOUNTS
            || self.max_aggregate_blob_bytes == 0
            || (self.max_aggregate_blob_bytes as usize) > MAX_AGGREGATE_BLOB_BYTES
            || self.max_entries_per_source > self.max_aggregate_entries
            || self.max_union_accounts > self.max_aggregate_entries
        {
            return Err(CompositionError::InvalidBounds);
        }
        if self.max_source_age_blocks == 0 || self.max_source_age_blocks > MAX_SOURCE_AGE_BLOCKS {
            return Err(CompositionError::InvalidMaxSourceAge(self.max_source_age_blocks));
        }
        if self.accumulator == Address::ZERO {
            return Err(CompositionError::InvalidAccumulator);
        }
        if self.chain_id == 0 {
            return Err(CompositionError::InvalidChain(self.chain_id));
        }
        Ok(())
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Binding {
    #[serde(default)]
    pub recipient: Address,
    #[serde(default)]
    pub instance_domain: B256,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SourcePreimage {
    pub cid: String,
    #[serde(with = "zk_core::serde_hex")]
    pub blob: Vec<u8>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GuestInput {
    pub params: Params,
    #[serde(with = "zk_core::serde_hex")]
    pub manifest: Vec<u8>,
    pub source_preimages: Vec<SourcePreimage>,
    pub capture_commitment: B256,
    pub capture_count: u64,
    #[serde(default)]
    pub binding: Binding,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct CapturedSource {
    pub source_id: B256,
    pub snapshot: Address,
    pub family_id: B256,
    pub program_id: B256,
    pub state_index: u64,
    pub freeze_block: u64,
    pub output_root: B256,
    pub blob_sha256: B256,
    pub cid_digest: B256,
    pub total_value: u128,
    pub weight: u64,
    pub max_age_blocks: u64,
    pub required: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CapturedManifest {
    pub chain_id: u64,
    pub capture_block: u64,
    pub sources: Vec<CapturedSource>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AllocationEntry {
    pub account: Address,
    pub value: u128,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceAllocation {
    pub source_id: B256,
    pub quota: u128,
    pub allocations: Vec<AllocationEntry>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Journal {
    pub acc: B256,
    pub leaf_count: u64,
    pub anchor_acc: B256,
    pub anchor_count: u64,
    pub params_hash: B256,
    pub output_root: B256,
    pub ipfs_hash: B256,
    pub cid_digest: B256,
    pub total_value: U256,
    pub skipped_digest: B256,
    pub recipient: Address,
    pub instance_domain: B256,
}

#[derive(Clone, Debug)]
pub struct ComputeResult {
    pub journal: Journal,
    pub source_allocations: Vec<SourceAllocation>,
    pub scores: Vec<(Address, U256)>,
    pub blob: Vec<u8>,
    pub cid: String,
    pub manifest: CapturedManifest,
}
