//! Contributions root-producer program: proves stage-1 reputation (the canonical `pagerank-core`
//! Trust-Aware PageRank over the trust accumulator's vouch edges) + stage-2 rep-weighted budgeted
//! valuation with consent/collaborator discounts and the evaluator carve-out
//! (`contributions-core`, docs/contributions/INTERFACES.md), and emits the journal-v2 merkle root
//! + payout blob. Mirrors `trust_graph.rs`/`hypercerts.rs`; the built-in sample is the 6-persona
//! worked example (`contributions_core::testutil::fixture()`), identical to
//! `test/golden/contributions.json`'s `compute` family, so `execute`/`prove` run with no external
//! witness.
//!
//! `fetch` (host-only, network; build with `--features fetch`) reconstructs `input.json` from the
//! two on-chain checkpoints of a contributions instance the way `packages/input-exporter` does for
//! the trust program: slot A (trust edges) from the trust accumulator's `EdgeFolded` log behind
//! the instance's `TrustAccumulatorMirror` checkpoint, slot B (contribution records) from the
//! `ContributionResolver`'s `EdgeFolded` log behind the snapshot's `anchorCheckpoints` freeze —
//! each self-checked by re-folding to the checkpointed `(acc, leafCount)` before anything is
//! emitted.

use alloy_primitives::{Address, B256, U256};
use anyhow::{anyhow, Context, Result};
use clap::Subcommand;
use contributions_core::compute::{compute, GuestInput};
use contributions_core::{params, Params};
use pagerank_core::encode;
use sp1_sdk::{include_elf, Elf};

use crate::common;

/// The contributions guest ELF, built by build.rs (`sp1_build::build_program`).
fn load_elf() -> Elf {
    include_elf!("trustgraph-contributions-program")
}

/// The built-in sample scenario: the 6-persona worked example (matches the `compute` family of
/// test/golden/contributions.json — the cross-lane oracle fixture).
pub fn sample_input() -> GuestInput {
    contributions_core::testutil::fixture()
}

fn load_input(path: Option<&String>) -> Result<GuestInput> {
    match path {
        Some(p) => Ok(serde_json::from_str(&std::fs::read_to_string(p)?)?),
        None => Ok(sample_input()),
    }
}

// ---------------------------------------------------------------------------
// Params JSON → contributions_core::Params (tolerant, field-by-field)
// ---------------------------------------------------------------------------
//
// Three params-file shapes exist in the repo and all must load:
//   1. the camelCase golden-vector shape (test/golden/contributions.json
//      `.compute.input.params`; decimal-string U256s, numeric u32/u64s),
//   2. the crate's native serde shape (snake_case; 0x-hex U256s),
//   3. the deploy template (test/e2e/params.contributions.template.json;
//      snake_case with EVERY numeric as a 0x-hex string — the Solidity
//      `ContributionsParamsJson` reader's shape, written back by
//      DeployContributionsInstance with the registered schema UIDs).
// Keys are looked up camelCase-first then snake_case; numerics accept JSON
// numbers, decimal strings, and 0x-hex strings. Extra keys are ignored.

fn b256(s: &str) -> Result<B256> {
    s.parse::<B256>().map_err(|e| anyhow!("invalid bytes32 {s:?}: {e}"))
}

fn field<'a>(
    obj: &'a serde_json::Map<String, serde_json::Value>,
    camel: &str,
    snake: &str,
) -> Result<&'a serde_json::Value> {
    obj.get(camel)
        .or_else(|| obj.get(snake))
        .ok_or_else(|| anyhow!("params JSON is missing {camel:?}/{snake:?}"))
}

fn as_u256(v: &serde_json::Value) -> Result<U256> {
    match v {
        serde_json::Value::String(s) => {
            s.parse::<U256>().map_err(|e| anyhow!("invalid uint256 {s:?}: {e}"))
        }
        serde_json::Value::Number(n) => {
            Ok(U256::from(n.as_u64().ok_or_else(|| anyhow!("non-u64 number {n}"))?))
        }
        other => Err(anyhow!("expected uint256 string or number, got {other}")),
    }
}

fn as_u64(v: &serde_json::Value) -> Result<u64> {
    let x = as_u256(v)?;
    u64::try_from(x).map_err(|_| anyhow!("value {x} overflows u64"))
}

fn as_u32(v: &serde_json::Value) -> Result<u32> {
    let x = as_u256(v)?;
    u32::try_from(x).map_err(|_| anyhow!("value {x} overflows u32"))
}

fn as_b256(v: &serde_json::Value) -> Result<B256> {
    b256(v.as_str().ok_or_else(|| anyhow!("expected bytes32 string, got {v}"))?)
}

fn as_addr_vec(v: &serde_json::Value) -> Result<Vec<Address>> {
    v.as_array()
        .ok_or_else(|| anyhow!("expected an address array, got {v}"))?
        .iter()
        .map(|a| {
            let s = a.as_str().ok_or_else(|| anyhow!("expected address string, got {a}"))?;
            s.parse::<Address>().map_err(|e| anyhow!("invalid address {s:?}: {e}"))
        })
        .collect()
}

/// Load a params file (any of the three shapes above). Omitted → the fixture's params.
fn load_params(path: Option<&String>) -> Result<Params> {
    let Some(p) = path else { return Ok(sample_input().params) };
    let raw = std::fs::read_to_string(p)?;
    let v: serde_json::Value =
        serde_json::from_str(&raw).with_context(|| format!("{p} is not valid JSON"))?;
    let o = v.as_object().ok_or_else(|| anyhow!("{p} is not a JSON object"))?;
    Ok(Params {
        damping_fp: as_u256(field(o, "dampingFp", "damping_fp")?)?,
        tolerance_fp: as_u256(field(o, "toleranceFp", "tolerance_fp")?)?,
        max_iterations: as_u32(field(o, "maxIterations", "max_iterations")?)?,
        min_weight_fp: as_u256(field(o, "minWeightFp", "min_weight_fp")?)?,
        max_weight_fp: as_u256(field(o, "maxWeightFp", "max_weight_fp")?)?,
        trust_multiplier_fp: as_u256(field(o, "trustMultiplierFp", "trust_multiplier_fp")?)?,
        trust_share_fp: as_u256(field(o, "trustShareFp", "trust_share_fp")?)?,
        trust_decay_fp: as_u256(field(o, "trustDecayFp", "trust_decay_fp")?)?,
        trusted_seeds: as_addr_vec(field(o, "trustedSeeds", "trusted_seeds")?)?,
        precision_scale: as_u256(field(o, "precisionScale", "precision_scale")?)?,
        weight_field_index: as_u32(field(o, "weightFieldIndex", "weight_field_index")?)?,
        round_start: as_u64(field(o, "roundStart", "round_start")?)?,
        round_end: as_u64(field(o, "roundEnd", "round_end")?)?,
        unaccepted_mult_fp: as_u256(field(o, "unacceptedMultFp", "unaccepted_mult_fp")?)?,
        collaborator_mult_fp: as_u256(field(o, "collaboratorMultFp", "collaborator_mult_fp")?)?,
        min_rater_rep_fp: as_u256(field(o, "minRaterRepFp", "min_rater_rep_fp")?)?,
        evaluator_carveout_bps: as_u32(field(
            o,
            "evaluatorCarveoutBps",
            "evaluator_carveout_bps",
        )?)?,
        total_pool: as_u256(field(o, "totalPool", "total_pool")?)?,
        claim_schema_uid: as_b256(field(o, "claimSchemaUid", "claim_schema_uid")?)?,
        response_schema_uid: as_b256(field(o, "responseSchemaUid", "response_schema_uid")?)?,
        valuation_schema_uid: as_b256(field(o, "valuationSchemaUid", "valuation_schema_uid")?)?,
    })
}

/// `contributions` subcommands. `input.json` is a serialized
/// `contributions_core::compute::GuestInput`; omit it to use the built-in sample (the 6-persona
/// worked example; identical to test/golden/contributions.json `.compute`).
#[derive(Subcommand)]
pub enum Command {
    /// Print the guest program verification key (bytes32) for deployment.
    Vkey,
    /// Print keccak256 of the canonical params (21-word tuple, INTERFACES.md §3). Accepts the
    /// camelCase golden-vector shape or the crate's native serde shape.
    Paramshash { params: Option<String> },
    /// Reconstruct input.json from a contributions instance's two on-chain checkpoints (slot A =
    /// trust accumulator via the snapshot's TrustAccumulatorMirror, slot B = the
    /// ContributionResolver's accumulator freeze). Requires `--features fetch`.
    Fetch {
        /// JSON-RPC endpoint (or RPC_URL env).
        #[arg(long, env = "RPC_URL")]
        rpc: String,
        /// The contributions MerkleSnapshot address (its `accumulator` is the mirror; its
        /// `anchorRegistry` is the ContributionResolver).
        #[arg(long, env = "CONTRIBUTIONS_MERKLE_SNAPSHOT")]
        snapshot: String,
        /// The EAS contract address (candidate attestations for both lanes).
        #[arg(long, env = "EAS_ADDRESS")]
        eas: String,
        /// The checkpoint id to reconstruct.
        #[arg(long)]
        checkpoint: u64,
        /// The round params JSON (camelCase golden shape or native). The three contribution
        /// schema UIDs come from here; MUST hash to the snapshot's pinned paramsHash.
        #[arg(long)]
        params: String,
        /// The trust (vouch) schema UID; narrows the lane-A candidate scan. Omit to consider
        /// every attestation (leaf-matching drops extras).
        #[arg(long)]
        trust_schema_uid: Option<String>,
        /// First block to scan for events (accumulator deploy block, for speed).
        #[arg(long, default_value_t = 0)]
        from_block: u64,
        /// Max blocks per eth_getLogs request (many RPCs cap the range).
        #[arg(long, default_value_t = 10_000)]
        chunk: u64,
        /// Journal-v3 bounty payee, committed verbatim by the guest and bound by `submitProof`.
        /// Defaults to the zero address ("no bounty"), which is correct for a curated instance or
        /// a community self-proving. The other half of the binding, `instanceDomain`, is derived
        /// from `--snapshot` + the chain id and is never typed in.
        #[arg(long)]
        recipient: Option<String>,
        /// Output path (default: `<repo root>/.trustgraph/contributions/contributions_input.json`).
        #[arg(long)]
        out: Option<String>,
    },
    /// Run the guest via the SP1 executor and assert it matches native `compute` (no proof).
    Execute {
        input: Option<String>,
        /// Output directory (default: `<repo root>/.trustgraph/contributions/`).
        #[arg(long)]
        out_dir: Option<String>,
    },
    /// Generate a proof (core, or Groth16-wrapped), verify it locally, and write the on-chain
    /// proof blob `abi.encode(publicValues, seal)` to contributions_proof.bin.
    Prove {
        input: Option<String>,
        #[arg(long)]
        groth16: bool,
        /// Output directory (default: `<repo root>/.trustgraph/contributions/`).
        #[arg(long)]
        out_dir: Option<String>,
    },
}

/// The default generated-output directory for this program.
const OUT_DIR: &str = "contributions";

pub fn run(cmd: Command) -> Result<()> {
    match cmd {
        Command::Vkey => common::print_vkey(load_elf()),
        Command::Paramshash { params: p } => {
            let p = load_params(p.as_ref())?;
            println!("0x{}", hex::encode(params::params_hash(&p)));
            Ok(())
        }
        #[cfg(feature = "fetch")]
        Command::Fetch {
            rpc,
            snapshot,
            eas,
            checkpoint,
            params,
            trust_schema_uid,
            from_block,
            chunk,
            recipient,
            out,
        } => {
            let out = match out {
                Some(o) => o,
                None => common::out_dir(None, OUT_DIR)?
                    .join("contributions_input.json")
                    .display()
                    .to_string(),
            };
            fetch::run(fetch::Args {
                rpc,
                snapshot,
                eas,
                checkpoint,
                params,
                trust_schema_uid,
                from_block,
                chunk,
                recipient,
                out,
            })
        }
        #[cfg(not(feature = "fetch"))]
        Command::Fetch { .. } => Err(anyhow!(
            "the fetch subcommand needs the on-chain reconstruction plumbing; rebuild with \
             `cargo build --release --features fetch` (kept out of the lean default build like \
             witness-atproto)."
        )),
        Command::Execute { input, out_dir } => {
            cmd_execute(load_input(input.as_ref())?, common::out_dir(out_dir.as_ref(), OUT_DIR)?)
        }
        Command::Prove { input, groth16, out_dir } => cmd_prove(
            load_input(input.as_ref())?,
            groth16,
            common::out_dir(out_dir.as_ref(), OUT_DIR)?,
        ),
    }
}

fn cmd_execute(input: GuestInput, out: std::path::PathBuf) -> Result<()> {
    let native = compute(&input);
    let native_pub = encode::journal_encoded(&native.journal);

    common::execute_and_check(load_elf(), &input, &native_pub)?;

    println!("journalDigest: 0x{}", hex::encode(encode::journal_digest(&native.journal)));
    println!("acc:           0x{}", hex::encode(native.journal.acc));
    println!("anchorAcc:     0x{}", hex::encode(native.journal.anchor_acc));
    println!("outputRoot:    0x{}", hex::encode(native.journal.output_root));
    println!("paramsHash:    0x{}", hex::encode(native.journal.params_hash));
    println!("ipfsHash:      0x{}", hex::encode(native.journal.ipfs_hash));
    println!("cid:           {}", native.cid);
    println!("totalValue:    {}", native.journal.total_value);
    println!("skippedDigest: 0x{}", hex::encode(native.journal.skipped_digest));
    // The two journal-v3 pass-throughs. `submitProof` takes `recipient` as an argument and folds
    // it into the digest, so a submitter must echo exactly what the guest committed.
    println!("recipient:     0x{}", hex::encode(native.journal.recipient));
    println!("instanceDomain: 0x{}", hex::encode(native.journal.instance_domain));

    // The canonical payout blob whose sha256 is `ipfsHash` and whose CID is `cid`. Write it out so
    // it can be pinned (the UI/indexer fetch the {account -> payout} split from IPFS at that cid).
    let p = common::write_out(&out, "contributions_blob.json", &native.blob)?;
    println!("wrote {} ({} bytes) — pin at the cid above", p.display(), native.blob.len());
    Ok(())
}

fn cmd_prove(input: GuestInput, groth16: bool, out: std::path::PathBuf) -> Result<()> {
    // The payout blob is a pure function of the input; recompute it here so `prove` emits the
    // blob next to proof.bin (same bytes execute writes — its sha256 is the journal's ipfsHash).
    let native = compute(&input);

    let (public_values, seal) = common::prove_and_verify(load_elf(), &input, groth16)?;

    let blob = common::abi_encode_two_bytes(&public_values, &seal);
    let proof_path = common::write_out(&out, "contributions_proof.bin", &blob)?;
    common::write_out(&out, "contributions_public_values.bin", &public_values)?;
    let blob_path = common::write_out(&out, "contributions_blob.json", &native.blob)?;
    println!(
        "wrote {} ({} blob bytes, {} seal bytes)",
        proof_path.display(),
        blob.len(),
        seal.len()
    );
    println!(
        "wrote {} ({} bytes) — pin at the cid for the UI",
        blob_path.display(),
        native.blob.len()
    );
    println!("publicValues: 0x{}", hex::encode(&public_values));
    Ok(())
}

// ---------------------------------------------------------------------------
// fetch — on-chain reconstruction (mirrors packages/input-exporter for slot A,
// and applies the same leaf-match + re-fold self-check to slot B)
// ---------------------------------------------------------------------------

#[cfg(feature = "fetch")]
mod fetch {
    use super::{b256, load_params, GuestInput};
    use alloy_primitives::{hex, keccak256, Address, B256, U256};
    use alloy_sol_types::{sol, SolCall, SolEvent, SolValue};
    use anyhow::{anyhow, bail, Context, Result};
    use contributions_core::kind;
    use pagerank_core::{encode, RawEdge};
    use serde_json::{json, Value};
    use std::collections::{BTreeMap, BTreeSet};

    sol! {
        struct Checkpoint { bytes32 acc; uint64 leafCount; uint64 blockNumber; }
        function getCheckpoint(uint256 id) external view returns (Checkpoint);
        function accumulator() external view returns (address);
        function anchorRegistry() external view returns (address);
        function anchorCheckpoints(uint256 checkpointId) external view returns (bytes32 anchorAcc, uint64 anchorCount);
        function trustAccumulator() external view returns (address);
        function paramsHash() external view returns (bytes32);

        struct Attestation {
            bytes32 uid; bytes32 schema; uint64 time; uint64 expirationTime;
            uint64 revocationTime; bytes32 refUID; address recipient; address attester;
            bool revocable; bytes data;
        }
        function getAttestation(bytes32 uid) external view returns (Attestation);

        event EdgeFolded(uint64 indexed index, bytes32 leaf, bytes32 acc);
        event Attested(address indexed recipient, address indexed attester, bytes32 uid, bytes32 indexed schemaUID);
    }

    pub struct Args {
        pub rpc: String,
        pub snapshot: String,
        pub eas: String,
        pub checkpoint: u64,
        pub params: String,
        pub trust_schema_uid: Option<String>,
        pub from_block: u64,
        pub chunk: u64,
        pub recipient: Option<String>,
        pub out: String,
    }

    struct Rpc {
        client: reqwest::blocking::Client,
        url: String,
    }

    struct RawLog {
        topics: Vec<B256>,
        data: Vec<u8>,
    }

    impl Rpc {
        fn call(&self, method: &str, params: Value) -> Result<Value> {
            let body = json!({"jsonrpc": "2.0", "id": 1, "method": method, "params": params});
            let resp: Value = self
                .client
                .post(&self.url)
                .json(&body)
                .send()?
                .json()
                .with_context(|| format!("{method} response was not valid JSON"))?;
            if let Some(e) = resp.get("error").filter(|e| !e.is_null()) {
                bail!("{method} RPC error: {e}");
            }
            Ok(resp.get("result").cloned().unwrap_or(Value::Null))
        }

        fn eth_chain_id(&self) -> Result<u64> {
            let r = self.call("eth_chainId", json!([]))?;
            let s = r.as_str().ok_or_else(|| anyhow!("eth_chainId returned no data"))?;
            Ok(u64::from_str_radix(s.trim_start_matches("0x"), 16)?)
        }

        fn eth_call(&self, to: Address, data: Vec<u8>) -> Result<Vec<u8>> {
            let params =
                json!([{ "to": to, "data": format!("0x{}", hex::encode(&data)) }, "latest"]);
            let r = self.call("eth_call", params)?;
            let s = r.as_str().ok_or_else(|| anyhow!("eth_call returned no data"))?;
            Ok(hex::decode(s.trim_start_matches("0x"))?)
        }

        /// eth_getLogs across `[from, to]`, chunked to `chunk` blocks. `topics` may contain nulls.
        fn get_logs(
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
                let r = self.call("eth_getLogs", params)?;
                for log in r.as_array().ok_or_else(|| anyhow!("eth_getLogs non-array"))? {
                    let topics = log["topics"]
                        .as_array()
                        .ok_or_else(|| anyhow!("log missing topics"))?
                        .iter()
                        .map(|t| b256(t.as_str().unwrap_or("")))
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

    /// The `EdgeFolded` leaves of one accumulator in fold-index order, truncated to
    /// `leaf_count` (contiguity-checked — missing events fail loud).
    fn ordered_leaves(
        rpc: &Rpc,
        accumulator: Address,
        leaf_count: u64,
        from_block: u64,
        to_block: u64,
        chunk: u64,
        what: &str,
    ) -> Result<Vec<B256>> {
        let logs = rpc
            .get_logs(accumulator, &[Some(EdgeFolded::SIGNATURE_HASH)], from_block, to_block, chunk)
            .with_context(|| format!("querying {what} EdgeFolded logs"))?;
        let mut indexed: Vec<(u64, B256)> = Vec::new();
        for log in &logs {
            let ev = EdgeFolded::decode_raw_log(log.topics.iter().copied(), &log.data)
                .context("decoding EdgeFolded")?;
            if ev.index < leaf_count {
                indexed.push((ev.index, ev.leaf));
            }
        }
        indexed.sort_by_key(|(i, _)| *i);
        for (want, (got, _)) in indexed.iter().enumerate() {
            if *got != want as u64 {
                bail!("{what} EdgeFolded indices not contiguous: expected {want}, found {got}");
            }
        }
        if indexed.len() as u64 != leaf_count {
            bail!(
                "expected {leaf_count} folded {what} leaves for the checkpoint, found {}",
                indexed.len()
            );
        }
        Ok(indexed.into_iter().map(|(_, leaf)| leaf).collect())
    }

    /// Assemble a checkpoint's exact ordered edge set from its fold leaves + candidate edges,
    /// and prove the assembly by re-folding to the checkpointed `(acc, leafCount)` — the same
    /// refuse-to-emit discipline as `input-exporter::reconstruct`.
    fn reconstruct(
        ordered: &[B256],
        candidates: &[RawEdge],
        cp_acc: B256,
        cp_leaf_count: u64,
        what: &str,
    ) -> Result<Vec<RawEdge>> {
        let mut by_leaf: BTreeMap<B256, &RawEdge> = BTreeMap::new();
        for e in candidates {
            let leaf = encode::edge_leaf(
                e.kind,
                e.attester,
                e.recipient,
                e.uid,
                e.block_timestamp,
                keccak256(&e.data),
            );
            by_leaf.insert(leaf, e);
        }
        let mut edges = Vec::with_capacity(ordered.len());
        for (i, leaf) in ordered.iter().enumerate() {
            match by_leaf.get(leaf) {
                Some(e) => edges.push((*e).clone()),
                None => bail!(
                    "no reconstructed {what} record reproduces folded leaf #{i} ({leaf:#x}): the \
                     candidate set is incomplete (missing attestation/revocation) or a field \
                     (kind/attester/recipient/uid/timestamp/data) is wrong. Check the schema \
                     UIDs and the from-block range."
                ),
            }
        }
        let (acc, n) = encode::accumulate(&edges);
        if acc != cp_acc || n != cp_leaf_count {
            bail!(
                "{what} reconstruction self-check FAILED: re-folded acc {acc:#x} (n={n}) != \
                 checkpointed acc {cp_acc:#x} (count={cp_leaf_count})."
            );
        }
        Ok(edges)
    }

    /// Candidate edges from EAS `Attested` logs (optionally schema-filtered) + `getAttestation`,
    /// with `kind_of(schema)` mapping each schema to its attest kind (revoke = attest + 1);
    /// `None` skips the attestation.
    fn candidates(
        rpc: &Rpc,
        eas: Address,
        schema_filter: Option<B256>,
        kind_of: impl Fn(B256) -> Option<u8>,
        from_block: u64,
        to_block: u64,
        chunk: u64,
    ) -> Result<Vec<RawEdge>> {
        let logs = rpc
            .get_logs(
                eas,
                &[Some(Attested::SIGNATURE_HASH), None, None, schema_filter],
                from_block,
                to_block,
                chunk,
            )
            .context("querying EAS Attested logs")?;
        let mut uids: BTreeSet<B256> = BTreeSet::new();
        for log in &logs {
            let ev = Attested::decode_raw_log(log.topics.iter().copied(), &log.data)
                .context("decoding Attested")?;
            uids.insert(ev.uid);
        }
        let mut out: Vec<RawEdge> = Vec::new();
        for uid in &uids {
            let ret = rpc
                .eth_call(eas, getAttestationCall { uid: *uid }.abi_encode())
                .with_context(|| format!("getAttestation({uid:#x}) failed"))?;
            let a = Attestation::abi_decode(&ret).context("decoding Attestation")?;
            let Some(attest_kind) = kind_of(a.schema) else { continue };
            let data = a.data.to_vec();
            // Attest edge (folded in onAttest at attestation.time).
            out.push(RawEdge {
                kind: attest_kind,
                attester: a.attester,
                recipient: a.recipient,
                uid: *uid,
                block_timestamp: a.time,
                data: data.clone(),
            });
            // Revoke edge (folded in onRevoke at revocationTime), if revoked. Leaf-matching
            // drops it if the revoke happened after this checkpoint.
            if a.revocationTime != 0 {
                out.push(RawEdge {
                    kind: attest_kind + 1,
                    attester: a.attester,
                    recipient: a.recipient,
                    uid: *uid,
                    block_timestamp: a.revocationTime,
                    data,
                });
            }
        }
        Ok(out)
    }

    pub fn run(args: Args) -> Result<()> {
        let rpc = Rpc { client: reqwest::blocking::Client::new(), url: args.rpc.clone() };
        let snapshot: Address = args.snapshot.parse().context("--snapshot")?;
        let eas: Address = args.eas.parse().context("--eas")?;
        let p = load_params(Some(&args.params))?;

        // Wiring is read off the snapshot itself: accumulator() = the TrustAccumulatorMirror
        // (slot A), anchorRegistry() = the ContributionResolver (slot B).
        let mirror = accumulatorCall::abi_decode_returns(
            &rpc.eth_call(snapshot, accumulatorCall {}.abi_encode())?,
        )
        .context("decoding accumulator()")?;
        let resolver = anchorRegistryCall::abi_decode_returns(
            &rpc.eth_call(snapshot, anchorRegistryCall {}.abi_encode())?,
        )
        .context("decoding anchorRegistry()")?;
        if resolver == Address::ZERO {
            bail!("snapshot {snapshot} has no anchorRegistry — not a contributions instance");
        }
        let trust_acc = trustAccumulatorCall::abi_decode_returns(
            &rpc.eth_call(mirror, trustAccumulatorCall {}.abi_encode())?,
        )
        .context("decoding trustAccumulator() — is accumulator() a TrustAccumulatorMirror?")?;

        // Fail early if the supplied params don't hash to the snapshot's pinned paramsHash: a
        // mismatched round window/pool would prove a journal submitProof rejects.
        let ph = contributions_core::params::params_hash(&p);
        let pinned = paramsHashCall::abi_decode_returns(
            &rpc.eth_call(snapshot, paramsHashCall {}.abi_encode())?,
        )
        .context("decoding paramsHash()")?;
        if ph != pinned {
            eprintln!(
                "WARNING: params_hash(--params) = {ph:#x} != snapshot.paramsHash() = {pinned:#x} \
                 — the proof will verify but submitProof will reject it."
            );
        }

        // Slot A freeze: the mirror's checkpoint of the TRUST accumulator.
        let cp = Checkpoint::abi_decode(&rpc.eth_call(
            mirror,
            getCheckpointCall { id: U256::from(args.checkpoint) }.abi_encode(),
        )?)
        .context("decoding mirror getCheckpoint")?;
        let to_block = cp.blockNumber;
        eprintln!(
            "checkpoint #{}: trust acc={:#x} leafCount={} block={}",
            args.checkpoint, cp.acc, cp.leafCount, to_block
        );

        // Slot B freeze: the snapshot's anchorCheckpoints entry (the contribution accumulator).
        let ac = anchorCheckpointsCall::abi_decode_returns(&rpc.eth_call(
            snapshot,
            anchorCheckpointsCall { checkpointId: U256::from(args.checkpoint) }.abi_encode(),
        )?)
        .context("decoding anchorCheckpoints")?;
        eprintln!(
            "checkpoint #{}: contrib acc={:#x} count={}",
            args.checkpoint, ac.anchorAcc, ac.anchorCount
        );

        // Trust edges (slot A): EdgeFolded log of the trust accumulator + EAS candidates.
        let trust_leaves = ordered_leaves(
            &rpc,
            trust_acc,
            cp.leafCount,
            args.from_block,
            to_block,
            args.chunk,
            "trust",
        )?;
        let trust_filter = args.trust_schema_uid.as_ref().map(|s| b256(s)).transpose()?;
        let trust_candidates = candidates(
            &rpc,
            eas,
            trust_filter,
            // Trust lane: every candidate is a plain vouch edge (kind 0 attest / 1 revoke);
            // when unfiltered, foreign-schema extras are dropped by leaf-matching.
            |_schema| Some(0),
            args.from_block,
            to_block,
            args.chunk,
        )?;
        let trust_edges =
            reconstruct(&trust_leaves, &trust_candidates, cp.acc, cp.leafCount, "trust")?;
        eprintln!("trust reconstruction self-check OK: re-folded acc == checkpointed acc ✓");

        // Contribution records (slot B): EdgeFolded log of the ContributionResolver + EAS
        // candidates for the three allowlisted schemas, kind = schemaIndex * 2 (+ 1 revoke).
        let record_leaves = ordered_leaves(
            &rpc,
            resolver,
            ac.anchorCount,
            args.from_block,
            to_block,
            args.chunk,
            "contribution",
        )?;
        let (cs, rs, vs) = (p.claim_schema_uid, p.response_schema_uid, p.valuation_schema_uid);
        let record_candidates = candidates(
            &rpc,
            eas,
            None,
            move |schema| {
                if schema == cs {
                    Some(kind::kind(kind::SCHEMA_CLAIM, false))
                } else if schema == rs {
                    Some(kind::kind(kind::SCHEMA_RESPONSE, false))
                } else if schema == vs {
                    Some(kind::kind(kind::SCHEMA_VALUATION, false))
                } else {
                    None
                }
            },
            args.from_block,
            to_block,
            args.chunk,
        )?;
        let records = reconstruct(
            &record_leaves,
            &record_candidates,
            ac.anchorAcc,
            ac.anchorCount,
            "contribution",
        )?;
        eprintln!("contribution reconstruction self-check OK: re-folded acc == anchorAcc ✓");

        // Journal-v3 bindings. `instanceDomain` is derived from the snapshot this input will be
        // proven against and the chain it lives on, byte-identically to the rebuild inside
        // `MerkleSnapshot.submitProof`, so a wrong snapshot fails here rather than after paying
        // for a proof.
        let recipient: Address = match &args.recipient {
            Some(r) => r.parse().context("--recipient")?,
            None => Address::ZERO,
        };
        let chain_id = rpc.eth_chain_id().context("eth_chainId failed")?;
        let binding = pagerank_core::Binding {
            recipient,
            instance_domain: pagerank_core::encode::instance_domain(snapshot, chain_id),
        };
        eprintln!(
            "journal v3: snapshot={snapshot:#x} recipient={recipient:#x} instanceDomain={:#x}",
            binding.instance_domain
        );

        let input = GuestInput { trust_edges, records, params: p, binding };
        std::fs::write(&args.out, serde_json::to_string_pretty(&input)?)?;
        eprintln!(
            "wrote {} ({} trust edges, {} contribution records)",
            args.out,
            input.trust_edges.len(),
            input.records.len()
        );
        Ok(())
    }
}
