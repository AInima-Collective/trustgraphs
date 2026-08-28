//! Full lane-2 computation: anchor fold, rule Φ, mixed A/C event semantics, rank, and journal v3.

use std::collections::{BTreeMap, BTreeSet};

use alloy_primitives::{keccak256, Address, B256, U256};
use nostr_envelope::nostr::tgnw::{self, TgnwBundle};
use nostr_envelope::nostr::{
    estimated_pgu, verify_cached, CommitmentVariant, EventDisposition, NostrAnchor,
    NostrVerifyConfig, VerificationCache,
};
use pagerank_core::distribute::distribute_points_generic;
use pagerank_core::pagerank::{calculate_generic_detailed, RankConfig};
use pagerank_core::{cid, merkle, AnchorRecord, Binding, Journal};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use zk_core::anchor::{anchor_leaf, skipped_digest, SkipEntry};
use zk_core::fold::fold;

use crate::params::{params_hash, Params, ParamsError};
use crate::semantics::{self, Provenance, SemanticEvent};

pub const ENVELOPE_NOSTR: u8 = 2;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct HeadWitness {
    pub bytes: Vec<u8>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct GuestInput {
    pub params: Params,
    pub anchors: Vec<AnchorRecord>,
    pub witnesses: Vec<HeadWitness>,
    #[serde(default)]
    pub binding: Binding,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ComputeError {
    Params(ParamsError),
    UnsupportedEnvelope,
    DuplicateWitness,
    OrphanWitness,
    LimitExceeded,
    WorkExceeded,
    State,
}

impl From<ParamsError> for ComputeError {
    fn from(value: ParamsError) -> Self {
        Self::Params(value)
    }
}

#[derive(Clone, Debug)]
pub struct ComputeResult {
    pub journal: Journal,
    /// Deduplicated, globally-resolved authenticated rows consumed by semantic derivation.
    pub events: Vec<SemanticEvent>,
    pub scores: Vec<(B256, U256)>,
    pub outgoing: BTreeMap<B256, BTreeMap<B256, U256>>,
    pub roster: Vec<[u8; 32]>,
    pub agents: Vec<semantics::AgentLink>,
    pub bindings: BTreeMap<B256, Address>,
    pub skips: Vec<SkipEntry>,
    pub blob: Vec<u8>,
    pub cid: String,
    pub rank: pagerank_core::RankTelemetry,
    /// Exact number of guest cryptographic signature-verification attempts accounted by the
    /// authenticated Nostr work meter (NIP-01 plus OpenAgents authorization signatures).
    pub signature_checks: u64,
}

struct DecodedWitness {
    bytes: Vec<u8>,
    bundle: Option<TgnwBundle>,
}

struct SelectedHead {
    anchor_index: u64,
    observed_at: u64,
    verified: nostr_envelope::nostr::VerifiedNostrEnvelope,
}

fn witness_commitment(bytes: &[u8]) -> B256 {
    B256::from(<[u8; 32]>::from(Sha256::digest(bytes)))
}

use zk_core::cid::canonical_node_blob as canonical_blob;

pub use zk_core::merkle::node_output_leaf;

fn provenance(variant: CommitmentVariant) -> Provenance {
    match variant {
        CommitmentVariant::BuzzAuditV1 => Provenance::RelayAttested,
        CommitmentVariant::SelfLogV1 => Provenance::SelfCommitted,
    }
}

pub fn compute(input: &GuestInput) -> Result<ComputeResult, ComputeError> {
    input.params.validate()?;
    let params = &input.params;
    if input.anchors.len() > params.max_anchor_records as usize
        || input.witnesses.len() > params.limits.selected_heads as usize
    {
        return Err(ComputeError::LimitExceeded);
    }
    if input.anchors.iter().any(|anchor| anchor.envelope_kind != ENVELOPE_NOSTR) {
        return Err(ComputeError::UnsupportedEnvelope);
    }

    let mut anchor_acc = B256::ZERO;
    let mut anchored_commitments = BTreeSet::new();
    let mut per_node = BTreeMap::<B256, Vec<(u64, &AnchorRecord)>>::new();
    for (index, anchor) in input.anchors.iter().enumerate() {
        anchor_acc = fold(
            anchor_acc,
            anchor_leaf(
                anchor.node_id,
                anchor.envelope_kind,
                anchor.head,
                anchor.count,
                anchor.data_commitment,
                anchor.block_timestamp,
            ),
        );
        anchored_commitments.insert(anchor.data_commitment);
        per_node.entry(anchor.node_id).or_default().push((index as u64, anchor));
    }

    // Decode and account for every supplied candidate before any expensive signature work.
    let total_bytes = input
        .witnesses
        .iter()
        .try_fold(0u64, |total, witness| total.checked_add(witness.bytes.len() as u64))
        .ok_or(ComputeError::LimitExceeded)?;
    if total_bytes > u64::from(params.limits.envelope_bytes) {
        return Err(ComputeError::LimitExceeded);
    }
    let mut decoded = BTreeMap::<B256, DecodedWitness>::new();
    let mut audit_entries = 0u64;
    let mut event_ids = BTreeSet::new();
    let mut oa_attempts_by_event = BTreeMap::<[u8; 32], u64>::new();
    for witness in &input.witnesses {
        let commitment = witness_commitment(&witness.bytes);
        if !anchored_commitments.contains(&commitment) {
            return Err(ComputeError::OrphanWitness);
        }
        let bundle = tgnw::decode(&witness.bytes, &params.limits).ok();
        if let Some(bundle) = &bundle {
            audit_entries = audit_entries
                .checked_add(bundle.audit.len() as u64)
                .ok_or(ComputeError::LimitExceeded)?;
            for event in bundle.events.iter().chain(bundle.head_event.iter()) {
                event_ids.insert(event.id);
                let attempts = event
                    .tags
                    .iter()
                    .filter(|tag| tag.first().map(String::as_str) == Some("auth"))
                    .count() as u64;
                oa_attempts_by_event
                    .entry(event.id)
                    .and_modify(|current| *current = (*current).max(attempts))
                    .or_insert(attempts);
            }
        }
        if decoded
            .insert(commitment, DecodedWitness { bytes: witness.bytes.clone(), bundle })
            .is_some()
        {
            return Err(ComputeError::DuplicateWitness);
        }
    }
    let event_occurrences = event_ids.len() as u64;
    let oa_occurrences = oa_attempts_by_event.values().try_fold(0u64, |total, attempts| {
        total.checked_add(*attempts).ok_or(ComputeError::LimitExceeded)
    })?;
    if audit_entries > u64::from(params.limits.audit_entries)
        || event_occurrences > u64::from(params.limits.nip01_signatures)
        || oa_occurrences > u64::from(params.limits.oa_signatures)
    {
        return Err(ComputeError::LimitExceeded);
    }
    let estimated = estimated_pgu(total_bytes, audit_entries, event_occurrences, oa_occurrences)
        .ok_or(ComputeError::WorkExceeded)?;
    if estimated > params.max_estimated_pgu {
        return Err(ComputeError::WorkExceeded);
    }

    let now = input.anchors.iter().map(|anchor| anchor.block_timestamp).max().unwrap_or(0);
    let config = NostrVerifyConfig {
        community_id: params.community_id,
        instance_domain: params.instance_domain,
        relay_pubkey: params.relay_pubkey,
        allowed_variants: params.allowed_variants,
        limits: params.limits,
    };
    let mut selected = Vec::new();
    let mut skips = Vec::new();
    let mut verification_cache = VerificationCache::default();
    for (node, anchors) in &per_node {
        let max_count = anchors.iter().map(|(_, anchor)| anchor.count).max().unwrap_or(0);
        let newest = anchors
            .iter()
            .rev()
            .find(|(_, anchor)| anchor.count == max_count)
            .expect("nonempty anchor group");
        let mut chosen = None;
        for (index, anchor) in anchors.iter().rev() {
            if now.saturating_sub(anchor.block_timestamp) > params.lane2_max_head_age {
                break;
            }
            // H-5: a lower signed count is a stale replay, never a carry-forward candidate.
            if anchor.count < max_count {
                continue;
            }
            let Some(witness) = decoded.get(&anchor.data_commitment) else {
                continue;
            };
            let Some(bundle) = &witness.bundle else {
                continue;
            };
            let claim = NostrAnchor {
                node_id: anchor.node_id,
                head: anchor.head,
                count: anchor.count,
                data_commitment: anchor.data_commitment,
            };
            if let Ok(verified) =
                verify_cached(&claim, &config, &witness.bytes, &mut verification_cache)
            {
                debug_assert_eq!(
                    tgnw::encode(bundle).ok().as_deref(),
                    Some(witness.bytes.as_slice())
                );
                chosen = Some(SelectedHead {
                    anchor_index: *index,
                    observed_at: anchor.block_timestamp,
                    verified,
                });
                break;
            }
        }
        match chosen {
            Some(head) => {
                if head.anchor_index != newest.0 {
                    skips.push(SkipEntry {
                        node_id: *node,
                        reason: pagerank_core::skip_reason::CARRIED,
                        epoch_observed: head.observed_at,
                    });
                }
                selected.push(head);
            }
            None => skips.push(SkipEntry {
                node_id: *node,
                reason: pagerank_core::skip_reason::DROPPED,
                epoch_observed: newest.1.block_timestamp,
            }),
        }
    }
    if selected.len() > params.limits.selected_heads as usize {
        return Err(ComputeError::LimitExceeded);
    }

    // Deduplicate by signed event id before global state. C is stronger than A; equal provenance
    // keeps the earliest committed occurrence so replaying the same event cannot reorder a lifecycle.
    let mut dedup = BTreeMap::<[u8; 32], SemanticEvent>::new();
    for head in &selected {
        let provenance = provenance(head.verified.variant);
        for (position, outcome) in head.verified.outcomes.iter().enumerate() {
            let candidate = SemanticEvent {
                event: outcome.event.clone(),
                oa_owner: outcome.oa_owner,
                disposition: EventDisposition::Accepted,
                provenance,
                order: (head.anchor_index, position as u32),
                observed_at: head.observed_at,
            };
            match dedup.get_mut(&candidate.event.id) {
                Some(current) => {
                    current.provenance = current.provenance.max(candidate.provenance);
                    if candidate.order < current.order {
                        current.order = candidate.order;
                        current.observed_at = candidate.observed_at;
                    }
                }
                None => {
                    dedup.insert(candidate.event.id, candidate);
                }
            }
        }
    }
    if dedup.len() > params.limits.events as usize {
        return Err(ComputeError::LimitExceeded);
    }
    let mut semantic_events: Vec<_> = dedup.into_values().collect();
    semantic_events.sort_by_key(|event| (event.order, event.event.id));
    let has_roster = semantic_events.iter().any(|event| event.event.kind == 13_534);
    let (outcomes, roster) = if has_roster {
        let state_input = semantic_events.iter().map(|event| event.event.clone()).collect();
        nostr_envelope::nostr::state::resolve(state_input, &params.relay_pubkey)
            .map_err(|_| ComputeError::State)?
    } else {
        let outcomes = semantic_events
            .iter()
            .map(|event| nostr_envelope::nostr::EventOutcome {
                event: event.event.clone(),
                oa_owner: None,
                disposition: EventDisposition::Skipped(
                    nostr_envelope::nostr::SkipReason::RosterNonMember,
                ),
            })
            .collect();
        (outcomes, BTreeSet::new())
    };
    let by_outcome: BTreeMap<_, _> =
        outcomes.into_iter().map(|outcome| (outcome.event.id, outcome)).collect();
    for event in &mut semantic_events {
        let outcome = by_outcome.get(&event.event.id).ok_or(ComputeError::State)?;
        event.oa_owner = outcome.oa_owner;
        event.disposition = outcome.disposition;
    }

    let graph = semantics::derive(&semantic_events, &roster, params);
    skips.extend(graph.skips.iter().copied());
    skips.sort();

    let node_set: BTreeSet<_> = graph.nodes.iter().copied().collect();
    let seeds = params
        .trusted_seed_pubkeys
        .iter()
        .map(nostr_envelope::nostr::nostr_node_id)
        .filter(|seed| node_set.contains(seed))
        .collect();
    let rank = RankConfig {
        damping_fp: params.damping_fp,
        tolerance_fp: params.tolerance_fp,
        max_iterations: params.max_iterations,
        trust_share_fp: params.trust_share_fp,
        trust_decay_fp: params.trust_decay_fp,
        scale: params.precision_scale,
        seeds,
    };
    let rank_result = calculate_generic_detailed(&graph.nodes, &graph.outgoing, &rank);
    let rank_telemetry = rank_result.telemetry(params.max_iterations);
    let scores_fp = rank_result.scores;
    let filtered: Vec<_> = scores_fp.into_iter().filter(|(_, value)| !value.is_zero()).collect();
    let (mut scores, total_value) =
        distribute_points_generic(&filtered, params.precision_scale, params.total_pool);
    scores.sort_by_key(|(node, _)| *node);

    let mut leaves: Vec<_> =
        scores.iter().map(|(node, value)| node_output_leaf(*node, *value)).collect();
    for (node, value) in &scores {
        if let Some(address) = graph.bindings.get(node) {
            leaves.push(merkle::output_leaf(*address, *value));
        }
    }
    let output_root = merkle::merkle_root(leaves);
    let blob = canonical_blob(&scores);
    let digest = cid::sha256(&blob);
    let ipfs_hash = B256::from(digest);
    let cid = cid::cid_v1_raw(&digest);
    let journal = Journal {
        acc: B256::ZERO,
        leaf_count: 0,
        anchor_acc,
        anchor_count: input.anchors.len() as u64,
        params_hash: params_hash(params),
        output_root,
        ipfs_hash,
        cid_digest: keccak256(cid.as_bytes()),
        total_value,
        skipped_digest: skipped_digest(&skips),
        recipient: input.binding.recipient,
        instance_domain: input.binding.instance_domain,
    };
    Ok(ComputeResult {
        journal,
        events: semantic_events,
        scores,
        outgoing: graph.outgoing,
        roster: roster.into_iter().collect(),
        agents: graph.agents,
        bindings: graph.bindings,
        skips,
        blob,
        cid,
        rank: rank_telemetry,
        signature_checks: event_occurrences.saturating_add(oa_occurrences),
    })
}
