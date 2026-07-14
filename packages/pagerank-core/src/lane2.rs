//! Lane-2 processing: re-fold the anchor log, apply rule Φ per node, verify envelopes, and
//! return the authenticated lane-2 edge set + the skip commitment inputs.
//!
//! Rule Φ (OFFCHAIN_ATTESTATIONS_ZK §7, IN the proven statement — ground rule 3): for each
//! anchored node the guest consumes the NEWEST anchored head whose data the prover supplied
//! and which verifies, provided it is at most `lane2_max_head_age` seconds staler than the
//! witnessed log's latest anchor timestamp (the deterministic "now", pinned by `anchorAcc`).
//! An older-but-usable head ⇒ `CARRIED` skip entry; nothing usable in the window ⇒ the
//! node's out-edges drop (`DROPPED`). In-edges from live nodes are untouched — reputation
//! *received* survives; reputation *given* requires showing up. Every deviation from
//! newest-head consumption lands in `skippedDigest`; a prover cannot silently pick.

use crate::{skip_reason, Lane2Witness, Params, RawEdge};
use alloy_primitives::B256;
use envelopes::eas_offchain::{self, Envelope0Config, Envelope0Witness};
use std::collections::BTreeMap;
use zk_core::anchor::{anchor_leaf, SkipEntry};
use zk_core::fold::fold;

/// Envelope kind 0 = EAS-offchain chained log (matches `AnchorRegistry` conventions).
pub const ENVELOPE_EAS_OFFCHAIN: u8 = 0;

/// The outcome of lane-2 processing, ready for the journal + reconciliation.
#[derive(Clone, Debug, Default)]
pub struct Lane2Result {
    pub anchor_acc: B256,
    pub anchor_count: u64,
    /// Authenticated lane-2 edges in (anchor fold index, in-log position) order — appended
    /// after lane-1 edges so reconciliation's `(timestamp, vec index)` total order realizes
    /// the cross-lane rule of OFFCHAIN §4.3.
    pub edges: Vec<RawEdge>,
    /// Rule-Φ skip entries, canonically sorted (ready for `zk_core::anchor::skipped_digest`).
    pub skips: Vec<SkipEntry>,
}

/// Process the lane-2 witness. Deterministic; per-node failures degrade, never abort.
pub fn process(params: &Params, witness: &Lane2Witness) -> Lane2Result {
    // 1. Re-fold the anchor log — this is what binds the witness to the checkpointed
    //    anchorAcc (the journal field the contract checks against storage).
    let mut acc = B256::ZERO;
    for a in &witness.anchors {
        acc = fold(
            acc,
            anchor_leaf(a.node_id, a.envelope_kind, a.head, a.data_commitment, a.block_timestamp),
        );
    }
    let anchor_count = witness.anchors.len() as u64;

    // 2. Deterministic "now": the latest anchor timestamp in the witnessed log.
    let now = witness.anchors.iter().map(|a| a.block_timestamp).max().unwrap_or(0);

    // 3. Group anchors per node in fold order (later fold index = newer claim).
    let mut per_node: BTreeMap<B256, Vec<&crate::AnchorRecord>> = BTreeMap::new();
    for a in &witness.anchors {
        per_node.entry(a.node_id).or_default().push(a);
    }

    // Envelope witnesses matched by owner-derived nodeId (first match wins, deterministic).
    let mut envs: BTreeMap<B256, &Envelope0Witness> = BTreeMap::new();
    for w in &witness.envelopes {
        envs.entry(eas_offchain::address_node_id(w.owner)).or_insert(w);
    }

    let config = Envelope0Config {
        accepted_domain_separators: params.envelope0_domain_separators.clone(),
        schema_uid: params.schema_uid,
    };

    let mut edges: Vec<RawEdge> = Vec::new();
    let mut skips: Vec<SkipEntry> = Vec::new();

    // 4. Rule Φ per node (BTreeMap iteration = deterministic node order).
    for (node_id, anchors) in &per_node {
        let newest_ts = anchors.last().map(|a| a.block_timestamp).unwrap_or(0);
        let mut consumed: Option<u64> = None; // timestamp of the head actually used

        // Newest → oldest: first head that is in-window, witnessed, and verifies.
        for a in anchors.iter().rev() {
            if now.saturating_sub(a.block_timestamp) > params.lane2_max_head_age {
                break; // older anchors are staler still
            }
            if a.envelope_kind != ENVELOPE_EAS_OFFCHAIN {
                continue; // unknown envelope: unusable head, try older
            }
            let Some(env) = envs.get(node_id) else { continue };
            match eas_offchain::verify(*node_id, a.head, now, &config, env) {
                Ok(authed) => {
                    for e in authed {
                        edges.push(RawEdge {
                            kind: 0,
                            attester: e.attester,
                            recipient: e.recipient,
                            uid: e.uid,
                            block_timestamp: e.time,
                            data: e.data,
                        });
                    }
                    consumed = Some(a.block_timestamp);
                    break;
                }
                Err(_) => continue, // provably unusable for THIS head; try an older one
            }
        }

        match consumed {
            Some(ts) if ts == newest_ts => {} // the newest head was consumed: no skip
            Some(ts) => skips.push(SkipEntry {
                node_id: *node_id,
                reason: skip_reason::CARRIED,
                epoch_observed: ts,
            }),
            None => skips.push(SkipEntry {
                node_id: *node_id,
                reason: skip_reason::DROPPED,
                epoch_observed: newest_ts,
            }),
        }
    }

    skips.sort();
    Lane2Result { anchor_acc: acc, anchor_count, edges, skips }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tests::default_params;
    use crate::AnchorRecord;
    use alloy_primitives::keccak256;

    #[test]
    fn empty_witness_is_zero_lane() {
        let p = default_params();
        let r = process(&p, &Lane2Witness::default());
        assert_eq!(r.anchor_acc, B256::ZERO);
        assert_eq!(r.anchor_count, 0);
        assert!(r.edges.is_empty() && r.skips.is_empty());
    }

    #[test]
    fn withheld_head_drops_node_and_records_skip() {
        let mut p = default_params();
        p.envelope0_domain_separators = vec![keccak256(b"d")];
        p.lane2_max_head_age = 1000;
        // One anchored head, no envelope witness supplied (data withheld).
        let w = Lane2Witness {
            anchors: vec![AnchorRecord {
                node_id: B256::from([0x11; 32]),
                envelope_kind: ENVELOPE_EAS_OFFCHAIN,
                head: B256::from([0x22; 32]),
                data_commitment: B256::ZERO,
                block_timestamp: 500,
            }],
            envelopes: vec![],
        };
        let r = process(&p, &w);
        assert_eq!(r.anchor_count, 1);
        assert_ne!(r.anchor_acc, B256::ZERO);
        assert!(r.edges.is_empty());
        assert_eq!(r.skips.len(), 1);
        assert_eq!(r.skips[0].reason, skip_reason::DROPPED);
        assert_eq!(r.skips[0].node_id, B256::from([0x11; 32]));
    }

    #[test]
    fn stale_head_outside_window_drops() {
        let mut p = default_params();
        p.envelope0_domain_separators = vec![keccak256(b"d")];
        p.lane2_max_head_age = 100;
        // Two anchors: an old one for node A and a fresh one for node B — B's anchor sets
        // "now", pushing A's only head out of the window.
        let w = Lane2Witness {
            anchors: vec![
                AnchorRecord {
                    node_id: B256::from([0xAA; 32]),
                    envelope_kind: ENVELOPE_EAS_OFFCHAIN,
                    head: B256::from([0x01; 32]),
                    data_commitment: B256::ZERO,
                    block_timestamp: 100,
                },
                AnchorRecord {
                    node_id: B256::from([0xBB; 32]),
                    envelope_kind: ENVELOPE_EAS_OFFCHAIN,
                    head: B256::from([0x02; 32]),
                    data_commitment: B256::ZERO,
                    block_timestamp: 500,
                },
            ],
            envelopes: vec![],
        };
        let r = process(&p, &w);
        // Both drop (no witnesses), but A's skip is bookkept at its newest head's ts.
        assert_eq!(r.skips.len(), 2);
        assert!(r.skips.iter().all(|s| s.reason == skip_reason::DROPPED));
    }
}
