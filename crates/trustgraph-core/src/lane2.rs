//! Strict envelope-0 processing for hybrid Trustgraphs checkpoints.
//!
//! The witness carries the complete checkpointed anchor history and exactly one newest canonical
//! payload per anchored address node. Verification is all-or-nothing: every anchor authorization,
//! payload commitment, prefix head, EAS signature, and first-commit timestamp must verify. A
//! missing or malformed payload aborts; envelope 0 never emits Rule-Φ carried/dropped skips.

use crate::{Envelope0AnchorAuthorization, Envelope0PayloadWitness, Lane2Witness, Params, RawEdge};
use alloy_primitives::B256;
use eas_offchain_v2::{self as eas_offchain, payload_v1};
use std::collections::BTreeMap;
use zk_core::anchor::{anchor_leaf, SkipEntry};
use zk_core::fold::fold;

/// Envelope kind 0 = EAS-offchain chained log.
pub const ENVELOPE_EAS_OFFCHAIN: u8 = 0;

/// The two separators occupy the existing params array in this exact order. Keeping the empty
/// array unchanged preserves the lane-1-only params hash and ABI.
pub const EAS_DOMAIN_INDEX: usize = 0;
pub const HEAD_DOMAIN_INDEX: usize = 1;
pub const ENVELOPE0_DOMAIN_COUNT: usize = 2;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Lane2Error {
    Disabled,
    InvalidConfig,
    UnsupportedKind,
    MissingPayload,
    DuplicatePayload,
    ExtraneousPayload,
    MissingAuthorization,
    DuplicateAuthorization,
    ExtraneousAuthorization,
    StaleCount,
    SameCountConflict,
    PrefixFork,
    Payload(payload_v1::PayloadError),
}

impl Lane2Error {
    pub const fn code(self) -> &'static str {
        match self {
            Self::Disabled => "E0_DISABLED",
            Self::InvalidConfig => "E0_DISABLED",
            Self::UnsupportedKind => "E0_UNSUPPORTED_KIND",
            Self::MissingPayload | Self::ExtraneousPayload => "E0_AVAILABILITY",
            Self::DuplicatePayload => "E0_INTERNAL",
            Self::MissingAuthorization => "E0_HEAD_SIGNATURE",
            Self::DuplicateAuthorization | Self::ExtraneousAuthorization => "E0_INTERNAL",
            Self::StaleCount => "E0_STALE_COUNT",
            Self::SameCountConflict => "E0_SAME_COUNT_CONFLICT",
            Self::PrefixFork => "E0_PREFIX_FORK",
            Self::Payload(error) => error.code(),
        }
    }
}

impl From<payload_v1::PayloadError> for Lane2Error {
    fn from(value: payload_v1::PayloadError) -> Self {
        Self::Payload(value)
    }
}

/// The outcome committed to journal v3. `skips` is always empty for a valid envelope-0 proof.
#[derive(Clone, Debug, Default)]
pub struct Lane2Result {
    pub anchor_acc: B256,
    pub anchor_count: u64,
    /// Ordered by `(first-commit anchor fold index, log entry index)` before reconciliation.
    pub edges: Vec<RawEdge>,
    pub skips: Vec<SkipEntry>,
    /// Number of ECDSA verification calls performed by this exact witness.
    pub signature_checks: u64,
}

fn anchor_message(
    params: &Params,
    anchor: &crate::AnchorRecord,
    previous_head: B256,
) -> payload_v1::AnchorMessage {
    payload_v1::AnchorMessage {
        node_id: anchor.node_id,
        envelope_kind: anchor.envelope_kind,
        schema_uid: params.schema_uid,
        previous_head,
        head: anchor.head,
        count: anchor.count,
        data_commitment: anchor.data_commitment,
    }
}

/// Process the strict lane-2 witness. Any error must abort the guest computation.
pub fn process(params: &Params, witness: &Lane2Witness) -> Result<Lane2Result, Lane2Error> {
    if params.envelope0_domain_separators.is_empty() {
        return Err(Lane2Error::Disabled);
    }
    if params.envelope0_domain_separators.len() != ENVELOPE0_DOMAIN_COUNT
        || params.lane2_max_head_age != 0
    {
        return Err(Lane2Error::InvalidConfig);
    }
    let eas_domain = params.envelope0_domain_separators[EAS_DOMAIN_INDEX];
    let head_domain = params.envelope0_domain_separators[HEAD_DOMAIN_INDEX];

    // Reproduce the checkpointed anchor fold before interpreting any private metadata.
    let mut anchor_acc = B256::ZERO;
    let mut per_node: BTreeMap<B256, Vec<(usize, &crate::AnchorRecord)>> = BTreeMap::new();
    for (fold_index, anchor) in witness.anchors.iter().enumerate() {
        if anchor.envelope_kind != ENVELOPE_EAS_OFFCHAIN {
            return Err(Lane2Error::UnsupportedKind);
        }
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
        per_node.entry(anchor.node_id).or_default().push((fold_index, anchor));
    }

    let mut payloads: BTreeMap<B256, &Envelope0PayloadWitness> = BTreeMap::new();
    for payload in &witness.payloads {
        if payloads.insert(payload.node_id, payload).is_some() {
            return Err(Lane2Error::DuplicatePayload);
        }
    }
    let mut authorizations: BTreeMap<usize, &Envelope0AnchorAuthorization> = BTreeMap::new();
    for authorization in &witness.authorizations {
        let fold_index = usize::try_from(authorization.fold_index)
            .map_err(|_| Lane2Error::ExtraneousAuthorization)?;
        if authorizations.insert(fold_index, authorization).is_some() {
            return Err(Lane2Error::DuplicateAuthorization);
        }
    }
    if witness.anchors.is_empty() {
        if !payloads.is_empty() {
            return Err(Lane2Error::ExtraneousPayload);
        }
        if !authorizations.is_empty() {
            return Err(Lane2Error::ExtraneousAuthorization);
        }
        return Ok(Lane2Result::default());
    }

    let mut ordered_mutations: Vec<(usize, usize, RawEdge)> = Vec::new();
    let mut signature_checks = 0u64;

    for (node_id, anchors) in per_node {
        let payload_witness = payloads.remove(&node_id).ok_or(Lane2Error::MissingPayload)?;

        // Counts are strict registry transitions. Verify every typed authorization against the
        // deterministic predecessor, including historical records whose payload is not fetched.
        let mut previous_count = 0u64;
        let mut previous_head = B256::ZERO;
        for (fold_index, anchor) in &anchors {
            if anchor.count < previous_count {
                return Err(Lane2Error::StaleCount);
            }
            if anchor.count == previous_count {
                return Err(Lane2Error::SameCountConflict);
            }
            if anchor.count as usize > payload_v1::MAX_ENTRIES_PER_NODE {
                return Err(payload_v1::PayloadError::EntryLimit.into());
            }
            let message = anchor_message(params, anchor, previous_head);
            let authorization =
                authorizations.remove(fold_index).ok_or(Lane2Error::MissingAuthorization)?;
            let signer = payload_v1::verify_anchor_authorization(
                head_domain,
                &message,
                &authorization.head_signature,
            )?;
            signature_checks = signature_checks.saturating_add(1);
            if eas_offchain::address_node_id(signer) != node_id {
                return Err(payload_v1::PayloadError::NodeId.into());
            }
            previous_count = anchor.count;
            previous_head = anchor.head;
        }

        let (latest_fold_index, latest) =
            anchors.last().expect("a grouped anchor list is nonempty");
        let latest_previous_head =
            if anchors.len() == 1 { B256::ZERO } else { anchors[anchors.len() - 2].1.head };
        let latest_message = anchor_message(params, latest, latest_previous_head);
        // The authorization was already verified above; use the immutable witness vector again for
        // the payload verifier's single-record API.
        let latest_authorization = witness
            .authorizations
            .iter()
            .find(|authorization| authorization.fold_index == *latest_fold_index as u64)
            .ok_or(Lane2Error::MissingAuthorization)?;
        let context = payload_v1::VerificationContext {
            expected_schema: params.schema_uid,
            eas_domain_separator: eas_domain,
            head_domain_separator: head_domain,
            anchor: latest_message,
            anchor_timestamp: latest.block_timestamp,
            head_signature: &latest_authorization.head_signature,
        };
        let payload = payload_v1::verify(&payload_witness.payload, &context)?;
        // `verify` checks the latest head again in its single-record context, plus every
        // EAS-offchain attestation signature in the payload.
        signature_checks =
            signature_checks.saturating_add(1).saturating_add(payload.attestations.len() as u64);
        if payload_witness.node_id != eas_offchain::address_node_id(payload.owner) {
            return Err(payload_v1::PayloadError::NodeId.into());
        }

        // The newest payload must reproduce every earlier anchored prefix. This is what turns
        // independently valid higher-count heads into one append-only history.
        let prefixes = payload_v1::prefix_heads(&payload.entries);
        for (_, anchor) in &anchors {
            let prefix = prefixes
                .get(anchor.count as usize - 1)
                .ok_or(payload_v1::PayloadError::CountMismatch)?;
            if *prefix != anchor.head {
                return Err(Lane2Error::PrefixFork);
            }
        }

        // Emit the full authenticated mutation stream. Each entry's first-commit anchor supplies
        // the source position; revokes also take that anchor's timestamp as their effective time.
        let mut anchor_cursor = 0usize;
        let mut attestation_cursor = 0usize;
        let mut attestations_by_uid = BTreeMap::new();
        for (entry_index, entry) in payload.entries.iter().enumerate() {
            let entry_count = entry_index as u64 + 1;
            while anchors[anchor_cursor].1.count < entry_count {
                anchor_cursor += 1;
            }
            let (first_commit_fold, first_commit_anchor) = anchors[anchor_cursor];
            match entry.kind {
                eas_offchain::ENTRY_ATTEST => {
                    let attestation = payload
                        .attestations
                        .get(attestation_cursor)
                        .ok_or(payload_v1::PayloadError::CountMismatch)?;
                    attestation_cursor += 1;
                    if attestation.time > first_commit_anchor.block_timestamp {
                        return Err(payload_v1::PayloadError::FutureTime.into());
                    }
                    attestations_by_uid.insert(entry.uid, attestation);
                    ordered_mutations.push((
                        first_commit_fold,
                        entry_index,
                        RawEdge {
                            kind: eas_offchain::ENTRY_ATTEST,
                            attester: payload.owner,
                            recipient: attestation.recipient,
                            uid: entry.uid,
                            block_timestamp: attestation.time,
                            data: attestation.data.clone(),
                        },
                    ));
                }
                eas_offchain::ENTRY_REVOKE => {
                    let attestation = attestations_by_uid
                        .get(&entry.uid)
                        .ok_or(payload_v1::PayloadError::RevokeBeforeAttest)?;
                    ordered_mutations.push((
                        first_commit_fold,
                        entry_index,
                        RawEdge {
                            kind: eas_offchain::ENTRY_REVOKE,
                            attester: payload.owner,
                            recipient: attestation.recipient,
                            uid: entry.uid,
                            block_timestamp: first_commit_anchor.block_timestamp,
                            data: attestation.data.clone(),
                        },
                    ));
                }
                _ => return Err(payload_v1::PayloadError::LogKind.into()),
            }
        }
        if attestation_cursor != payload.attestations.len() {
            return Err(payload_v1::PayloadError::CountMismatch.into());
        }
    }

    if !payloads.is_empty() {
        return Err(Lane2Error::ExtraneousPayload);
    }
    if !authorizations.is_empty() {
        return Err(Lane2Error::ExtraneousAuthorization);
    }
    ordered_mutations.sort_by_key(|(fold_index, entry_index, _)| (*fold_index, *entry_index));
    let edges = ordered_mutations.into_iter().map(|(_, _, edge)| edge).collect();
    Ok(Lane2Result {
        anchor_acc,
        anchor_count: witness.anchors.len() as u64,
        edges,
        skips: Vec::new(),
        signature_checks,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tests::default_params;
    use crate::AnchorRecord;

    fn strict_params() -> Params {
        let mut params = default_params();
        params.envelope0_domain_separators = vec![B256::from([1; 32]), B256::from([2; 32])];
        params.lane2_max_head_age = 0;
        params
    }

    #[test]
    fn enabled_empty_witness_is_zero_lane() {
        let result = process(&strict_params(), &Lane2Witness::default()).unwrap();
        assert_eq!(result.anchor_acc, B256::ZERO);
        assert_eq!(result.anchor_count, 0);
        assert!(result.edges.is_empty() && result.skips.is_empty());
    }

    #[test]
    fn disabled_lane_rejects_a_lane2_witness() {
        assert_eq!(
            process(&default_params(), &Lane2Witness::default()).unwrap_err(),
            Lane2Error::Disabled
        );
    }

    #[test]
    fn anchored_node_without_payload_aborts() {
        let witness = Lane2Witness {
            anchors: vec![AnchorRecord {
                node_id: B256::from([0x11; 32]),
                envelope_kind: ENVELOPE_EAS_OFFCHAIN,
                head: B256::from([0x22; 32]),
                count: 1,
                data_commitment: B256::from([0x33; 32]),
                block_timestamp: 500,
            }],
            authorizations: vec![],
            payloads: vec![],
        };
        assert_eq!(process(&strict_params(), &witness).unwrap_err(), Lane2Error::MissingPayload);
    }
}
