//! Canonical strict-lane reconstruction shared by checkpoint export and live operator preflight.

use crate::envelope0_fetch::{fetch_payloads, FetchConfig, FetchMetrics, FetchRequest};
use crate::rpc::Rpc;
use alloy_primitives::{Address, B256};
use alloy_sol_types::{sol, SolEvent};
use anyhow::{bail, Context, Result};
use pagerank_core::{AnchorRecord, Params};
use std::collections::BTreeMap;
use std::path::PathBuf;
use trustgraph_core::{Envelope0AnchorAuthorization, Envelope0PayloadWitness, Lane2Witness};

sol! {
    event HeadAnchored(
        uint64 indexed foldIndex, bytes32 indexed nodeId, address indexed owner,
        uint8 envelopeKind, bytes32 schemaUid, bytes32 previousHead, bytes32 head,
        uint64 count, bytes32 dataCommitment, uint256 blockTimestamp, bytes headSignature
    );
}

#[derive(Debug)]
pub enum PayloadSource {
    Hosted(FetchConfig),
    /// Explicit fixture input. This never belongs in the hosted operator path.
    DebugFiles(Vec<PathBuf>),
}

#[derive(Debug)]
pub struct WitnessRequest<'a> {
    pub registry: Address,
    pub from_block: u64,
    pub to_block: u64,
    pub chunk: u64,
    pub expected_acc: B256,
    pub expected_count: u64,
    pub params: &'a Params,
    pub payload_source: PayloadSource,
}

#[derive(Debug)]
pub struct WitnessReport {
    pub witness: Lane2Witness,
    pub fetch: FetchMetrics,
    pub mutation_count: usize,
}

/// Rebuild the exact strict lane prefix, authenticate every owner transition, fetch only each
/// node's newest committed payload, then execute the native consensus validator.
pub async fn assemble_strict_witness(
    rpc: &Rpc,
    request: WitnessRequest<'_>,
) -> Result<WitnessReport> {
    if request.params.envelope0_domain_separators.len() != 2
        || request.params.lane2_max_head_age != 0
    {
        bail!("strict lane 2 requires exactly [EAS domain, head domain] and maxHeadAge=0");
    }
    let expected_schema = request.params.schema_uid;
    let head_domain = request.params.envelope0_domain_separators[1];
    let anchor_logs = rpc
        .get_logs(
            request.registry,
            &[Some(HeadAnchored::SIGNATURE_HASH)],
            request.from_block,
            request.to_block,
            request.chunk,
        )
        .await
        .context("querying HeadAnchored logs")?;
    let mut indexed: Vec<(u64, AnchorRecord, Address, B256, B256, Vec<u8>)> = Vec::new();
    for log in &anchor_logs {
        let event = HeadAnchored::decode_raw_log(log.topics.iter().copied(), &log.data)
            .context("decoding HeadAnchored")?;
        // A later event in the checkpoint block is outside the frozen prefix.
        if event.foldIndex >= request.expected_count {
            continue;
        }
        indexed.push((
            event.foldIndex,
            AnchorRecord {
                node_id: event.nodeId,
                envelope_kind: event.envelopeKind,
                head: event.head,
                count: event.count,
                data_commitment: event.dataCommitment,
                block_timestamp: u64::try_from(event.blockTimestamp)
                    .context("anchor timestamp overflows u64")?,
            },
            event.owner,
            event.schemaUid,
            event.previousHead,
            event.headSignature.to_vec(),
        ));
    }
    indexed.sort_by_key(|(index, ..)| *index);
    for (want, (got, ..)) in indexed.iter().enumerate() {
        if *got != want as u64 {
            bail!("HeadAnchored indices not contiguous: expected {want}, found {got}");
        }
    }

    let mut previous_by_node: BTreeMap<B256, B256> = BTreeMap::new();
    let mut anchors = Vec::with_capacity(indexed.len());
    let mut authorizations = Vec::with_capacity(indexed.len());
    let mut actual_acc = B256::ZERO;
    for (fold_index, anchor, owner, event_schema, previous_head, head_signature) in indexed {
        if event_schema != expected_schema {
            bail!(
                "HeadAnchored #{fold_index} schema {event_schema:#x} != params schema {expected_schema:#x}"
            );
        }
        let expected_previous = previous_by_node.get(&anchor.node_id).copied().unwrap_or_default();
        if previous_head != expected_previous {
            bail!(
                "HeadAnchored #{fold_index} predecessor {previous_head:#x} != reconstructed {expected_previous:#x}"
            );
        }
        if eas_offchain_v2::address_node_id(owner) != anchor.node_id {
            bail!("HeadAnchored #{fold_index} owner does not derive nodeId");
        }
        let message = eas_offchain_v2::payload_v1::AnchorMessage {
            node_id: anchor.node_id,
            envelope_kind: anchor.envelope_kind,
            schema_uid: expected_schema,
            previous_head,
            head: anchor.head,
            count: anchor.count,
            data_commitment: anchor.data_commitment,
        };
        let recovered = eas_offchain_v2::payload_v1::verify_anchor_authorization(
            head_domain,
            &message,
            &head_signature,
        )
        .map_err(|error| anyhow::anyhow!("{}: HeadAnchored #{fold_index}", error.code()))?;
        if recovered != owner {
            bail!("HeadAnchored #{fold_index} signature does not recover event owner");
        }
        let leaf = zk_core::anchor::anchor_leaf(
            anchor.node_id,
            anchor.envelope_kind,
            anchor.head,
            anchor.count,
            anchor.data_commitment,
            anchor.block_timestamp,
        );
        actual_acc = zk_core::fold::fold(actual_acc, leaf);
        previous_by_node.insert(anchor.node_id, anchor.head);
        anchors.push(anchor);
        authorizations.push(Envelope0AnchorAuthorization { fold_index, head_signature });
    }
    if actual_acc != request.expected_acc || anchors.len() as u64 != request.expected_count {
        bail!(
            "anchor re-fold mismatch: local acc={actual_acc:#x} count={} vs expected acc={:#x} count={}",
            anchors.len(),
            request.expected_acc,
            request.expected_count
        );
    }

    let mut payloads_by_node = BTreeMap::new();
    let fetch = match request.payload_source {
        PayloadSource::Hosted(config) => {
            let latest = anchors.iter().fold(BTreeMap::new(), |mut by_node, anchor| {
                by_node.insert(anchor.node_id, anchor.data_commitment);
                by_node
            });
            let requests = latest
                .into_iter()
                .map(|(node_id, data_commitment)| FetchRequest { node_id, data_commitment })
                .collect();
            let (fetched, metrics) = fetch_payloads(requests, config).await?;
            payloads_by_node.extend(fetched);
            metrics
        }
        PayloadSource::DebugFiles(files) => {
            for path in files {
                let payload = std::fs::read(&path).with_context(|| {
                    format!("failed to read {} as Envelope0PayloadV1 bytes", path.display())
                })?;
                let decoded = eas_offchain_v2::payload_v1::decode(&payload, expected_schema)
                    .map_err(|error| anyhow::anyhow!("{}: {}", error.code(), path.display()))?;
                let node_id = eas_offchain_v2::address_node_id(decoded.owner);
                if payloads_by_node.insert(node_id, payload).is_some() {
                    bail!("more than one debug payload supplied for node {node_id:#x}");
                }
            }
            FetchMetrics::default()
        }
    };
    let payloads = payloads_by_node
        .into_iter()
        .map(|(node_id, payload)| Envelope0PayloadWitness { node_id, payload })
        .collect();
    let witness = Lane2Witness { anchors, authorizations, payloads };
    let result = trustgraph_core::lane2::process(request.params, &witness)
        .map_err(|error| anyhow::anyhow!("strict lane-2 preflight failed: {error:?}"))?;
    Ok(WitnessReport { witness, fetch, mutation_count: result.edges.len() })
}
