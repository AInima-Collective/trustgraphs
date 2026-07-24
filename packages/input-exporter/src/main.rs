//! input-exporter — reconstruct `input.json` (a `GuestInput`/`SignerInput`) from on-chain state.
//!
//! Reads the accumulator's `EdgeFolded` events + EAS attestations up to a checkpoint, reassembles the
//! exact ordered edge set, self-verifies it re-folds to the checkpoint's `acc`, and writes the JSON
//! the prover consumes. See `zk/RUNBOOK.md`.

use alloy_primitives::{hex, Address, B256, U256};
use alloy_sol_types::{sol, SolCall, SolEvent, SolValue};
use anyhow::{anyhow, bail, Context, Result};
use clap::Parser;
use input_exporter::reconstruct;
use pagerank_core::{
    AnchorRecord, GuestInput, Lane2Witness, Params, RawEdge, SelectionParams, SignerInput,
};
use serde_json::{json, Value};
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

    event HeadAnchored(uint64 indexed foldIndex, bytes32 indexed nodeId, uint8 envelopeKind, bytes32 head, bytes32 dataCommitment, uint256 blockTimestamp);
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
    /// Lane 2: the MerkleSnapshot address, to self-check the re-folded anchorAcc against the
    /// stored anchor checkpoint.
    #[arg(long)]
    snapshot: Option<String>,
}

struct Rpc {
    client: reqwest::Client,
    url: String,
}

struct RawLog {
    topics: Vec<B256>,
    data: Vec<u8>,
}

impl Rpc {
    async fn call(&self, method: &str, params: Value) -> Result<Value> {
        let body = json!({"jsonrpc": "2.0", "id": 1, "method": method, "params": params});
        let resp: Value = self
            .client
            .post(&self.url)
            .json(&body)
            .send()
            .await?
            .json()
            .await
            .with_context(|| format!("{method} response was not valid JSON"))?;
        if let Some(e) = resp.get("error").filter(|e| !e.is_null()) {
            bail!("{method} RPC error: {e}");
        }
        Ok(resp.get("result").cloned().unwrap_or(Value::Null))
    }

    async fn eth_call(&self, to: Address, data: Vec<u8>) -> Result<Vec<u8>> {
        let params = json!([{ "to": to, "data": format!("0x{}", hex::encode(&data)) }, "latest"]);
        let r = self.call("eth_call", params).await?;
        let s = r.as_str().ok_or_else(|| anyhow!("eth_call returned no data"))?;
        Ok(hex::decode(s.trim_start_matches("0x"))?)
    }

    /// eth_getLogs across `[from, to]`, chunked to `chunk` blocks. `topics` may contain nulls.
    async fn get_logs(
        &self,
        address: Address,
        topics: &[Option<B256>],
        from: u64,
        to: u64,
        chunk: u64,
    ) -> Result<Vec<RawLog>> {
        let topics_json: Vec<Value> = topics
            .iter()
            .map(|t| match t {
                Some(h) => json!(format!("0x{}", hex::encode(h))),
                None => Value::Null,
            })
            .collect();

        let mut out = Vec::new();
        let mut start = from;
        while start <= to {
            let end = (start.saturating_add(chunk - 1)).min(to);
            let params = json!([{
                "address": address,
                "topics": topics_json,
                "fromBlock": format!("0x{:x}", start),
                "toBlock": format!("0x{:x}", end),
            }]);
            let r = self.call("eth_getLogs", params).await?;
            for log in r.as_array().ok_or_else(|| anyhow!("eth_getLogs returned non-array"))? {
                let topics = log["topics"]
                    .as_array()
                    .ok_or_else(|| anyhow!("log missing topics"))?
                    .iter()
                    .map(|t| parse_b256(t.as_str().unwrap_or("")))
                    .collect::<Result<Vec<_>>>()?;
                let data =
                    hex::decode(log["data"].as_str().unwrap_or("0x").trim_start_matches("0x"))?;
                out.push(RawLog { topics, data });
            }
            start = end + 1;
        }
        Ok(out)
    }
}

fn parse_b256(s: &str) -> Result<B256> {
    let bytes = hex::decode(s.trim_start_matches("0x"))?;
    if bytes.len() != 32 {
        bail!("expected 32-byte topic, got {} bytes", bytes.len());
    }
    Ok(B256::from_slice(&bytes))
}

fn parse_addr(s: &str) -> Result<Address> {
    s.parse().with_context(|| format!("invalid address: {s}"))
}

#[tokio::main]
async fn main() -> Result<()> {
    let args = Args::parse();
    let rpc = Rpc { client: reqwest::Client::new(), url: args.rpc.clone() };
    let accumulator = parse_addr(&args.accumulator)?;
    let eas = parse_addr(&args.eas)?;

    let params: Params = serde_json::from_str(&std::fs::read_to_string(&args.params)?)
        .context("failed to parse --params as pagerank_core::Params")?;
    let selection: Option<SelectionParams> = match (args.signer, &args.selection) {
        (true, Some(p)) => Some(
            serde_json::from_str(&std::fs::read_to_string(p)?)
                .context("failed to parse --selection as pagerank_core::SelectionParams")?,
        ),
        (true, None) => bail!("--signer requires --selection <selection.json>"),
        (false, _) => None,
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
        serde_json::to_string_pretty(&SignerInput { edges, params, selection })?
    } else {
        serde_json::to_string_pretty(&GuestInput { edges, params, lane2 })?
    };
    std::fs::write(&out_path, out_json)?;
    eprintln!("wrote {} ({} edges)", out_path.display(), cp.leafCount);
    Ok(())
}
