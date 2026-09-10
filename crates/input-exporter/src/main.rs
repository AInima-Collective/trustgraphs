//! input-exporter — reconstruct `input.json` (a `GuestInput`/`SignerInput`) from on-chain state.
//!
//! Reads the accumulator's `EdgeFolded` and attestation-marker events up to a checkpoint, resolves
//! those exact UIDs from EAS storage, self-verifies the reconstructed edge set against the
//! checkpointed `acc`, and writes the JSON the prover consumes. See
//! `research/operations/trust-graph/runbook.md`.

use alloy_primitives::{Address, B256, U256};
use alloy_sol_types::{sol, SolCall, SolEvent, SolValue};
use anyhow::{bail, Context, Result};
use clap::Parser;
use input_exporter::envelope0_fetch::{fetch_payloads, FetchConfig, FetchRequest};
use input_exporter::reconstruct;
use input_exporter::rpc::{parse_addr, Rpc};
use pagerank_core::{
    signer::fold_activity, ActivityCheckpoint, AnchorRecord, Binding, Params, RawEdge,
    SelectionParams, SignerActivity, SignerInput,
};
use std::collections::{BTreeMap, BTreeSet};
use std::time::Duration;
use trustgraph_core::{
    Envelope0AnchorAuthorization, Envelope0PayloadWitness, GuestInput, Lane2Witness,
};

sol! {
    struct Checkpoint { bytes32 acc; uint64 leafCount; uint64 blockNumber; }
    function getCheckpoint(uint256 id) external view returns (Checkpoint);

    struct Attestation {
        bytes32 uid; bytes32 schema; uint64 time; uint64 expirationTime;
        uint64 revocationTime; bytes32 refUID; address recipient; address attester;
        bool revocable; bytes data;
    }
    function getAttestation(bytes32 uid) external view returns (Attestation);

    event EdgeFolded(uint64 indexed index, bytes32 leaf, bytes32 acc);
    event AttestationAttested(address indexed eas, bytes32 indexed uid);

    event HeadAnchored(
        uint64 indexed foldIndex, bytes32 indexed nodeId, address indexed owner,
        uint8 envelopeKind, bytes32 schemaUid, bytes32 previousHead, bytes32 head,
        uint64 count, bytes32 dataCommitment, uint256 blockTimestamp, bytes headSignature
    );

    function anchorCheckpoints(uint256 checkpointId) external view returns (bytes32 anchorAcc, uint64 anchorCount);

    function activitySource() external view returns (address);
    function target() external view returns (address);
    function hasAppliedCheckpoint() external view returns (bool);
    function getOwners() external view returns (address[]);
    function getThreshold() external view returns (uint256);

    struct SolActivityCheckpoint { bytes32 acc; uint64 count; uint64 blockNumber; }
    function activityCheckpointCount() external view returns (uint256);
    function getActivityCheckpoint(uint256 id) external view returns (SolActivityCheckpoint);
    event DirectGovernanceActivity(
        uint64 indexed sequence, address indexed account, uint256 indexed proposalId,
        uint64 blockNumber, bytes32 acc
    );
}

async fn marked_attestation_uids(
    rpc: &Rpc,
    accumulator: Address,
    eas: Address,
    from_block: u64,
    to_block: u64,
    chunk: u64,
) -> Result<BTreeSet<B256>> {
    let logs = rpc
        .get_logs(
            accumulator,
            &[Some(AttestationAttested::SIGNATURE_HASH)],
            from_block,
            to_block,
            chunk,
        )
        .await
        .context("querying accumulator AttestationAttested markers")?;
    let mut uids = BTreeSet::new();
    for log in &logs {
        let marker = AttestationAttested::decode_raw_log(log.topics.iter().copied(), &log.data)
            .context("decoding accumulator AttestationAttested marker")?;
        if marker.eas != eas {
            bail!(
                "accumulator {accumulator:#x} marked UID {:#x} from EAS {:#x}, not configured EAS {eas:#x}",
                marker.uid,
                marker.eas
            );
        }
        uids.insert(marker.uid);
    }
    Ok(uids)
}

#[derive(Parser, Debug)]
#[command(
    about = "Reconstruct input.json (GuestInput/SignerInput) from on-chain accumulator + EAS state"
)]
struct Args {
    /// JSON-RPC endpoint.
    #[arg(long)]
    rpc: String,
    /// Hard deadline for each JSON-RPC request.
    #[arg(long, default_value_t = input_exporter::rpc::DEFAULT_RPC_TIMEOUT_SECONDS)]
    rpc_timeout_seconds: u64,
    /// The AttestationAccumulator (i.e. the EASIndexerResolver) address.
    #[arg(long)]
    accumulator: String,
    /// The EAS contract address.
    #[arg(long)]
    eas: String,
    /// The checkpoint id to reconstruct.
    #[arg(long)]
    checkpoint: u64,
    /// Path to the governance-pinned params (binary params by default; weighted params with
    /// `--weighted`).
    #[arg(long)]
    params: String,
    /// Emit the isolated `weighted_prior_core::GuestInput` shape.
    #[arg(long, conflicts_with = "signer")]
    weighted: bool,
    /// Exact canonical TGWP bytes; required with `--weighted`.
    #[arg(long, requires = "weighted")]
    prior_manifest: Option<String>,
    /// Output path (default: `<repo root>/.trustgraph/trust-graph/input.json`, or
    /// `.trustgraph/signer-sync/signer_input.json` with --signer).
    #[arg(long)]
    out: Option<String>,
    /// Emit a `SignerInput` (adds `selection`) instead of a `GuestInput`.
    #[arg(long)]
    signer: bool,
    /// Path to the selection params (serialized `pagerank_core::SelectionParams`); required with --signer.
    #[arg(long)]
    selection: Option<String>,
    /// The SignerSyncZkModule this signer input will be proven against. REQUIRED with --signer: it
    /// is half of the `instanceDomain` the module rebuilds from `address(this)` and `block.chainid`
    /// (audit M-3), so an export without it produces a proof no module can accept.
    #[arg(long)]
    module: Option<String>,
    /// First block to scan for events (default: 0). Set to the accumulator's deploy block for speed.
    #[arg(long, default_value_t = 0)]
    from_block: u64,
    /// Max blocks per eth_getLogs request (many RPCs cap the range).
    #[arg(long, default_value_t = 10_000)]
    chunk: u64,
    /// Lane 2: the AnchorRegistry address. When set, HeadAnchored events up to the checkpoint
    /// block become the anchor-log witness.
    #[arg(long)]
    anchor_registry: Option<String>,
    /// Lane 2 debug path: raw canonical Envelope0PayloadV1 files, repeatable. The hosted path will
    /// fetch these by CID; missing bytes are always an error for the strict profile.
    #[arg(long)]
    envelope0_log: Vec<String>,
    /// Lane 2 hosted path: raw-CID reader gateway prefix, repeatable. The CID derived from each
    /// newest checkpointed dataCommitment is appended verbatim. One exact reader is sufficient.
    #[arg(long, conflicts_with = "envelope0_log")]
    envelope0_gateway: Vec<String>,
    /// Persistent cache for digest-verified Envelope0 payload bytes.
    #[arg(long, default_value = ".trustgraph/cache/envelope0")]
    envelope0_cache: String,
    /// Maximum newest-node payload fetches in flight.
    #[arg(long, default_value_t = 8)]
    envelope0_fetch_concurrency: usize,
    /// The MerkleSnapshot this input will be proven against. REQUIRED for a `GuestInput`: it is
    /// half of the journal-v3 `instanceDomain` the contract rebuilds from `address(this)` and
    /// `block.chainid`, so an export without it produces a proof no snapshot can accept. Also
    /// used to self-check the re-folded lane-2 anchorAcc against the stored anchor checkpoint.
    #[arg(long)]
    snapshot: Option<String>,
    /// Journal-v3 bounty payee, committed verbatim by the guest and bound by `submitProof`.
    /// Defaults to the zero address, which means "no bounty" — correct for a curated instance
    /// or a community self-proving for free.
    #[arg(long)]
    recipient: Option<String>,
}

#[tokio::main]
async fn main() -> Result<()> {
    let args = Args::parse();
    anyhow::ensure!(args.rpc_timeout_seconds > 0, "--rpc-timeout-seconds must be at least 1");
    let rpc = Rpc::with_timeout(args.rpc.clone(), Duration::from_secs(args.rpc_timeout_seconds));
    let accumulator = parse_addr(&args.accumulator)?;
    let eas = parse_addr(&args.eas)?;

    let params_json = std::fs::read_to_string(&args.params)?;
    let mut params: Option<Params> = if args.weighted {
        None
    } else {
        Some(
            serde_json::from_str(&params_json)
                .context("failed to parse --params as pagerank_core::Params")?,
        )
    };
    let mut weighted_params: Option<weighted_prior_core::Params> = if args.weighted {
        Some(
            serde_json::from_str(&params_json)
                .context("failed to parse --params as weighted_prior_core::Params")?,
        )
    } else {
        None
    };

    // Params-schema v2 domain separation (INSTANCE_FACTORY §6.1): the accumulator address and the
    // chain id are properties of the instance being exported, not of the governance file, so they
    // come from the connection we are actually reading. A file that names a *different* instance is
    // a misconfiguration (it would silently produce a proof for someone else's snapshot), so it is
    // an error rather than an override.
    let chain_id = rpc.eth_chain_id().await.context("eth_chainId failed")?;
    let configured_accumulator = params
        .as_ref()
        .map(|params| params.accumulator)
        .or_else(|| weighted_params.as_ref().map(|params| params.accumulator))
        .expect("one params shape");
    let configured_chain = params
        .as_ref()
        .map(|params| params.chain_id)
        .or_else(|| weighted_params.as_ref().map(|params| params.chain_id))
        .expect("one params shape");
    if configured_accumulator != Address::ZERO && configured_accumulator != accumulator {
        bail!(
            "--params names accumulator {:#x} but --accumulator is {:#x}",
            configured_accumulator,
            accumulator
        );
    }
    if configured_chain != 0 && configured_chain != chain_id {
        bail!("--params names chain {} but --rpc is chain {}", configured_chain, chain_id);
    }
    if let Some(params) = params.as_mut() {
        params.accumulator = accumulator;
        params.chain_id = chain_id;
    }
    if let Some(params) = weighted_params.as_mut() {
        params.accumulator = accumulator;
        params.chain_id = chain_id;
    }
    eprintln!("domain separators: accumulator={accumulator:#x} chainId={chain_id}");

    let selection: Option<SelectionParams> = match (args.signer, &args.selection) {
        (true, Some(p)) => Some(
            serde_json::from_str(&std::fs::read_to_string(p)?)
                .context("failed to parse --selection as pagerank_core::SelectionParams")?,
        ),
        (true, None) => bail!("--signer requires --selection <selection.json>"),
        (false, _) => None,
    };

    // Journal-v3 bindings. `instanceDomain` is derived from the snapshot this input will be proven
    // against and the chain it lives on, byte-identically to the rebuild inside
    // `MerkleSnapshot.submitProof` — so naming the wrong snapshot fails here, at export time,
    // instead of after a proof has been paid for. A `SignerInput` binds the analogous module
    // domain (audit M-3), derived below from --module.
    let mut signer_module = None;
    let signer_domain = if args.signer {
        let Some(m) = &args.module else {
            bail!(
                "--module <0x…> is required with --signer: it is half of the instanceDomain that \
                 SignerSyncZkModule.submitSignerProof rebuilds from address(this) and \
                 block.chainid, so an input exported without it proves nothing any module will \
                 accept"
            );
        };
        let module = parse_addr(m)?;
        signer_module = Some(module);
        let d = pagerank_core::encode::instance_domain(module, chain_id);
        eprintln!("signer instanceDomain: module={module:#x} chainId={chain_id} domain={d:#x}");
        Some(d)
    } else {
        None
    };
    let binding = if args.signer {
        Binding::default()
    } else {
        let Some(snap) = &args.snapshot else {
            bail!(
                "--snapshot <0x…> is required: it is half of the journal-v3 instanceDomain that \
                 MerkleSnapshot.submitProof rebuilds from address(this) and block.chainid, so an \
                 input exported without it proves nothing any snapshot will accept"
            );
        };
        let snapshot = parse_addr(snap)?;
        let recipient = match &args.recipient {
            Some(r) => parse_addr(r)?,
            None => Address::ZERO,
        };
        let instance_domain = pagerank_core::encode::instance_domain(snapshot, chain_id);
        eprintln!(
            "journal v3: snapshot={snapshot:#x} recipient={recipient:#x} instanceDomain={instance_domain:#x}"
        );
        Binding { recipient, instance_domain }
    };

    // 1. Checkpoint.
    let cp_ret = rpc
        .eth_call(accumulator, getCheckpointCall { id: U256::from(args.checkpoint) }.abi_encode())
        .await
        .context("getCheckpoint failed")?;
    let cp = Checkpoint::abi_decode(&cp_ret).context("decoding Checkpoint")?;
    let to_block = cp.blockNumber;
    eprintln!(
        "checkpoint #{}: acc={:#x} leafCount={} block={}",
        args.checkpoint, cp.acc, cp.leafCount, to_block
    );
    if cp.leafCount == 0 {
        eprintln!("checkpoint has 0 edges — emitting an empty input set.");
    }

    // Signer liveness is a separate authenticated input. Direct member votes are hash-chained by
    // the governed instance; the exporter reconstructs the COMPLETE chain through its latest
    // immutable checkpoint and also captures the Safe state the proof is allowed to replace.
    let signer_liveness = if let Some(module) = signer_module {
        let activity_source = activitySourceCall::abi_decode_returns(
            &rpc.eth_call(module, activitySourceCall {}.abi_encode())
                .await
                .context("signer activitySource() failed")?,
        )?;
        let safe = targetCall::abi_decode_returns(
            &rpc.eth_call(module, targetCall {}.abi_encode())
                .await
                .context("signer target() failed")?,
        )?;
        let was_initialized = hasAppliedCheckpointCall::abi_decode_returns(
            &rpc.eth_call(module, hasAppliedCheckpointCall {}.abi_encode())
                .await
                .context("signer hasAppliedCheckpoint() failed")?,
        )?;
        let current_signers = getOwnersCall::abi_decode_returns(
            &rpc.eth_call(safe, getOwnersCall {}.abi_encode())
                .await
                .context("Safe getOwners() failed")?,
        )?;
        let current_threshold = getThresholdCall::abi_decode_returns(
            &rpc.eth_call(safe, getThresholdCall {}.abi_encode())
                .await
                .context("Safe getThreshold() failed")?,
        )?;
        let checkpoint_count = activityCheckpointCountCall::abi_decode_returns(
            &rpc.eth_call(activity_source, activityCheckpointCountCall {}.abi_encode())
                .await
                .context("activityCheckpointCount() failed")?,
        )?;
        if checkpoint_count == U256::ZERO {
            (
                Vec::new(),
                ActivityCheckpoint::default(),
                0,
                current_signers,
                current_threshold,
                was_initialized,
            )
        } else {
            let activity_id = checkpoint_count - U256::from(1u8);
            let activity_id_u64 =
                u64::try_from(activity_id).context("activity checkpoint id exceeds u64")?;
            let checkpoint = getActivityCheckpointCall::abi_decode_returns(
                &rpc.eth_call(
                    activity_source,
                    getActivityCheckpointCall { id: activity_id }.abi_encode(),
                )
                .await
                .context("getActivityCheckpoint() failed")?,
            )?;
            let logs = rpc
                .get_logs(
                    activity_source,
                    &[Some(DirectGovernanceActivity::SIGNATURE_HASH)],
                    args.from_block,
                    checkpoint.blockNumber,
                    args.chunk,
                )
                .await
                .context("querying DirectGovernanceActivity logs")?;
            let mut indexed = Vec::new();
            for log in &logs {
                let event =
                    DirectGovernanceActivity::decode_raw_log(log.topics.iter().copied(), &log.data)
                        .context("decoding DirectGovernanceActivity")?;
                if event.sequence <= checkpoint.count {
                    indexed.push((
                        event.sequence,
                        SignerActivity {
                            account: event.account,
                            proposal_id: event.proposalId,
                            block_number: event.blockNumber,
                        },
                        event.acc,
                    ));
                }
            }
            indexed.sort_by_key(|(sequence, _, _)| *sequence);
            let mut reconstructed = B256::ZERO;
            let mut activity = Vec::with_capacity(indexed.len());
            for (offset, (sequence, record, emitted_acc)) in indexed.into_iter().enumerate() {
                let expected = u64::try_from(offset + 1).context("activity sequence overflow")?;
                if sequence != expected {
                    bail!(
                        "activity sequence not contiguous: expected {expected}, found {sequence}"
                    );
                }
                reconstructed = fold_activity(reconstructed, sequence, &record);
                if reconstructed != emitted_acc {
                    bail!("activity accumulator mismatch at sequence {sequence}");
                }
                activity.push(record);
            }
            if activity.len() != checkpoint.count as usize || reconstructed != checkpoint.acc {
                bail!(
                    "activity witness incomplete: reconstructed {} records / {reconstructed:#x}, checkpoint names {} / {:#x}",
                    activity.len(), checkpoint.count, checkpoint.acc
                );
            }
            eprintln!(
                "signer liveness: source={activity_source:#x} checkpoint={activity_id} records={} block={} initialized={was_initialized}",
                activity.len(), checkpoint.blockNumber
            );
            (
                activity,
                ActivityCheckpoint {
                    acc: checkpoint.acc,
                    count: checkpoint.count,
                    block_number: checkpoint.blockNumber,
                },
                activity_id_u64,
                current_signers,
                current_threshold,
                was_initialized,
            )
        }
    } else {
        (Vec::new(), ActivityCheckpoint::default(), 0, Vec::new(), U256::ZERO, false)
    };

    // 2. Ordered fold leaves (EdgeFolded), index 0..leafCount-1.
    let fold_logs = rpc
        .get_logs(
            accumulator,
            &[Some(EdgeFolded::SIGNATURE_HASH)],
            args.from_block,
            to_block,
            args.chunk,
        )
        .await
        .context("querying EdgeFolded logs")?;
    let mut indexed: Vec<(u64, B256)> = Vec::new();
    for log in &fold_logs {
        let ev = EdgeFolded::decode_raw_log(log.topics.iter().copied(), &log.data)
            .context("decoding EdgeFolded")?;
        if (ev.index as u64) < cp.leafCount {
            indexed.push((ev.index as u64, ev.leaf));
        }
    }
    indexed.sort_by_key(|(i, _)| *i);
    // Verify contiguity 0..leafCount-1 (no gaps / dups).
    for (want, (got, _)) in indexed.iter().enumerate() {
        if *got != want as u64 {
            bail!(
                "EdgeFolded indices not contiguous: expected {want}, found {got} (missing events?)"
            );
        }
    }
    let ordered_leaves: Vec<B256> = indexed.into_iter().map(|(_, leaf)| leaf).collect();
    eprintln!("collected {} ordered fold leaves", ordered_leaves.len());

    // 3. Candidate edges from this accumulator's own UID markers. Scanning EAS from the
    // accumulator's deploy block loses legacy attestations imported after deployment; their EAS
    // `Attested` logs are older than the scan range. The marker is emitted at import time and the
    // full record remains authenticated by the configured EAS contract's storage.
    let uids =
        marked_attestation_uids(&rpc, accumulator, eas, args.from_block, to_block, args.chunk)
            .await?;
    eprintln!("found {} accumulator-marked attestations; fetching EAS records...", uids.len());

    let expected_schema = params
        .as_ref()
        .map(|params| params.schema_uid)
        .or_else(|| weighted_params.as_ref().map(|params| params.schema_uid))
        .expect("one params shape");

    let mut candidates: Vec<RawEdge> = Vec::new();
    for uid in &uids {
        let ret = rpc
            .eth_call(eas, getAttestationCall { uid: *uid }.abi_encode())
            .await
            .with_context(|| format!("getAttestation({uid:#x}) failed"))?;
        let a = Attestation::abi_decode(&ret).context("decoding Attestation")?;
        if a.uid != *uid {
            bail!("EAS returned UID {:#x} for accumulator marker {uid:#x}", a.uid);
        }
        if a.schema != expected_schema {
            bail!(
                "accumulator marker {uid:#x} resolves to schema {:#x}, not pinned schema {expected_schema:#x}",
                a.schema
            );
        }
        let data = a.data.to_vec();
        // Attest edge (folded in onAttest at attestation.time).
        candidates.push(RawEdge {
            kind: 0,
            attester: a.attester,
            recipient: a.recipient,
            uid: *uid,
            block_timestamp: a.time,
            data: data.clone(),
        });
        // Importer instances may fold expiration as a revoke-kind leaf at the immutable EAS
        // expiration timestamp without changing EAS.revocationTime. Always include that authentic
        // candidate when present; leaf matching ignores it for native resolvers and checkpoints
        // where no expiration was imported.
        if a.expirationTime != 0 {
            candidates.push(RawEdge {
                kind: 1,
                attester: a.attester,
                recipient: a.recipient,
                uid: *uid,
                block_timestamp: a.expirationTime,
                data: data.clone(),
            });
        }
        // Revoke edge (folded in onRevoke at revocationTime), if revoked. Reconstruction includes
        // it only when its fold leaf is inside this checkpoint; reconciliation then clears the
        // pair only if this UID is still current.
        if a.revocationTime != 0 {
            candidates.push(RawEdge {
                kind: 1,
                attester: a.attester,
                recipient: a.recipient,
                uid: *uid,
                block_timestamp: a.revocationTime,
                data,
            });
        }
    }

    // 4. Assemble + self-verify against the checkpoint acc.
    let edges = reconstruct(&ordered_leaves, &candidates, cp.acc, cp.leafCount)?;
    eprintln!("reconstruction self-check OK: re-folded acc == checkpoint acc ✓");

    // 4b. Lane 2: anchor log + envelope witnesses.
    if args.weighted && args.anchor_registry.is_some() {
        bail!("--weighted is lane-one-only and cannot accept --anchor-registry");
    }
    if args.signer && args.anchor_registry.is_some() {
        bail!("--signer is lane-one-only and cannot accept --anchor-registry");
    }
    let lane2: Option<Lane2Witness> = if let Some(reg) = &args.anchor_registry {
        let registry = parse_addr(reg)?;
        let snapshot = parse_addr(
            args.snapshot.as_ref().expect("non-signer export already requires --snapshot"),
        )?;
        let ret = rpc
            .eth_call(
                snapshot,
                anchorCheckpointsCall { checkpointId: U256::from(args.checkpoint) }.abi_encode(),
            )
            .await
            .context("anchorCheckpoints failed")?;
        let cp2 = anchorCheckpointsCall::abi_decode_returns(&ret)
            .context("decoding anchorCheckpoints")?;
        let anchor_logs = rpc
            .get_logs(
                registry,
                &[Some(HeadAnchored::SIGNATURE_HASH)],
                args.from_block,
                to_block,
                args.chunk,
            )
            .await
            .context("querying HeadAnchored logs")?;
        let mut indexed: Vec<(u64, AnchorRecord, Address, B256, B256, Vec<u8>)> = Vec::new();
        for log in &anchor_logs {
            let ev = HeadAnchored::decode_raw_log(log.topics.iter().copied(), &log.data)
                .context("decoding HeadAnchored")?;
            // An anchor submitted later in the checkpoint block is not part of this immutable
            // freeze. Fold index is the transaction-order discriminator that block filters lack.
            if ev.foldIndex >= cp2.anchorCount {
                continue;
            }
            indexed.push((
                ev.foldIndex,
                AnchorRecord {
                    node_id: ev.nodeId,
                    envelope_kind: ev.envelopeKind,
                    head: ev.head,
                    count: ev.count,
                    data_commitment: ev.dataCommitment,
                    block_timestamp: u64::try_from(ev.blockTimestamp)
                        .context("anchor timestamp overflows u64")?,
                },
                ev.owner,
                ev.schemaUid,
                ev.previousHead,
                ev.headSignature.to_vec(),
            ));
        }
        indexed.sort_by_key(|(i, ..)| *i);
        for (want, (got, ..)) in indexed.iter().enumerate() {
            if *got != want as u64 {
                bail!("HeadAnchored indices not contiguous: expected {want}, found {got}");
            }
        }

        let lane2_params = params.as_ref().expect("weighted/signer lane 2 was rejected");
        if lane2_params.envelope0_domain_separators.len() != 2
            || lane2_params.lane2_max_head_age != 0
        {
            bail!("strict lane 2 requires exactly [EAS domain, head domain] and maxHeadAge=0");
        }
        let expected_schema = lane2_params.schema_uid;
        let head_domain = lane2_params.envelope0_domain_separators[1];
        let mut previous_by_node: BTreeMap<B256, B256> = BTreeMap::new();
        let mut anchors = Vec::with_capacity(indexed.len());
        let mut authorizations = Vec::with_capacity(indexed.len());
        let mut acc2 = B256::ZERO;
        for (fold_index, anchor, owner, event_schema, previous_head, head_signature) in indexed {
            if event_schema != expected_schema {
                bail!(
                    "HeadAnchored #{fold_index} schema {event_schema:#x} != params schema {expected_schema:#x}"
                );
            }
            let expected_previous =
                previous_by_node.get(&anchor.node_id).copied().unwrap_or_default();
            if previous_head != expected_previous {
                bail!(
                    "HeadAnchored #{fold_index} predecessor {previous_head:#x} != reconstructed {expected_previous:#x}"
                );
            }
            if eas_offchain::address_node_id(owner) != anchor.node_id {
                bail!("HeadAnchored #{fold_index} owner does not derive nodeId");
            }
            let message = eas_offchain::payload::AnchorMessage {
                node_id: anchor.node_id,
                envelope_kind: anchor.envelope_kind,
                schema_uid: expected_schema,
                previous_head,
                head: anchor.head,
                count: anchor.count,
                data_commitment: anchor.data_commitment,
            };
            let recovered = eas_offchain::payload::verify_anchor_authorization(
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
            acc2 = zk_core::fold::fold(acc2, leaf);
            previous_by_node.insert(anchor.node_id, anchor.head);
            anchors.push(anchor);
            authorizations.push(Envelope0AnchorAuthorization { fold_index, head_signature });
        }
        if acc2 != cp2.anchorAcc || anchors.len() as u64 != cp2.anchorCount {
            bail!(
                "anchor re-fold mismatch: local acc={acc2:#x} count={} vs checkpointed acc={:#x} count={}",
                anchors.len(), cp2.anchorAcc, cp2.anchorCount
            );
        }
        eprintln!("anchor re-fold and authorization self-check OK ✓");

        let mut payloads_by_node = BTreeMap::new();
        if args.envelope0_log.is_empty() {
            let latest = anchors.iter().fold(BTreeMap::new(), |mut by_node, anchor| {
                by_node.insert(anchor.node_id, anchor.data_commitment);
                by_node
            });
            let requests = latest
                .into_iter()
                .map(|(node_id, data_commitment)| FetchRequest { node_id, data_commitment })
                .collect();
            let (fetched, metrics) = fetch_payloads(
                requests,
                FetchConfig {
                    gateways: args.envelope0_gateway.clone(),
                    cache_dir: std::path::PathBuf::from(&args.envelope0_cache),
                    concurrency: args.envelope0_fetch_concurrency,
                    timeout: Duration::from_secs(20),
                },
            )
            .await?;
            eprintln!(
                "lane 2 bundle fetch: payloads={} cacheHits={} gatewayAttempts={} exactReaders={} totalLatencyMs={}",
                metrics.payloads,
                metrics.cache_hits,
                metrics.gateway_attempts,
                metrics.gateway_successes,
                metrics.latency_ms
            );
            payloads_by_node.extend(fetched);
        } else {
            eprintln!("lane 2: using --envelope0-log debug fixtures (not a hosted source)");
            for path in &args.envelope0_log {
                let payload = std::fs::read(path).with_context(|| {
                    format!("failed to read {path} as Envelope0PayloadV1 bytes")
                })?;
                let decoded = eas_offchain::payload::decode(&payload, expected_schema)
                    .map_err(|error| anyhow::anyhow!("{}: {}", error.code(), path))?;
                let node_id = eas_offchain::address_node_id(decoded.owner);
                if payloads_by_node.insert(node_id, payload).is_some() {
                    bail!("more than one --envelope0-log payload supplied for node {node_id:#x}");
                }
            }
        }
        let payloads = payloads_by_node
            .into_iter()
            .map(|(node_id, payload)| Envelope0PayloadWitness { node_id, payload })
            .collect::<Vec<_>>();
        eprintln!("lane 2: {} anchors, {} canonical payloads", anchors.len(), payloads.len());
        Some(Lane2Witness { anchors, authorizations, payloads })
    } else {
        None
    };

    if let Some(witness) = lane2.as_ref() {
        let result = trustgraph_core::lane2::process(
            params.as_ref().expect("strict lane 2 has binary params"),
            witness,
        )
        .map_err(|error| anyhow::anyhow!("strict lane-2 preflight failed: {error:?}"))?;
        eprintln!(
            "strict lane-2 native preflight OK: {} authenticated mutations",
            result.edges.len()
        );
    }

    // 5. Emit. Default paths live under the repo's gitignored `.trustgraph/` output directory,
    // resolved from this crate's manifest dir so they land there from any CWD.
    let out_path = match &args.out {
        Some(o) => std::path::PathBuf::from(o),
        None => {
            let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
            if args.signer {
                root.join(".trustgraph/signer-sync/signer_input.json")
            } else if args.weighted {
                root.join(".trustgraph/trust-graph-weighted/input.json")
            } else {
                root.join(".trustgraph/trust-graph/input.json")
            }
        }
    };
    if let Some(parent) = out_path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let out_json = if args.weighted {
        let manifest_path = args
            .prior_manifest
            .as_ref()
            .ok_or_else(|| anyhow::anyhow!("--weighted requires --prior-manifest <file>"))?;
        let manifest = std::fs::read(manifest_path)
            .with_context(|| format!("read exact TGWP manifest {manifest_path}"))?;
        let params = weighted_params.expect("--weighted parsed weighted params");
        weighted_prior_core::manifest::validate_manifest(&manifest, &params)
            .context("TGWP manifest does not match weighted params")?;
        let edges = edges
            .into_iter()
            .map(|edge| weighted_prior_core::RawEdge {
                kind: edge.kind,
                attester: edge.attester,
                recipient: edge.recipient,
                uid: edge.uid,
                block_timestamp: edge.block_timestamp,
                data: edge.data,
            })
            .collect();
        serde_json::to_string_pretty(&weighted_prior_core::GuestInput {
            edges,
            params,
            manifest,
            binding: weighted_prior_core::Binding {
                recipient: binding.recipient,
                instance_domain: binding.instance_domain,
            },
        })?
    } else if let Some(selection) = selection {
        // The signer journal carries no bounty recipient (`SignerSyncZkModule` pays none) but DOES
        // bind the module's instance domain (audit M-3), derived above from --module + chainId.
        let instance_domain = signer_domain.expect("--signer guarantees signer_domain");
        serde_json::to_string_pretty(&SignerInput {
            edges,
            params: params.expect("binary params parsed"),
            selection,
            activity: signer_liveness.0,
            activity_checkpoint: signer_liveness.1,
            activity_checkpoint_id: signer_liveness.2,
            current_signers: signer_liveness.3,
            current_threshold: signer_liveness.4,
            was_initialized: signer_liveness.5,
            instance_domain,
        })?
    } else {
        serde_json::to_string_pretty(&GuestInput {
            edges,
            params: params.expect("binary params parsed"),
            lane2,
            binding,
        })?
    };
    std::fs::write(&out_path, out_json)?;
    eprintln!("wrote {} ({} edges)", out_path.display(), cp.leafCount);
    Ok(())
}

#[cfg(test)]
mod importer_marker_tests {
    use super::{marked_attestation_uids, AttestationAttested};
    use alloy_primitives::{hex, Address, B256};
    use alloy_sol_types::SolEvent;
    use input_exporter::rpc::Rpc;
    use serde_json::{json, Value};
    use std::io::{Read as _, Write as _};
    use std::net::TcpListener;
    use std::sync::mpsc;
    use std::time::Duration;

    fn read_request(stream: &mut std::net::TcpStream) -> String {
        stream.set_read_timeout(Some(Duration::from_secs(2))).unwrap();
        let mut bytes = Vec::new();
        let mut content_length = None;
        loop {
            let mut chunk = [0u8; 4096];
            let read = stream.read(&mut chunk).unwrap();
            assert!(read > 0, "client closed before sending a complete request");
            bytes.extend_from_slice(&chunk[..read]);
            if content_length.is_none() {
                if let Some(header_end) = bytes.windows(4).position(|window| window == b"\r\n\r\n")
                {
                    let headers = String::from_utf8_lossy(&bytes[..header_end]);
                    content_length = headers.lines().find_map(|line| {
                        line.to_ascii_lowercase()
                            .strip_prefix("content-length: ")
                            .and_then(|value| value.parse::<usize>().ok())
                            .map(|length| (header_end + 4, length))
                    });
                }
            }
            if let Some((body_start, body_length)) = content_length {
                if bytes.len() >= body_start + body_length {
                    return String::from_utf8(bytes[body_start..body_start + body_length].to_vec())
                        .unwrap();
                }
            }
        }
    }

    #[tokio::test]
    async fn discovers_import_marker_when_original_eas_log_predates_scan_range() {
        let accumulator: Address = "0x1111111111111111111111111111111111111111".parse().unwrap();
        let eas: Address = "0x2222222222222222222222222222222222222222".parse().unwrap();
        let uid = B256::repeat_byte(0x33);
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let (request_tx, request_rx) = mpsc::channel();

        std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            request_tx.send(read_request(&mut stream)).unwrap();
            let indexed_eas = format!("0x{:0>64}", hex::encode(eas));
            let response = json!({
                "jsonrpc": "2.0",
                "id": 1,
                "result": [{
                    "address": format!("{accumulator:#x}"),
                    "topics": [
                        format!("{:#x}", AttestationAttested::SIGNATURE_HASH),
                        indexed_eas,
                        format!("{uid:#x}")
                    ],
                    "data": "0x",
                    "blockNumber": "0x64",
                    "transactionHash": format!("{:#x}", B256::repeat_byte(0x44))
                }]
            })
            .to_string();
            write!(
                stream,
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                response.len(),
                response
            )
            .unwrap();
        });

        // The source attestation may have been emitted long before block 100. Discovery must query
        // the accumulator marker emitted during import at block 100, not the historical EAS log.
        let found = marked_attestation_uids(
            &Rpc::new(format!("http://{address}")),
            accumulator,
            eas,
            100,
            100,
            1,
        )
        .await
        .unwrap();
        assert_eq!(found.into_iter().collect::<Vec<_>>(), vec![uid]);

        let request: Value = serde_json::from_str(&request_rx.recv().unwrap()).unwrap();
        assert_eq!(request["method"], "eth_getLogs");
        assert_eq!(request["params"][0]["address"], format!("{accumulator:#x}"));
        assert_eq!(request["params"][0]["fromBlock"], "0x64");
        assert_eq!(
            request["params"][0]["topics"][0],
            format!("{:#x}", AttestationAttested::SIGNATURE_HASH)
        );
    }
}
