use std::collections::BTreeSet;

use alloy_primitives::{keccak256, B256, U256};
use nostr_envelope::nostr::NostrLimits;
use pagerank_core::merkle;
use serde::{Deserialize, Serialize};
use zk_core::words::{word_u256, word_u32, word_u64, word_u8};

pub const PARAMS_VERSION: u32 = 1;
pub const PARAMS_SCHEMA_VERSION: u32 = 3;
pub const PRECISION_SCALE: u64 = 1_000_000_000_000_000_000;
pub const MAX_ITERATIONS: u32 = 500;
pub const MAX_TRUSTED_SEEDS: usize = 64;
pub fn program_id() -> B256 {
    keccak256(b"nostr-workspace")
}

pub fn output_domain() -> B256 {
    keccak256(b"trustgraphs.output.nostr-member.v1")
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Params {
    pub version: u32,
    pub output_domain: B256,
    pub damping_fp: U256,
    pub tolerance_fp: U256,
    pub max_iterations: u32,
    pub trust_share_fp: U256,
    pub trust_decay_fp: U256,
    pub precision_scale: U256,
    pub total_pool: U256,
    pub trusted_seed_pubkeys: Vec<[u8; 32]>,
    pub community_id: [u8; 16],
    pub instance_domain: [u8; 32],
    pub relay_pubkey: [u8; 32],
    pub chain_id: u64,
    pub allowed_variants: u8,
    pub w_vouch_fp: U256,
    pub w_merge_fp: U256,
    pub w_job_fp: U256,
    pub w_forum_fp: U256,
    pub relay_attested_weight_fp: U256,
    pub forum_pair_cap: u32,
    pub job_pair_cap: u32,
    pub lane2_max_head_age: u64,
    pub max_anchor_records: u32,
    pub max_estimated_pgu: u64,
    pub limits: NostrLimits,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ParamsError {
    Version,
    OutputDomain,
    Rank,
    Identity,
    Variants,
    Weight,
    PairCap,
    Staleness,
    Work,
    Limits,
    Seed,
    DuplicateSeed,
}

impl Params {
    pub fn validate(&self) -> Result<(), ParamsError> {
        if self.version != PARAMS_VERSION {
            return Err(ParamsError::Version);
        }
        if self.output_domain != output_domain() {
            return Err(ParamsError::OutputDomain);
        }
        let scale = self.precision_scale;
        if scale != U256::from(PRECISION_SCALE)
            || self.total_pool.is_zero()
            || self.max_iterations == 0
            || self.max_iterations > MAX_ITERATIONS
            || self.damping_fp.is_zero()
            || self.damping_fp >= scale
            || self.tolerance_fp.is_zero()
            || self.tolerance_fp < U256::from(1_000_000u64)
            || self.tolerance_fp > scale / U256::from(1_000u64)
            || self.trust_share_fp > scale
            || self.trust_decay_fp > scale
        {
            return Err(ParamsError::Rank);
        }
        if self.community_id == [0; 16]
            || self.instance_domain == [0; 32]
            || self.relay_pubkey == [0; 32]
            || self.chain_id == 0
        {
            return Err(ParamsError::Identity);
        }
        if self.allowed_variants == 0 || self.allowed_variants & !0b11 != 0 {
            return Err(ParamsError::Variants);
        }
        if [
            self.w_vouch_fp,
            self.w_merge_fp,
            self.w_job_fp,
            self.w_forum_fp,
            self.relay_attested_weight_fp,
        ]
        .into_iter()
        .any(|weight| weight > scale)
        {
            return Err(ParamsError::Weight);
        }
        if self.forum_pair_cap == 0
            || self.job_pair_cap == 0
            || self.forum_pair_cap > self.limits.events
            || self.job_pair_cap > self.limits.events
        {
            return Err(ParamsError::PairCap);
        }
        if self.lane2_max_head_age == 0 {
            return Err(ParamsError::Staleness);
        }
        if self.max_anchor_records == 0 || self.max_anchor_records > 200_000 {
            return Err(ParamsError::Limits);
        }
        if self.max_estimated_pgu == 0 || self.max_estimated_pgu > 1_000_000_000 {
            return Err(ParamsError::Work);
        }
        self.limits.validate().map_err(|_| ParamsError::Limits)?;
        if self.limits.selected_heads == 0
            || self.limits.audit_entries == 0
            || self.limits.events == 0
            || self.limits.nip01_signatures == 0
        {
            return Err(ParamsError::Limits);
        }
        let seeds: BTreeSet<_> = self.trusted_seed_pubkeys.iter().copied().collect();
        if self.trusted_seed_pubkeys.len() > MAX_TRUSTED_SEEDS
            || self.trusted_seed_pubkeys.contains(&[0; 32])
        {
            return Err(ParamsError::Seed);
        }
        if seeds.len() != self.trusted_seed_pubkeys.len() {
            return Err(ParamsError::DuplicateSeed);
        }
        Ok(())
    }
}

pub fn seed_set_root(params: &Params) -> B256 {
    let mut ids: Vec<_> =
        params.trusted_seed_pubkeys.iter().map(nostr_envelope::nostr::nostr_node_id).collect();
    ids.sort_unstable();
    merkle::merkle_root(ids.into_iter().map(|id| keccak256(id.as_slice())).collect())
}

fn word_bytes16(value: &[u8; 16]) -> [u8; 32] {
    let mut word = [0; 32];
    word[..16].copy_from_slice(value);
    word
}

/// Frozen 39-word static ABI tuple. The Solidity and TypeScript codecs use this exact word order.
pub fn params_encoded(params: &Params) -> Vec<u8> {
    let mut bytes = Vec::with_capacity(32 * 39);
    bytes.extend_from_slice(&word_u32(PARAMS_SCHEMA_VERSION));
    bytes.extend_from_slice(&word_u32(params.version));
    bytes.extend_from_slice(params.output_domain.as_slice());
    bytes.extend_from_slice(&word_u256(params.damping_fp));
    bytes.extend_from_slice(&word_u256(params.tolerance_fp));
    bytes.extend_from_slice(&word_u32(params.max_iterations));
    bytes.extend_from_slice(&word_u256(params.trust_share_fp));
    bytes.extend_from_slice(&word_u256(params.trust_decay_fp));
    bytes.extend_from_slice(&word_u256(params.precision_scale));
    bytes.extend_from_slice(&word_u256(params.total_pool));
    bytes.extend_from_slice(seed_set_root(params).as_slice());
    bytes.extend_from_slice(&word_bytes16(&params.community_id));
    bytes.extend_from_slice(&params.instance_domain);
    bytes.extend_from_slice(&params.relay_pubkey);
    bytes.extend_from_slice(&word_u64(params.chain_id));
    bytes.extend_from_slice(&word_u8(params.allowed_variants));
    bytes.extend_from_slice(&word_u256(params.w_vouch_fp));
    bytes.extend_from_slice(&word_u256(params.w_merge_fp));
    bytes.extend_from_slice(&word_u256(params.w_job_fp));
    bytes.extend_from_slice(&word_u256(params.w_forum_fp));
    bytes.extend_from_slice(&word_u256(params.relay_attested_weight_fp));
    bytes.extend_from_slice(&word_u32(params.forum_pair_cap));
    bytes.extend_from_slice(&word_u32(params.job_pair_cap));
    bytes.extend_from_slice(&word_u64(params.lane2_max_head_age));
    bytes.extend_from_slice(&word_u32(params.max_anchor_records));
    bytes.extend_from_slice(&word_u64(params.max_estimated_pgu));
    let limits = params.limits;
    for limit in [
        limits.envelope_bytes,
        limits.selected_heads,
        limits.audit_entries,
        limits.events,
        limits.encoded_event_bytes,
        limits.content_bytes,
        limits.tags_per_event,
        limits.elements_per_tag,
        limits.tag_string_bytes,
        limits.all_tag_strings_bytes,
        limits.audit_detail_bytes,
        limits.nip01_signatures,
        limits.oa_signatures,
    ] {
        bytes.extend_from_slice(&word_u32(limit));
    }
    bytes
}

pub fn params_hash(params: &Params) -> B256 {
    keccak256(params_encoded(params))
}
