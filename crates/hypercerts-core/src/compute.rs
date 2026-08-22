//! The hypercerts program's top-level computation: anchored repos + params → journal +
//! artifacts. Mirrors `pagerank_core::compute` in shape; this program is LANE-2-ONLY
//! (`acc = 0, leafCount = 0` — empty-lane-as-zero, the guest asserts it).
//!
//! Pipeline: re-fold the anchor log → rule Φ per node (newest usable head within the
//! staleness window; envelope-1 verification per head) → decode records → §3 edge
//! semantics → key-generic Trust-Aware PageRank (pagerank-core's exact algorithm) →
//! point distribution → output tree with BOTH leaf domains (unified `keccak(nodeId,
//! value)` for every node; v1 address leaves additionally for bound actors so
//! address-keyed consumers work unchanged — MULTI_PROGRAM_PLATFORM §4).

use crate::semantics::{self, EdgeParams, RepoRecords};
use alloy_primitives::{keccak256, Address, B256, U256};
use envelopes::atproto::{self, AtprotoWitness};
use pagerank_core::distribute::distribute_points_generic;
use pagerank_core::pagerank::{calculate_generic, RankConfig};
use pagerank_core::{cid, merkle, skip_reason as phi_reason, AnchorRecord, Binding};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use zk_core::anchor::{anchor_leaf, skipped_digest, SkipEntry};
use zk_core::fold::fold;
use zk_core::words::{word_u256, word_u32, word_u64};

/// Envelope kind 1 = atproto repo commit (AnchorRegistry convention).
pub const ENVELOPE_ATPROTO: u8 = 1;

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
    pub trust_multiplier_fp: U256,
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
/// `abi.encode(damping, tolerance, maxIterations, trustMultiplier, trustShare, trustDecay,
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
    buf.extend_from_slice(&word_u256(p.damping_fp));
    buf.extend_from_slice(&word_u256(p.tolerance_fp));
    buf.extend_from_slice(&word_u32(p.max_iterations));
    buf.extend_from_slice(&word_u256(p.trust_multiplier_fp));
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
    /// the proof so watchers audit rule-Φ/record skips without recomputing the epoch
    /// (GOAL "Done when" #3).
    pub skips: Vec<SkipEntry>,
    pub blob: Vec<u8>,
    pub cid: String,
}

/// The canonical hypercerts blob: `{"0x<nodeId>":"<decimal>",...}` sorted ascending —
/// same shape as v1's blob with 32-byte node ids in place of addresses.
fn canonical_blob(scores: &[(B256, U256)]) -> Vec<u8> {
    let mut s = String::from("{");
    for (i, (id, value)) in scores.iter().enumerate() {
        if i > 0 {
            s.push(',');
        }
        s.push('"');
        s.push_str("0x");
        s.push_str(&alloy_primitives::hex::encode(id.as_slice()));
        s.push_str("\":\"");
        s.push_str(&value.to_string());
        s.push('"');
    }
    s.push('}');
    s.into_bytes()
}

/// The unified output leaf: `keccak256(bytes.concat(keccak256(abi.encode(bytes32 nodeId,
/// uint256 value))))` — the nodeId twin of `merkle::output_leaf` (OFFCHAIN §5).
pub fn node_output_leaf(node_id: B256, value: U256) -> B256 {
    let mut buf = [0u8; 64];
    buf[..32].copy_from_slice(node_id.as_slice());
    buf[32..].copy_from_slice(&word_u256(value));
    let inner = keccak256(buf);
    keccak256(inner.as_slice())
}

/// Run the full hypercerts pipeline. Deterministic and float-free.
pub fn compute(input: &GuestInput) -> ComputeResult {
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

    // 2. Rule Φ per node over envelope-1 heads (deterministic "now" = latest anchor ts).
    let now = input.anchors.iter().map(|a| a.block_timestamp).max().unwrap_or(0);
    // (global fold index, anchor) per node — the fold index is the cross-repo tie-break.
    let mut per_node: BTreeMap<B256, Vec<(u64, &AnchorRecord)>> = BTreeMap::new();
    for (i, a) in input.anchors.iter().enumerate() {
        per_node.entry(a.node_id).or_default().push((i as u64, a));
    }
    let mut by_node_id: BTreeMap<B256, &AtprotoWitness> = BTreeMap::new();
    for w in &input.witnesses {
        by_node_id.entry(atproto::did_node_id(&w.did)).or_insert(w);
    }

    let mut skips: Vec<SkipEntry> = Vec::new();
    let mut repos: Vec<RepoRecords> = Vec::new();
    let cols: Vec<&str> = COLLECTIONS.to_vec();

    for (node_id, anchors) in &per_node {
        let newest_ts = anchors.last().map(|(_, a)| a.block_timestamp).unwrap_or(0);
        let mut consumed: Option<u64> = None;
        for (fold_idx, a) in anchors.iter().rev() {
            if now.saturating_sub(a.block_timestamp) > p.lane2_max_head_age {
                break;
            }
            if a.envelope_kind != ENVELOPE_ATPROTO {
                continue;
            }
            let Some(w) = by_node_id.get(node_id) else { continue };
            match atproto::verify(*node_id, a.head, now, &cols, w) {
                Ok(records) => {
                    repos.push(RepoRecords {
                        did: w.did.clone(),
                        anchor_fold_index: *fold_idx,
                        records: records
                            .into_iter()
                            .map(|r| (String::from_utf8_lossy(&r.key).into_owned(), r.record_bytes))
                            .collect(),
                    });
                    consumed = Some(a.block_timestamp);
                    break;
                }
                Err(_) => continue,
            }
        }
        match consumed {
            Some(ts) if ts == newest_ts => {}
            Some(ts) => skips.push(SkipEntry {
                node_id: *node_id,
                reason: phi_reason::CARRIED,
                epoch_observed: ts,
            }),
            None => skips.push(SkipEntry {
                node_id: *node_id,
                reason: phi_reason::DROPPED,
                epoch_observed: newest_ts,
            }),
        }
    }

    // 3. §3 edge semantics (adds its own deterministic record-level skips).
    let graph = semantics::derive(&repos, &input.strongref_targets, &p.edge_params());
    skips.extend(graph.skips.iter().copied());

    // 4. Rank (the exact pagerank-core algorithm, B256-keyed) + distribute.
    let seeds: BTreeSet<B256> =
        p.trusted_seed_dids.iter().map(|d| semantics::did_node_id(d)).collect();
    let cfg = RankConfig {
        damping_fp: p.damping_fp,
        tolerance_fp: p.tolerance_fp,
        max_iterations: p.max_iterations,
        trust_multiplier_fp: p.trust_multiplier_fp,
        trust_share_fp: p.trust_share_fp,
        trust_decay_fp: p.trust_decay_fp,
        scale: p.precision_scale,
        seeds,
    };
    let scores_fp = calculate_generic(&graph.nodes, &graph.outgoing, &cfg);
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
    ComputeResult { journal, scores: assigned, bindings: graph.bindings, skips, blob, cid: cid_str }
}
