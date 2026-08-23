//! Canonical fixed-point Trust-Aware PageRank and the exact byte encodings that bind the
//! zkVM guest, the on-chain contracts, and the browser to one definition of "the scored root".
//!
//! This crate is the SINGLE SOURCE OF TRUTH. It contains NO floating point, NO platform-dependent
//! operations, NO async, and NO wasm-bindgen — so the identical logic compiles to the SP1 zkVM
//! guest, native (host + tests), and (via a thin wrapper) WASM for the browser.
//!
//! See `research/ZK_ARCHITECTURE.md` §4.1 (committed byte formats and fixed-point guest contract).

use alloy_primitives::{Address, B256, U256};
use serde::{Deserialize, Serialize};

/// Params-hash schema/domain word. Version 3 removes the founder multiplier and closes the
/// reachability gate; it intentionally cannot collide with either earlier tuple shape.
pub const PARAMS_SCHEMA_VERSION: u32 = 3;

// Program-agnostic building blocks live in `zk-core` (shared with every program crate);
// re-exported here so this crate's public API is unchanged by the extraction.
pub use zk_core::{cid, fixed, merkle};

pub mod compute;
pub mod distribute;
pub mod encode;
pub mod lane2;
pub mod pagerank;
pub mod reconcile;
pub mod signer;

#[cfg(test)]
mod pagerank_oracle;
#[cfg(test)]
mod pagerank_properties;
#[cfg(test)]
mod pagerank_test_support;
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
    /// Lane 2 (envelope 0): accepted EAS-offchain EIP-712 domain separators. EMPTY = lane 2
    /// disabled (the guest then asserts the empty lane). Hashed into `params_hash` as
    /// `keccak(concat(separators))` (0 when empty).
    #[serde(default)]
    pub envelope0_domain_separators: Vec<B256>,
    /// Rule Φ staleness horizon in seconds: a node's newest usable head must be at most this
    /// much older than the witnessed anchor log's latest timestamp, else the node's out-edges
    /// drop for the epoch. MUST be nonzero when lane 2 is enabled.
    #[serde(default)]
    pub lane2_max_head_age: u64,
    /// Domain separation (INSTANCE_FACTORY §6.1): the instance's on-chain accumulator
    /// (`EASIndexerResolver`). Two identical clones — same seeds, same params, same (e.g. empty
    /// genesis) edge set — would otherwise accept each other's proofs; folding the accumulator
    /// address into `params_hash` makes every instance's journal digest instance-specific.
    /// Defaults to zero so a pre-v2 `params.json` still deserializes; the contracts/deploy/factory path
    /// always supplies the real address.
    #[serde(default)]
    pub accumulator: Address,
    /// Domain separation (INSTANCE_FACTORY §6.1): `block.chainid` at instance creation. The
    /// multi-chain prerequisite — the same instance mirrored on another chain hashes differently.
    #[serde(default)]
    pub chain_id: u64,
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

/// One anchor claim, exactly as `AnchorRegistry` folded it (re-folds to `anchorAcc`).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct AnchorRecord {
    pub node_id: B256,
    pub envelope_kind: u8,
    pub head: B256,
    /// The head's signed monotonic position (envelope 0: the log length co-signed with the
    /// head, ingress-verified by `AnchorRegistry` for address nodes). H-5: rule Φ rejects any
    /// anchored head whose count is below the node's max anchored count.
    pub count: u64,
    pub data_commitment: B256,
    pub block_timestamp: u64,
}

/// The lane-2 witness: the full anchor log plus whatever per-head envelope data the prover
/// could supply. Missing/invalid data trips rule Φ per node — never an abort.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Lane2Witness {
    /// The complete anchor log in fold order (must re-fold to the checkpointed `anchorAcc`).
    pub anchors: Vec<AnchorRecord>,
    /// Envelope-0 witnesses, matched to anchors by the owner-derived nodeId.
    pub envelopes: Vec<envelopes::eas_offchain::Envelope0Witness>,
}

/// Rule-Φ / deterministic-skip reason codes (the closed list committed via `skippedDigest`).
pub mod skip_reason {
    /// The node's newest head was unusable; an OLDER in-window head was consumed instead.
    pub const CARRIED: u8 = 1;
    /// No usable head within the staleness window — the node's out-edges dropped.
    pub const DROPPED: u8 = 2;
}

/// The two pass-through commitments every program's journal carries in v3. Neither is computed
/// from anything: the prover supplies both, the guest copies them verbatim into the journal, and
/// the CONTRACT is what makes them binding — `MerkleSnapshot.submitProof` rebuilds the digest with
/// the recipient it was called with and an `instanceDomain` derived from `address(this)` and
/// `block.chainid`, so a proof that names a different payee or a different instance simply does
/// not verify.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Binding {
    /// The bounty payee. `Address::ZERO` is legitimate and means "no bounty" — a curated
    /// instance proven on the hosted operator, or a community self-proving for free.
    #[serde(default)]
    pub recipient: Address,
    /// `keccak256(abi.encode(snapshot, chainId))` — see [`zk_core::journal::instance_domain`].
    /// A zero value is never legitimate on-chain (the contract's rebuild is a keccak), so a
    /// forgotten binding fails at `submitProof` rather than landing somewhere wrong.
    #[serde(default)]
    pub instance_domain: B256,
}

/// The complete input the guest receives.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct GuestInput {
    /// Edges in accumulator fold order (index = `leafCount` position).
    pub edges: Vec<RawEdge>,
    pub params: Params,
    /// Lane-2 witness; None/absent for a lane-1-only instance (journal commits zero lane).
    #[serde(default)]
    pub lane2: Option<Lane2Witness>,
    /// Journal-v3 pass-through commitments (payee + instance domain).
    #[serde(default)]
    pub binding: Binding,
}

/// The 12 public fields the guest commits (journal v3 — two-lane plus the v3 bindings).
/// `keccak256(abi.encode(..))` of these is the journal digest the on-chain verifier binds.
/// Field order is FROZEN — see [`encode::journal_digest`]. An instance with an empty lane
/// encodes it as the zero accumulator: lane-1-only ⇒ `anchor_acc = 0, anchor_count = 0,
/// skipped_digest = 0`; lane-2-only ⇒ `acc = 0, leaf_count = 0`. The guest, not the
/// contract, decides what an empty lane means. (Journal v1 exists solely as the frozen
/// live deployment; there is no v1 code path. v2 is the 10-field shape v3 appends to.)
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Journal {
    pub acc: B256,
    pub leaf_count: u64,
    /// Lane-2 anchor-log accumulator at the checkpoint (`AnchorRegistry.anchorAcc`).
    pub anchor_acc: B256,
    /// Lane-2 anchor count at the checkpoint.
    pub anchor_count: u64,
    pub params_hash: B256,
    pub output_root: B256,
    pub ipfs_hash: B256,
    pub cid_digest: B256,
    pub total_value: U256,
    /// Chained fold over rule-Φ / deterministic-skip entries (`zk_core::anchor::skipped_digest`);
    /// `bytes32(0)` when nothing was skipped (or the instance has no lane 2).
    pub skipped_digest: B256,
    /// v3: the bounty payee, committed verbatim from [`Binding::recipient`]. Bound because
    /// `submitProof` folds its own `recipient` argument into the digest, so the fee provably
    /// follows the journal rather than `msg.sender` — a copied transaction pays the original
    /// prover (PROOF_SCHEDULER.md §4.3, superseding commit-reveal).
    pub recipient: Address,
    /// v3: the instance this proof is for, committed verbatim from [`Binding::instance_domain`].
    /// Bound because `submitProof` rebuilds it from `address(this)` and `block.chainid`.
    pub instance_domain: B256,
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
    /// Non-consensus work telemetry used by operator admission and drift monitoring.
    pub rank: RankTelemetry,
    /// Number of witness signature verification calls in the full computation.
    pub signature_checks: u64,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct RankTelemetry {
    pub unique_nodes: u64,
    pub live_edges: u64,
    pub max_out_degree: u64,
    pub max_iterations: u32,
    pub iterations_run: u32,
    pub converged: bool,
}

/// Governance-pinned parameters for the Safe signer-sync selection rule. Hashed to
/// `selectionParamsHash` (see [`encode::selection_params_hash`]) and pinned in `SignerSyncZkModule`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct SelectionParams {
    /// Maximum number of top-scored accounts to select as Safe owners.
    pub top_n: u32,
    /// Minimum resulting Safe threshold (>= 1).
    pub min_threshold: u32,
    /// Target threshold as a fraction of the selected owner count, in basis points (e.g. 5000 = 50%).
    pub target_threshold_bps: u32,
    /// Direct-governance activity remains fresh for this many blocks.
    pub max_inactive_blocks: u64,
    /// Distinct fresh principals required before inactivity may change the owner set. Production
    /// deployments enforce a minimum of two so one account cannot activate removals alone.
    pub min_activity_witnesses: u32,
}

/// One authenticated direct-vote record emitted by the instance's `MerkleGovModule`. The source
/// folds these records into a hash chain; the signer guest refuses any incomplete or reordered
/// witness by comparing its reconstruction with [`ActivityCheckpoint::acc`].
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct SignerActivity {
    pub account: Address,
    pub proposal_id: U256,
    pub block_number: u64,
}

/// An immutable on-chain snapshot of the direct-governance activity hash chain.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ActivityCheckpoint {
    pub acc: B256,
    pub count: u64,
    pub block_number: u64,
}

/// The input the signer-sync guest receives: the same folded edges + params as the root producer,
/// plus the selection parameters and the instance binding.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct SignerInput {
    pub edges: Vec<RawEdge>,
    pub params: Params,
    pub selection: SelectionParams,
    /// Complete, ordered direct-vote history through `activity_checkpoint`.
    #[serde(default)]
    pub activity: Vec<SignerActivity>,
    #[serde(default)]
    pub activity_checkpoint: ActivityCheckpoint,
    /// Source-local checkpoint id used only to address the on-chain snapshot at submission; its
    /// committed fields, not this id, are consensus inputs.
    #[serde(default)]
    pub activity_checkpoint_id: u64,
    /// Safe owners immediately before this proof. The on-chain module independently recomputes
    /// their root, preventing an operator from inventing the pre-rotation state.
    #[serde(default)]
    pub current_signers: Vec<Address>,
    #[serde(default)]
    pub current_threshold: U256,
    /// Whether the signer module has applied a prior rotation. Before the first rotation, fresh
    /// scored members can bootstrap the gate; afterwards the witnesses must be current owners.
    #[serde(default)]
    pub was_initialized: bool,
    /// `keccak256(abi.encode(module, chainId))` — see [`zk_core::journal::instance_domain`], with
    /// the `SignerSyncZkModule` address in the snapshot slot. Committed verbatim by the guest and
    /// made binding by `submitSignerProof`, which REBUILDS it from `address(this)` and
    /// `block.chainid` (audit M-3: without it, two same-params modules sharing an accumulator, or
    /// mirrored at one CREATE2 address cross-chain, would accept each other's owner-rotation
    /// proofs). A zero value is never legitimate on-chain (the rebuild is a keccak), so a
    /// forgotten binding fails at `submitSignerProof` rather than landing somewhere wrong.
    #[serde(default)]
    pub instance_domain: B256,
}

/// The 13 public fields the signer-sync guest commits. `keccak256(abi.encode(..))` is the digest the
/// on-chain `SignerSyncZkModule` binds. Field order is FROZEN — see [`encode::signer_journal_encoded`].
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct SignerJournal {
    pub acc: B256,
    pub leaf_count: u64,
    pub params_hash: B256,
    pub selection_params_hash: B256,
    pub activity_acc: B256,
    pub activity_count: u64,
    pub activity_block: u64,
    pub was_initialized: bool,
    pub current_signer_set_root: B256,
    pub current_threshold: U256,
    /// OZ StandardMerkleTree root over the canonically-sorted selected owner set (leaf =
    /// `keccak256(abi.encode(address))`), identical to `seedSetRoot`.
    pub signer_set_root: B256,
    pub target_threshold: U256,
    /// The instance this proof is for, committed verbatim from [`SignerInput::instance_domain`].
    pub instance_domain: B256,
}

/// Full result of a signer-sync computation: the journal plus the selected owner set and threshold.
#[derive(Clone, Debug)]
pub struct SignerComputeResult {
    pub journal: SignerJournal,
    /// The selected owner set, sorted ascending by address (the canonical order the root commits to).
    pub signers: Vec<Address>,
    pub target_threshold: U256,
    /// False means the authenticated signal was absent or insufficient and the result is exactly
    /// the pre-rotation Safe state.
    pub activity_applied: bool,
    pub rank: RankTelemetry,
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
