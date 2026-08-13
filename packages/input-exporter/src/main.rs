//! input-exporter — reconstruct `input.json` (a `GuestInput`/`SignerInput`) from on-chain state.
//!
//! Reads the accumulator's `EdgeFolded` events + EAS attestations up to a checkpoint, reassembles the
//! exact ordered edge set, self-verifies it re-folds to the checkpoint's `acc`, and writes the JSON
//! the prover consumes. See `docs/build/trust-graph/runbook.md`.

use alloy_primitives::{Address, B256, U256};
use alloy_sol_types::{sol, SolCall, SolEvent, SolValue};
use anyhow::{bail, Context, Result};
use clap::Parser;
use input_exporter::reconstruct;
use input_exporter::rpc::{parse_addr, Rpc};
use pagerank_core::{
    AnchorRecord, Binding, GuestInput, Lane2Witness, Params, RawEdge, SelectionParams, SignerInput,
};
use std::collections::BTreeSet;

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
    event Attested(address indexed recipient, address indexed attester, bytes32 uid, bytes32 indexed schemaUID);

    event HeadAnchored(uint64 indexed foldIndex, bytes32 indexed nodeId, uint8 envelopeKind, bytes32 head, uint64 count, bytes32 dataCommitment, uint256 blockTimestamp);
    function anchorCheckpoints(uint256 checkpointId) external view returns (bytes32 anchorAcc, uint64 anchorCount);
}

#[derive(Parser, Debug)]
#[command(
    about = "Reconstruct input.json (GuestInput/SignerInput) from on-chain accumulator + EAS state"
)]
struct Args {
    /// JSON-RPC endpoint.
    #[arg(long)]
    rpc: String,
    /// The AttestationAccumulator (i.e. the EASIndexerResolver) address.
    #[arg(long)]
    accumulator: String,
    /// The EAS contract address.
    #[arg(long)]
    eas: String,
    /// The checkpoint id to reconstruct.
    #[arg(long)]
    checkpoint: u64,
    /// Path to the governance-pinned params (serialized `pagerank_core::Params`).
    #[arg(long)]
    params: String,
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
    /// Lane 2: envelope-0 witness JSON files (from envelope0-gen), repeatable. Heads whose data
    /// is not supplied here degrade via rule Φ in-guest (that is the withholding path, not an
    /// error).
    #[arg(long)]
    envelope0_log: Vec<String>,
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
    let rpc = Rpc::new(args.rpc.clone());
    let accumulator = parse_addr(&args.accumulator)?;
    let eas = parse_addr(&args.eas)?;

    let mut params: Params = serde_json::from_str(&std::fs::read_to_string(&args.params)?)
        .context("failed to parse --params as pagerank_core::Params")?;

    // Params-schema v2 domain separation (INSTANCE_FACTORY §6.1): the accumulator address and the
    // chain id are properties of the instance being exported, not of the governance file, so they
    // come from the connection we are actually reading. A file that names a *different* instance is
    // a misconfiguration (it would silently produce a proof for someone else's snapshot), so it is
    // an error rather than an override.
    let chain_id = rpc.eth_chain_id().await.context("eth_chainId failed")?;
    if params.accumulator != Address::ZERO && params.accumulator != accumulator {
        bail!(
            "--params names accumulator {:#x} but --accumulator is {:#x}",
            params.accumulator,
            accumulator
        );
    }
    if params.chain_id != 0 && params.chain_id != chain_id {
        bail!("--params names chain {} but --rpc is chain {}", params.chain_id, chain_id);
    }
    params.accumulator = accumulator;
    params.chain_id = chain_id;
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

    // 3. Candidate edges from EAS attestations to the pinned schema.
    let attested = rpc
        .get_logs(
            eas,
            &[Some(Attested::SIGNATURE_HASH), None, None, Some(params.schema_uid)],
            args.from_block,
            to_block,
            args.chunk,
        )
        .await
        .context("querying EAS Attested logs")?;
    let mut uids: BTreeSet<B256> = BTreeSet::new();
    for log in &attested {
        let ev = Attested::decode_raw_log(log.topics.iter().copied(), &log.data)
            .context("decoding Attested")?;
        uids.insert(ev.uid);
    }
    eprintln!("found {} attestations for the schema; fetching records...", uids.len());

    let mut candidates: Vec<RawEdge> = Vec::new();
    for uid in &uids {
        let ret = rpc
            .eth_call(eas, getAttestationCall { uid: *uid }.abi_encode())
            .await
            .with_context(|| format!("getAttestation({uid:#x}) failed"))?;
        let a = Attestation::abi_decode(&ret).context("decoding Attestation")?;
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
        // Revoke edge (folded in onRevoke at revocationTime), if revoked. Leaf-matching drops it if
        // the revoke happened after this checkpoint.
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
    let lane2: Option<Lane2Witness> = if let Some(reg) = &args.anchor_registry {
        let registry = parse_addr(reg)?;
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
        let mut indexed: Vec<(u64, AnchorRecord)> = Vec::new();
        for log in &anchor_logs {
            let ev = HeadAnchored::decode_raw_log(log.topics.iter().copied(), &log.data)
                .context("decoding HeadAnchored")?;
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
            ));
        }
        indexed.sort_by_key(|(i, _)| *i);
        for (want, (got, _)) in indexed.iter().enumerate() {
            if *got != want as u64 {
                bail!("HeadAnchored indices not contiguous: expected {want}, found {got}");
            }
        }
        let anchors: Vec<AnchorRecord> = indexed.into_iter().map(|(_, a)| a).collect();

        // Self-check the re-fold against the checkpointed anchorAcc, when a snapshot is given.
        if let Some(snap) = &args.snapshot {
            let snapshot = parse_addr(snap)?;
            let ret = rpc
                .eth_call(
                    snapshot,
                    anchorCheckpointsCall { checkpointId: U256::from(args.checkpoint) }
                        .abi_encode(),
                )
                .await
                .context("anchorCheckpoints failed")?;
            let cp2 = anchorCheckpointsCall::abi_decode_returns(&ret)
                .context("decoding anchorCheckpoints")?;
            let mut acc2 = B256::ZERO;
            for a in &anchors {
                let leaf = zk_core::anchor::anchor_leaf(
                    a.node_id,
                    a.envelope_kind,
                    a.head,
                    a.count,
                    a.data_commitment,
                    a.block_timestamp,
                );
                acc2 = zk_core::fold::fold(acc2, leaf);
            }
            if acc2 != cp2.anchorAcc || anchors.len() as u64 != cp2.anchorCount {
                bail!(
                    "anchor re-fold mismatch: local acc={acc2:#x} count={} vs checkpointed acc={:#x} count={}",
                    anchors.len(), cp2.anchorAcc, cp2.anchorCount
                );
            }
            eprintln!("anchor re-fold self-check OK: matches checkpointed anchorAcc ✓");
        }

        let mut envelopes = Vec::new();
        for path in &args.envelope0_log {
            let w: envelopes_crate::eas_offchain::Envelope0Witness =
                serde_json::from_str(&std::fs::read_to_string(path)?)
                    .with_context(|| format!("failed to parse {path} as Envelope0Witness"))?;
            envelopes.push(w);
        }
        eprintln!("lane 2: {} anchors, {} envelope witnesses", anchors.len(), envelopes.len());
        Some(Lane2Witness { anchors, envelopes })
    } else {
        None
    };

    // 5. Emit. Default paths live under the repo's gitignored `.trustgraph/` output directory,
    // resolved from this crate's manifest dir so they land there from any CWD.
    let out_path = match &args.out {
        Some(o) => std::path::PathBuf::from(o),
        None => {
            let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
            if args.signer {
                root.join(".trustgraph/signer-sync/signer_input.json")
            } else {
                root.join(".trustgraph/trust-graph/input.json")
            }
        }
    };
    if let Some(parent) = out_path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let out_json = if let Some(selection) = selection {
        // The signer journal carries no bounty recipient (`SignerSyncZkModule` pays none) but DOES
        // bind the module's instance domain (audit M-3), derived above from --module + chainId.
        let instance_domain = signer_domain.expect("--signer guarantees signer_domain");
        serde_json::to_string_pretty(&SignerInput { edges, params, selection, instance_domain })?
    } else {
        serde_json::to_string_pretty(&GuestInput { edges, params, lane2, binding })?
    };
    std::fs::write(&out_path, out_json)?;
    eprintln!("wrote {} ({} edges)", out_path.display(), cp.leafCount);
    Ok(())
}
