//! The three programs, and the one thing that differs between them: how an input is built.
//!
//! Proving is shared — `trustgraph_prover::common` does it for every program, in-process, through
//! the library seam. Input reconstruction is not: trust-graph and signer read EAS attestations back
//! from `input-exporter`, contributions reads two checkpointed accumulators through the prover's
//! own `fetch`, and both of those are existing programs with their own re-fold self-checks.
//!
//! **Those self-checks are why this shells out rather than reimplementing.** `input-exporter`
//! refuses to emit an input whose edges do not re-fold to the checkpoint's `acc`; `contributions
//! fetch` does the same for both of its lanes. Reimplementing that reconstruction inside the
//! daemon would mean a second implementation of the one thing that must never be wrong, tested
//! half as well. Reuse is the conservative choice here, not the lazy one.

use alloy_primitives::{keccak256, Address, B256, U256};
use alloy_sol_types::{sol, SolCall};
use anyhow::{anyhow, bail, Context, Result};
use operator_core::catalog::CatalogEntry;
use operator_core::types::{InstanceState, Program, VaultView};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::process::Command;

use crate::chain::{Rpc, SnapshotView};
use crate::config::Config;

sol! {
    struct Quote {
        uint256 feeUsd; uint256 gasUsd; uint256 payableUsd; bool eligible; uint8 reason;
    }
    function quote(bytes32 instanceId, uint64 leafCount, uint64 anchorCount)
        external view returns (Quote);
}

/// An input ready to prove, and the two values the request journal needs before anything is spent.
pub struct Built {
    pub program: Program,
    pub input_path: PathBuf,
    /// `keccak256` of the public values the guest WILL commit, computed natively first (ground
    /// rule 4). Doubles as the content-addressed request key the ambiguous-window lookup matches
    /// on — see `operator_core::journal`.
    pub public_values_hash: B256,
    pub vk_hash: B256,
    pub output_root: B256,
    pub ipfs_hash: B256,
    pub cid: String,
    pub total_value: U256,
    pub skipped_digest: B256,
    pub recipient: Address,
    /// The canonical score blob the guest committed to (`ipfs_hash` is its sha256, `cid` its
    /// CIDv1). The ROOT is the proof; this is the data the root is about, and nothing can read a
    /// score without it — see [`pin`].
    pub blob: Vec<u8>,
}

/// A finished proof plus the fields the submit needs.
pub struct Proved {
    pub request_id: B256,
    pub blob: Vec<u8>,
    pub output_root: B256,
}

/// What a held proof needs to be submitted, reloaded after a restart.
#[derive(Serialize, Deserialize)]
pub struct HeldProof {
    pub output_root: B256,
    pub ipfs_hash: B256,
    pub cid: String,
    pub total_value: U256,
    pub skipped_digest: B256,
    pub recipient: Address,
    #[serde(with = "hex_bytes")]
    pub blob: Vec<u8>,
}

mod hex_bytes {
    use serde::{Deserialize, Deserializer, Serializer};
    pub fn serialize<S: Serializer>(b: &[u8], s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&format!("0x{}", hex::encode(b)))
    }
    pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<Vec<u8>, D::Error> {
        let s = String::deserialize(d)?;
        hex::decode(s.trim_start_matches("0x")).map_err(serde::de::Error::custom)
    }
}

fn out_dir(entry: &CatalogEntry, checkpoint_id: u64) -> PathBuf {
    PathBuf::from(".trustgraph/operator")
        .join(format!("{:#x}", entry.instance_id))
        .join(checkpoint_id.to_string())
}

/// Reconstruct this checkpoint's exact input set, then compute the journal natively.
pub fn build_input(
    cfg: &Config,
    rpc: &Rpc,
    entry: &CatalogEntry,
    _state: &InstanceState,
    checkpoint_id: u64,
) -> Result<Built> {
    // The snapshot's OWN answer, not the registry row's: `setAccumulator` is constitutional and
    // the directory copy may lag it. Reconstructing against the wrong lane produces an input that
    // cannot re-fold, which the exporter refuses — but only after the work.
    let view = crate::chain::read_snapshot(rpc, entry.snapshot)?;
    let accumulator = view.accumulator;
    // Lane 2, when this instance has one. Without it the exporter emits a lane-1-only input whose
    // journal commits the zero anchor pair, and `submitProof` binds the CHECKPOINTED pair — so the
    // digest would not match and the proof would be wasted.
    let anchor_args: Vec<String> = if view.anchor_registry == alloy_primitives::Address::ZERO {
        Vec::new()
    } else {
        vec!["--anchor-registry".into(), format!("{:#x}", view.anchor_registry)]
    };
    let dir = out_dir(entry, checkpoint_id);
    std::fs::create_dir_all(&dir)?;
    let input_path = dir.join("input.json");
    // A silently-failing build must not leave a STALE input for the next step to prove and submit
    // as if it were this checkpoint's.
    let _ = std::fs::remove_file(&input_path);

    let recipient = cfg.recipient();
    let params_path = params_path(entry)?;

    match entry.program {
        Program::TrustGraph | Program::Signer => {
            let eas = entry.eas.ok_or_else(|| {
                anyhow!("no EAS address for {}; add one to its manifest entry", entry.name)
            })?;
            run_tool(
                "cargo",
                vec![
                    "run",
                    "-q",
                    "-p",
                    "input-exporter",
                    "--",
                    "--rpc",
                    &cfg.rpc,
                    "--accumulator",
                    &format!("{:#x}", accumulator),
                    "--eas",
                    &format!("{eas:#x}"),
                    "--checkpoint",
                    &checkpoint_id.to_string(),
                    "--params",
                    &params_path,
                    "--snapshot",
                    &format!("{:#x}", entry.snapshot),
                    "--recipient",
                    &format!("{recipient:#x}"),
                    "--from-block",
                    &entry.created_block.to_string(),
                    "--out",
                    &input_path.display().to_string(),
                ]
                .into_iter()
                .chain(anchor_args.iter().map(|s| s.as_str()))
                .collect::<Vec<_>>(),
            )?;
        }
        Program::Contributions => {
            run_tool(
                "cargo",
                vec![
                    "run",
                    "-q",
                    "--release",
                    "--features",
                    "fetch",
                    "--manifest-path",
                    "zk/prover/Cargo.toml",
                    "--",
                    "contributions",
                    "fetch",
                    "--rpc",
                    &cfg.rpc,
                    "--snapshot",
                    &format!("{:#x}", entry.snapshot),
                    "--eas",
                    &format!("{:#x}", entry.eas.unwrap_or_default()),
                    "--checkpoint",
                    &checkpoint_id.to_string(),
                    "--params",
                    &params_path,
                    "--recipient",
                    &format!("{recipient:#x}"),
                    "--out",
                    &input_path.display().to_string(),
                ],
            )?;
        }
        Program::Hypercerts => {
            bail!("hypercerts is out of scope for this operator (GOAL scope fence)")
        }
    }

    if !input_path.exists() {
        bail!("input reconstruction produced no {}", input_path.display());
    }
    native_journal(entry.program, &input_path, recipient)
}

/// Compute the journal natively, before asking anyone to prove it.
fn native_journal(program: Program, input_path: &PathBuf, recipient: Address) -> Result<Built> {
    let text = std::fs::read_to_string(input_path)?;
    let (j, cid, vk, blob) = match program {
        Program::TrustGraph => {
            let input: pagerank_core::GuestInput = serde_json::from_str(&text)?;
            let r = pagerank_core::compute::compute(&input);
            let vk =
                trustgraph_prover::common::vkey(trustgraph_prover::programs::trust_graph::elf())?;
            (r.journal, r.cid, vk, r.blob)
        }
        Program::Contributions => {
            let input: contributions_core::compute::GuestInput = serde_json::from_str(&text)?;
            let r = contributions_core::compute::compute(&input);
            let vk =
                trustgraph_prover::common::vkey(trustgraph_prover::programs::contributions::elf())?;
            (r.journal, r.cid, vk, r.blob)
        }
        _ => bail!("{} does not produce a root journal here", program.name()),
    };

    if j.recipient != recipient {
        bail!("input names recipient {:#x}, config says {recipient:#x}", j.recipient);
    }

    let encoded = pagerank_core::encode::journal_encoded(&j);
    Ok(Built {
        program,
        input_path: input_path.clone(),
        public_values_hash: keccak256(&encoded),
        vk_hash: parse_b256(&vk)?,
        output_root: j.output_root,
        ipfs_hash: j.ipfs_hash,
        cid,
        total_value: j.total_value,
        skipped_digest: j.skipped_digest,
        recipient: j.recipient,
        blob,
    })
}

/// Publish the score blob so the root means something to a reader.
///
/// The chain carries the root, the sha256 and the CID — not the scores. Everything that renders a
/// member list (the indexer's `merkleMetadata`/`merkleEntry` ingestion, and therefore every network
/// page) fetches the blob by CID and gives up if it is not there. So a daemon that proves and
/// submits without publishing produces roots that are correct, verifiable, and unreadable: the
/// network page 404s and the community sees an empty roster over a valid proof.
///
/// The manual loop always did this by hand (`ipfs add --cid-version=1 --raw-leaves`, both in
/// `test/e2e/run.sh` and `taskfile/instances.sh`); the daemon replaced the loop and not that step.
///
/// Best-effort by design. A failed pin must NOT stop a root from landing: the proof is still valid
/// and someone else can publish the same bytes later (the CID is content-addressed, so anyone
/// re-deriving the blob reproduces it exactly). It alerts instead.
pub fn pin(cfg: &Config, built: &Built) -> Result<String> {
    let api = cfg.ipfs.api.as_deref().ok_or_else(|| anyhow::anyhow!("no [ipfs] api configured"))?;
    let url =
        format!("{}/api/v0/add?cid-version=1&raw-leaves=true&pin=true", api.trim_end_matches('/'));

    // Multipart by hand rather than pulling in a client: one field, known bytes.
    let boundary = "----trustgraph-operator-blob";
    let mut body = Vec::new();
    body.extend_from_slice(
        format!(
            "--{boundary}
Content-Disposition: form-data; name=\"file\"; filename=\"blob.json\"
Content-Type: application/json

"
        )
        .as_bytes(),
    );
    body.extend_from_slice(&built.blob);
    body.extend_from_slice(
        format!(
            "
--{boundary}--
"
        )
        .as_bytes(),
    );

    let resp = reqwest::blocking::Client::new()
        .post(&url)
        .header("Content-Type", format!("multipart/form-data; boundary={boundary}"))
        .body(body)
        .send()?;
    anyhow::ensure!(resp.status().is_success(), "ipfs add returned {}", resp.status());
    let v: serde_json::Value = resp.json()?;
    let got = v.get("Hash").and_then(|h| h.as_str()).unwrap_or_default().to_string();

    // The guest computed the CID in-circuit from these exact bytes. A mismatch means we just
    // published something the root does not commit to, which is worse than publishing nothing.
    anyhow::ensure!(
        got == built.cid,
        "ipfs returned CID {got}, the guest committed {} — refusing to call this published",
        built.cid
    );
    Ok(got)
}

/// Prove, with the guest-vs-native byte assert as the precondition.
pub fn prove(cfg: &Config, built: &Built) -> Result<Proved> {
    let text = std::fs::read_to_string(&built.input_path)?;
    let (proof, native_pub) = match built.program {
        Program::TrustGraph => {
            let input: pagerank_core::GuestInput = serde_json::from_str(&text)?;
            let native = pagerank_core::encode::journal_encoded(
                &pagerank_core::compute::compute(&input).journal,
            );
            let elf = trustgraph_prover::programs::trust_graph::elf();
            trustgraph_prover::common::execute_values(elf.clone(), &input, &native)?;
            (trustgraph_prover::common::prove_values(elf, &input, cfg.prover.groth16)?, native)
        }
        Program::Contributions => {
            let input: contributions_core::compute::GuestInput = serde_json::from_str(&text)?;
            let native = pagerank_core::encode::journal_encoded(
                &contributions_core::compute::compute(&input).journal,
            );
            let elf = trustgraph_prover::programs::contributions::elf();
            trustgraph_prover::common::execute_values(elf.clone(), &input, &native)?;
            (trustgraph_prover::common::prove_values(elf, &input, cfg.prover.groth16)?, native)
        }
        _ => bail!("{} cannot be proven here", built.program.name()),
    };

    // The submit precondition, restated against the proof we are about to broadcast.
    if proof.public_values != native_pub {
        bail!("proof public values differ from the native journal; refusing to submit");
    }

    Ok(Proved {
        // The backend's handle. `prove_values` blocks to completion, so the request is already
        // resolved by the time we have it — the ambiguous window is the one between the intent
        // record and this line.
        request_id: keccak256(&proof.seal),
        blob: proof.blob(),
        output_root: built.output_root,
    })
}

/// Write everything the submit needs, so a restart between proving and submitting re-attaches
/// rather than paying again.
pub fn save_held(
    entry: &CatalogEntry,
    checkpoint_id: u64,
    built: &Built,
    proved: &Proved,
) -> Result<()> {
    let dir = out_dir(entry, checkpoint_id);
    std::fs::create_dir_all(&dir)?;
    let held = HeldProof {
        output_root: built.output_root,
        ipfs_hash: built.ipfs_hash,
        cid: built.cid.clone(),
        total_value: built.total_value,
        skipped_digest: built.skipped_digest,
        recipient: built.recipient,
        blob: proved.blob.clone(),
    };
    std::fs::write(dir.join("held.json"), serde_json::to_string_pretty(&held)?)?;
    Ok(())
}

/// Whether a finished proof for this checkpoint is on disk and ready to submit.
pub fn has_held_proof(entry: &CatalogEntry, checkpoint_id: u64) -> bool {
    out_dir(entry, checkpoint_id).join("held.json").exists()
}

pub fn load_proof(entry: &CatalogEntry, checkpoint_id: u64) -> Result<HeldProof> {
    let path = out_dir(entry, checkpoint_id).join("held.json");
    let text = std::fs::read_to_string(&path)
        .with_context(|| format!("no held proof at {}", path.display()))?;
    Ok(serde_json::from_str(&text)?)
}

/// What the vault would pay right now. Read BEFORE proving, so a prover never discovers mid-flight
/// that it will not be paid.
pub fn vault_quote(
    rpc: &Rpc,
    vault: Address,
    instance_id: B256,
    view: &SnapshotView,
) -> Result<VaultView> {
    let ret = rpc.eth_call(
        vault,
        quoteCall {
            instanceId: instance_id,
            leafCount: view.live.leaf_count,
            anchorCount: view.live.anchor_count,
        }
        .abi_encode(),
    )?;
    let q = quoteCall::abi_decode_returns(&ret)?;
    Ok(VaultView { eligible: q.eligible, payable_usd: q.payableUsd.to::<u128>(), reason: q.reason })
}

fn params_path(entry: &CatalogEntry) -> Result<String> {
    if let Some(m) = &entry.manifest {
        return Ok(m.params.clone());
    }
    // A factory instance's params came from the chain, so write them out for the tool that needs
    // a file. Nothing is typed in; this is a serialization step, not configuration.
    let params = entry
        .params
        .as_ref()
        .ok_or_else(|| anyhow!("no params for {} and no manifest entry", entry.name))?;
    let dir = PathBuf::from(".trustgraph/operator").join(format!("{:#x}", entry.instance_id));
    std::fs::create_dir_all(&dir)?;
    let path = dir.join("params.json");
    std::fs::write(&path, serde_json::to_string_pretty(params)?)?;
    Ok(path.display().to_string())
}

fn run_tool(bin: &str, args: Vec<&str>) -> Result<()> {
    let out = Command::new(bin)
        .args(&args)
        .output()
        .with_context(|| format!("running {bin} {}", args.join(" ")))?;
    if !out.status.success() {
        bail!("{bin} {} failed:\n{}", args.join(" "), String::from_utf8_lossy(&out.stderr));
    }
    Ok(())
}

fn parse_b256(s: &str) -> Result<B256> {
    let b = hex::decode(s.trim().trim_start_matches("0x"))?;
    anyhow::ensure!(b.len() == 32, "expected 32 bytes, got {}", b.len());
    Ok(B256::from_slice(&b))
}
