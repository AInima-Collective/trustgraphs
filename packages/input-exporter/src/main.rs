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
use pagerank_core::{GuestInput, Params, RawEdge, SelectionParams, SignerInput};
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
    /// Output path.
    #[arg(long, default_value = "input.json")]
    out: String,
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
        let resp: Value =
            self.client.post(&self.url).json(&body).send().await?.json().await.with_context(
                || format!("{method} response was not valid JSON"),
            )?;
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
                let data = hex::decode(log["data"].as_str().unwrap_or("0x").trim_start_matches("0x"))?;
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
        .get_logs(accumulator, &[Some(EdgeFolded::SIGNATURE_HASH)], args.from_block, to_block, args.chunk)
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
            bail!("EdgeFolded indices not contiguous: expected {want}, found {got} (missing events?)");
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

    // 5. Emit.
    let out_json = if let Some(selection) = selection {
        serde_json::to_string_pretty(&SignerInput { edges, params, selection })?
    } else {
        serde_json::to_string_pretty(&GuestInput { edges, params })?
    };
    std::fs::write(&args.out, out_json)?;
    eprintln!("wrote {} ({} edges)", args.out, cp.leafCount);
    Ok(())
}
