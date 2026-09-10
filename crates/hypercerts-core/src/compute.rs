//! The hypercerts program's top-level computation: anchored repos + params → journal +
//! artifacts. Mirrors `pagerank_core::compute` in shape; this program is LANE-2-ONLY
//! (`acc = 0, leafCount = 0` — empty-lane-as-zero, the guest asserts it).
//!
//! Pipeline: re-fold the anchor log → select the latest head per node from committed history
//! (complete envelope-1 witness required when fresh) → decode records → §3 edge
//! semantics → key-generic Trust-Aware PageRank (pagerank-core's exact algorithm) →
//! point distribution → output tree with BOTH leaf domains (unified `keccak(nodeId,
//! value)` for every node; v1 address leaves additionally for bound actors so
//! address-keyed consumers work unchanged — MULTI_PROGRAM_PLATFORM §4).

use crate::semantics::{self, EdgeParams, RepoRecords};
use alloy_primitives::{keccak256, Address, B256, U256};
use envelopes::atproto::{self, AtprotoWitness};
use pagerank_core::distribute::distribute_points_generic;
use pagerank_core::pagerank::{calculate_generic_detailed, RankConfig};
use pagerank_core::{cid, merkle, skip_reason as phi_reason, AnchorRecord, Binding};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use zk_core::anchor::{anchor_leaf, skipped_digest, SkipEntry};
use zk_core::fold::fold;
use zk_core::words::{word_u256, word_u32, word_u64};

/// Envelope kind 1 = atproto repo commit (AnchorRegistry convention).
pub const ENVELOPE_ATPROTO: u8 = 1;
pub const PARAMS_SCHEMA_VERSION: u32 = 3;

/// The seven §2 collections, in walk order. FROZEN per lexicon pin =1.1.0; changing this
/// set is a guest change + vkey rotation (partner ask #4).
pub const COLLECTIONS: [&str; 7] = [
    "app.certified.graph.follow",
    "app.certified.badge.award",
    "app.certified.badge.response",
    "org.hypercerts.context.evaluation",
    "org.hypercerts.claim.activity",
    "org.hypercerts.context.acknowledgement",
    "app.certified.link.evm",
];

/// Governance-pinned parameters for the hypercerts program (§6.1). All `*_fp` fields are
/// fixed-point at `precision_scale` (1e18). The ABI tuple hashing to `paramsHash` is frozen
/// in [`params_hash`].
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Params {
    // Rank (inherited v1 values — §6.1 "no reason to diverge").
    pub damping_fp: U256,
    pub tolerance_fp: U256,
    pub max_iterations: u32,
    pub trust_share_fp: U256,
    pub trust_decay_fp: U256,
    pub precision_scale: U256,
    pub total_pool: U256,
    /// Partner-curated seed DIDs (v1 seed mechanism; hashed as sorted nodeId set root).
    pub trusted_seed_dids: Vec<String>,
    // Edge semantics (§6.1).
    pub w_follow_fp: U256,
    pub w_badge_fp: U256,
    pub w_eval_fp: U256,
    pub w_attrib_fp: U256,
    pub ack_boost_fp: U256,
    pub unacked_attrib_fp: U256,
    pub pds_attested_weight_fp: U256,
    /// Rule Φ staleness horizon in seconds (k epochs × epoch length).
    pub lane2_max_head_age: u64,
}

impl Params {
    pub fn edge_params(&self) -> EdgeParams {
        EdgeParams {
            w_follow_fp: self.w_follow_fp,
            w_badge_fp: self.w_badge_fp,
            w_eval_fp: self.w_eval_fp,
            w_attrib_fp: self.w_attrib_fp,
            ack_boost_fp: self.ack_boost_fp,
            unacked_attrib_fp: self.unacked_attrib_fp,
            pds_attested_weight_fp: self.pds_attested_weight_fp,
        }
    }
}

/// The hypercerts `paramsHash` — 17 static words, FROZEN (golden-locked four ways):
/// `abi.encode(schemaVersion, damping, tolerance, maxIterations, trustShare, trustDecay,
///  precisionScale, totalPool, seedSetRoot, wFollow, wBadge, wEval, wAttrib, ackBoost,
///  unackedAttrib, pdsAttestedWeight, lane2MaxHeadAge)` where `seedSetRoot` is the OZ
/// standard tree over the SORTED seed nodeIds (leaf = keccak256(nodeId) — one hash over
/// the 32-byte id, mirroring the address-seed discipline).
pub fn params_hash(p: &Params) -> B256 {
    let mut seed_ids: Vec<B256> =
        p.trusted_seed_dids.iter().map(|d| semantics::did_node_id(d)).collect();
    seed_ids.sort();
    let leaves: Vec<B256> = seed_ids.iter().map(|id| keccak256(id.as_slice())).collect();
    let seed_set_root = merkle::merkle_root(leaves);

    let mut buf = Vec::with_capacity(32 * 17);
    buf.extend_from_slice(&word_u32(PARAMS_SCHEMA_VERSION));
    buf.extend_from_slice(&word_u256(p.damping_fp));
    buf.extend_from_slice(&word_u256(p.tolerance_fp));
    buf.extend_from_slice(&word_u32(p.max_iterations));
    buf.extend_from_slice(&word_u256(p.trust_share_fp));
    buf.extend_from_slice(&word_u256(p.trust_decay_fp));
    buf.extend_from_slice(&word_u256(p.precision_scale));
    buf.extend_from_slice(&word_u256(p.total_pool));
    buf.extend_from_slice(seed_set_root.as_slice());
    buf.extend_from_slice(&word_u256(p.w_follow_fp));
    buf.extend_from_slice(&word_u256(p.w_badge_fp));
    buf.extend_from_slice(&word_u256(p.w_eval_fp));
    buf.extend_from_slice(&word_u256(p.w_attrib_fp));
    buf.extend_from_slice(&word_u256(p.ack_boost_fp));
    buf.extend_from_slice(&word_u256(p.unacked_attrib_fp));
    buf.extend_from_slice(&word_u256(p.pds_attested_weight_fp));
    buf.extend_from_slice(&word_u64(p.lane2_max_head_age));
    keccak256(&buf)
}

/// The complete input the hypercerts guest receives.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct GuestInput {
    pub params: Params,
    /// The complete anchor log in fold order (re-folds to the checkpointed `anchorAcc`).
    pub anchors: Vec<AnchorRecord>,
    /// Envelope-1 witnesses the prover could supply, matched by DID-derived nodeId.
    pub witnesses: Vec<AtprotoWitness>,
    /// Content-verified strongRef target blocks (badge definitions), keyed by CID string.
    #[serde(default)]
    pub strongref_targets: BTreeMap<String, Vec<u8>>,
    /// Journal-v3 pass-through commitments (payee + instance domain), identical in every program.
    /// `instance_domain` is what gives this program domain separation at all: its `Params` carry
    /// no instance-unique field, so before v3 two identically-configured hypercerts instances
    /// accepted each other's proofs (issue #9).
    #[serde(default)]
    pub binding: Binding,
}

/// Journal v3 — identical 12-field shape as every instance (lane 1 empty for hypercerts).
pub use pagerank_core::Journal;

/// Full result: journal + artifacts the host pins/serves.
#[derive(Clone, Debug)]
pub struct ComputeResult {
    pub journal: Journal,
    /// `{nodeId -> value}` for nodes with `value > 0`, sorted ascending by nodeId.
    pub scores: Vec<(B256, U256)>,
    /// Bound-actor address per nodeId (drives the extra v1 address leaves).
    pub bindings: BTreeMap<B256, Address>,
    /// The skippedDigest PREIMAGE (canonically sorted skip entries) — published alongside
    /// the proof so watchers audit rule-Φ/record skips without recomputing the epoch.
    pub skips: Vec<SkipEntry>,
    pub blob: Vec<u8>,
    pub cid: String,
    pub rank: pagerank_core::RankTelemetry,
}

use zk_core::cid::canonical_node_blob as canonical_blob;

pub use zk_core::merkle::node_output_leaf;

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ComputeError {
    UnsupportedEnvelope,
    DuplicateWitness(B256),
    OrphanWitness(B256),
    MissingWitness(B256),
    InvalidWitness(B256, envelopes::EnvelopeError),
    InvalidRecordKey,
    Semantics(semantics::SemanticsError),
}

impl core::fmt::Display for ComputeError {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        write!(f, "{self:?}")
    }
}
impl std::error::Error for ComputeError {}

/// Run the full hypercerts pipeline. Deterministic and float-free.
pub fn compute(input: &GuestInput) -> Result<ComputeResult, ComputeError> {
    if input.anchors.iter().any(|anchor| anchor.envelope_kind != ENVELOPE_ATPROTO) {
        return Err(ComputeError::UnsupportedEnvelope);
    }
    let p = &input.params;
    let ph = params_hash(p);

    // 1. Re-fold the anchor log (binds the witness to the checkpointed anchorAcc).
    let mut anchor_acc = B256::ZERO;
    for a in &input.anchors {
        // `count` rides the leaf (H-5 fix, shared encoding). For envelope-1 (atproto) nodes it
        // is a claimed ordinal — registrar-gated at ingress, not signature-verified — so this
        // program's rule Φ deliberately does NOT rank by it yet; ranking stays anchor-order
        // until the atproto rev is bound the way envelope 0 binds its log length (E2-adjacent
        // design work, tracked in the outstanding report's lane-2 mediums).
        anchor_acc = fold(
            anchor_acc,
            anchor_leaf(
                a.node_id,
                a.envelope_kind,
                a.head,
                a.count,
                a.data_commitment,
                a.block_timestamp,
            ),
        );
    }
    let anchor_count = input.anchors.len() as u64;

    // 2. Canonical newest head per node (deterministic "now" = latest anchor ts).
    let now = input.anchors.iter().map(|a| a.block_timestamp).max().unwrap_or(0);
    // (global fold index, anchor) per node — the fold index is the cross-repo tie-break.
    let mut per_node: BTreeMap<B256, Vec<(u64, &AnchorRecord)>> = BTreeMap::new();
    for (i, a) in input.anchors.iter().enumerate() {
        per_node.entry(a.node_id).or_default().push((i as u64, a));
    }
    let mut by_node_id: BTreeMap<B256, &AtprotoWitness> = BTreeMap::new();
    for w in &input.witnesses {
        let node_id = atproto::did_node_id(&w.did);
        if !per_node.contains_key(&node_id) {
            return Err(ComputeError::OrphanWitness(node_id));
        }
        if by_node_id.insert(node_id, w).is_some() {
            return Err(ComputeError::DuplicateWitness(node_id));
        }
    }

    let mut skips: Vec<SkipEntry> = Vec::new();
    let mut repos: Vec<RepoRecords> = Vec::new();
    let cols: Vec<&str> = COLLECTIONS.to_vec();

    for (node_id, anchors) in &per_node {
        let (fold_idx, anchor) = anchors.last().expect("nonempty anchor group");
        // Staleness depends only on public anchor times; missing private data never creates
        // a skip or selects an earlier repo version.
        if now.saturating_sub(anchor.block_timestamp) > p.lane2_max_head_age {
            skips.push(SkipEntry {
                node_id: *node_id,
                reason: phi_reason::DROPPED,
                epoch_observed: anchor.block_timestamp,
            });
            continue;
        }
        let witness = by_node_id.get(node_id).ok_or(ComputeError::MissingWitness(*node_id))?;
        let records = atproto::verify(*node_id, anchor.head, now, &cols, witness)
            .map_err(|error| ComputeError::InvalidWitness(*node_id, error))?;
        repos.push(RepoRecords {
            did: witness.did.clone(),
            anchor_fold_index: *fold_idx,
            records: records
                .into_iter()
                .map(|record| {
                    let key = String::from_utf8(record.key)
                        .map_err(|_| ComputeError::InvalidRecordKey)?;
                    Ok((key, record.record_bytes))
                })
                .collect::<Result<_, ComputeError>>()?,
        });
    }

    // 3. §3 edge semantics (adds its own deterministic record-level skips).
    let graph = semantics::derive(&repos, &input.strongref_targets, &p.edge_params())
        .map_err(ComputeError::Semantics)?;
    skips.extend(graph.skips.iter().copied());

    // 4. Rank (the exact pagerank-core algorithm, B256-keyed) + distribute.
    let seeds: BTreeSet<B256> =
        p.trusted_seed_dids.iter().map(|d| semantics::did_node_id(d)).collect();
    let cfg = RankConfig {
        damping_fp: p.damping_fp,
        tolerance_fp: p.tolerance_fp,
        max_iterations: p.max_iterations,
        trust_share_fp: p.trust_share_fp,
        trust_decay_fp: p.trust_decay_fp,
        scale: p.precision_scale,
        seeds,
    };
    let rank_result = calculate_generic_detailed(&graph.nodes, &graph.outgoing, &cfg);
    let rank = rank_result.telemetry(p.max_iterations);
    let scores_fp = rank_result.scores;
    let filtered: Vec<(B256, U256)> = scores_fp.into_iter().filter(|(_, v)| !v.is_zero()).collect();
    let (mut assigned, total_value) =
        distribute_points_generic(&filtered, p.precision_scale, p.total_pool);
    assigned.sort_by(|a, b| a.0.cmp(&b.0));

    // 5. Output tree: unified nodeId leaves for every scored node, PLUS v1 address leaves
    //    for bound actors (address-keyed consumers work unchanged).
    let mut leaves: Vec<B256> = assigned.iter().map(|(id, v)| node_output_leaf(*id, *v)).collect();
    for (id, v) in &assigned {
        if let Some(addr) = graph.bindings.get(id) {
            leaves.push(merkle::output_leaf(*addr, *v));
        }
    }
    let output_root = merkle::merkle_root(leaves);

    // 6. Canonical blob + CID (nodeId-keyed).
    let blob = canonical_blob(&assigned);
    let digest = cid::sha256(&blob);
    let ipfs_hash = B256::from(digest);
    let cid_str = cid::cid_v1_raw(&digest);
    let cid_digest = keccak256(cid_str.as_bytes());

    // 7. Journal v3, lane-2-only shape: lane 1 is the zero accumulator; the two v3 bindings pass
    //    straight through from the witness.
    skips.sort();
    let skipped = skipped_digest(&skips);
    let journal = Journal {
        acc: B256::ZERO,
        leaf_count: 0,
        anchor_acc,
        anchor_count,
        params_hash: ph,
        output_root,
        ipfs_hash,
        cid_digest,
        total_value,
        skipped_digest: skipped,
        recipient: input.binding.recipient,
        instance_domain: input.binding.instance_domain,
    };
    Ok(ComputeResult {
        journal,
        scores: assigned,
        bindings: graph.bindings,
        skips,
        blob,
        cid: cid_str,
        rank,
    })
}
