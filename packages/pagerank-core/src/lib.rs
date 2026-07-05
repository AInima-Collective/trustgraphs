//! Canonical fixed-point Trust-Aware PageRank and the exact byte encodings that bind the
//! zkVM guest, the on-chain contracts, and the browser to one definition of "the scored root".
//!
//! This crate is the SINGLE SOURCE OF TRUTH. It contains NO floating point, NO platform-dependent
//! operations, NO async, and NO wasm-bindgen — so the identical logic compiles to the SP1 zkVM
//! guest, native (host + tests), and (via a thin wrapper) WASM for the browser.
//!
//! See `PLAN.md` §1 (frozen byte formats) and §2 (fixed-point algorithm spec).

use alloy_primitives::{Address, B256, U256};
use serde::{Deserialize, Serialize};

pub mod cid;
pub mod compute;
pub mod distribute;
pub mod encode;
pub mod fixed;
pub mod merkle;
pub mod pagerank;
pub mod reconcile;

#[cfg(test)]
mod tests;

/// A single folded edge, in accumulator fold order. The guest re-folds these to reproduce `acc`.
///
/// `data` is the raw EAS attestation `data` (the preimage of `dataHash = keccak256(data)`); the
/// weight (confidence) is decoded from it at `Params::weight_field_index`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct RawEdge {
    /// 0 = attest, 1 = revoke.
    pub kind: u8,
    pub attester: Address,
    pub recipient: Address,
    pub uid: B256,
    /// The `block.timestamp` folded on-chain (drives the reconciliation order).
    pub block_timestamp: u64,
    /// Raw attestation data (ABI-encoded `string comment, uint256 confidence`).
    #[serde(with = "serde_bytes_hex")]
    pub data: Vec<u8>,
}

/// Governance-pinned parameters. All `*_fp` fields are scaled by `precision_scale` (1e18).
/// The exact ABI tuple that hashes to `paramsHash` is frozen in [`encode::params_hash`].
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Params {
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
    pub total_pool: U256,
    /// Internal fixed-point scale S (1e18).
    pub precision_scale: U256,
    pub schema_uid: B256,
    /// ABI head-slot index of the confidence field in the attestation `data` (currently 1).
    pub weight_field_index: u32,
}

impl Params {
    /// Trust is enabled iff there is at least one trusted seed (mirrors `has_trust_enabled`).
    pub fn has_trust_enabled(&self) -> bool {
        !self.trusted_seeds.is_empty()
    }

    /// The fixed-point scale S.
    pub fn scale(&self) -> U256 {
        self.precision_scale
    }
}

/// The complete input the guest receives.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct GuestInput {
    /// Edges in accumulator fold order (index = `leafCount` position).
    pub edges: Vec<RawEdge>,
    pub params: Params,
}

/// The 7 public fields the guest commits. `keccak256(abi.encode(..))` of these is the journal digest
/// the on-chain verifier binds. Field order is FROZEN — see [`encode::journal_digest`].
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Journal {
    pub acc: B256,
    pub leaf_count: u64,
    pub params_hash: B256,
    pub output_root: B256,
    pub ipfs_hash: B256,
    pub cid_digest: B256,
    pub total_value: U256,
}

/// Full result of a canonical computation: the journal plus the artifacts the host needs to pin
/// and serve (the scored set, the canonical blob, and its CID string).
#[derive(Clone, Debug)]
pub struct ComputeResult {
    pub journal: Journal,
    /// `{account -> value}` for accounts with `value > 0`, sorted ascending by address.
    pub scores: Vec<(Address, U256)>,
    /// The canonical JSON blob bytes (what `ipfs_hash`/`cid` commit to).
    pub blob: Vec<u8>,
    /// The CIDv1 (raw, sha2-256) string.
    pub cid: String,
}

/// Minimal `serde` helper so `RawEdge::data` round-trips as a `0x`-hex string in golden vectors.
mod serde_bytes_hex {
    use serde::{Deserialize, Deserializer, Serializer};

    pub fn serialize<S: Serializer>(bytes: &[u8], s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&format!("0x{}", alloy_primitives::hex::encode(bytes)))
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<Vec<u8>, D::Error> {
        let s = String::deserialize(d)?;
        let s = s.strip_prefix("0x").unwrap_or(&s);
        alloy_primitives::hex::decode(s).map_err(serde::de::Error::custom)
    }
}
