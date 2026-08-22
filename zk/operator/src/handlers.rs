//! The supported programs, and the one thing that differs between them: how an input is built.
//!
//! Proving is shared — `trustgraph_prover::common` does it for every program, in-process, through
//! the library seam. Input reconstruction is not: trust-graph and signer read EAS attestations back
//! from `input-exporter`, contributions reads two checkpointed accumulators through the prover's
//! own `fetch`, while weighted recovery supplies exact TGWP bytes to the shared lane-one
//! exporter. Every reconstruction path has its own re-fold/commitment self-check.
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
use operator_core::types::{Program, VaultView};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::process::Command;

use crate::chain::Rpc;
use crate::config::{Config, PinTarget};

sol! {
    struct Quote {
        uint256 feeUsd; uint256 gasUsd; uint256 payableUsd; bool eligible; uint8 reason;
    }
    function quote(bytes32 instanceId, uint256 checkpointId)
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
    /// score without it — see [`publish`].
    pub blob: Vec<u8>,
    /// Populated only by the signer guest; submitted verbatim and bound by `signer_set_root`.
    pub signers: Vec<Address>,
    pub target_threshold: U256,
}

/// A finished proof plus the fields the submit needs.
pub struct Proved {
    pub request_id: B256,
    pub blob: Vec<u8>,
    pub output_root: B256,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Envelope0PreflightReport {
    pub block: u64,
    pub anchor_count: u64,
    pub nodes: usize,
    pub mutations: usize,
    pub cache_hits: usize,
    pub gateway_attempts: usize,
    pub exact_readers: usize,
    pub fetch_latency_ms: u64,
}

/// What a held proof needs to be submitted, reloaded after a restart.
#[derive(Clone, Serialize, Deserialize)]
pub struct HeldProof {
    pub output_root: B256,
    pub ipfs_hash: B256,
    pub cid: String,
    pub total_value: U256,
    pub skipped_digest: B256,
    pub recipient: Address,
    #[serde(default)]
    pub signers: Vec<Address>,
    #[serde(default)]
    pub target_threshold: U256,
    /// The canonical score bytes committed by `ipfs_hash` and `cid`. Older held files predate
    /// this field; they are repaired deterministically from the retained `input.json` on load.
    #[serde(default, with = "hex_bytes")]
    pub score_blob: Vec<u8>,
    /// The Groth16 proof submitted on chain.
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
    checkpoint_id: u64,
    recipient: Address,
) -> Result<Built> {
    // The snapshot's OWN answer, not the registry row's: `setAccumulator` is constitutional and
    // the directory copy may lag it. Reconstructing against the wrong lane produces an input that
    // cannot re-fold, which the exporter refuses — but only after the work.
    let view = crate::chain::read_snapshot(rpc, entry.snapshot)?;
    let accumulator = view.accumulator;
    // Lane 2, when this instance has one. Without it the exporter emits a lane-1-only input whose
    // journal commits the zero anchor pair, and `submitProof` binds the CHECKPOINTED pair — so the
    // digest would not match and the proof would be wasted.
    let mut anchor_args: Vec<String> = if view.anchor_registry == alloy_primitives::Address::ZERO {
        Vec::new()
    } else {
        vec!["--anchor-registry".into(), format!("{:#x}", view.anchor_registry)]
    };
    if !anchor_args.is_empty() {
        for target in cfg.ipfs.resolved_targets() {
            anchor_args.push("--envelope0-gateway".into());
            anchor_args.push(target.gateway);
        }
        anchor_args.push("--envelope0-cache".into());
        anchor_args.push(cfg.ipfs.envelope0_cache_dir.clone());
        anchor_args.push("--envelope0-fetch-concurrency".into());
        anchor_args.push(cfg.ipfs.envelope0_fetch_concurrency.to_string());
    }
    let dir = out_dir(entry, checkpoint_id);
    std::fs::create_dir_all(&dir)?;
    let input_path = dir.join("input.json");
    // A silently-failing build must not leave a STALE input for the next step to prove and submit
    // as if it were this checkpoint's.
    let _ = std::fs::remove_file(&input_path);

    let params_path = params_path(entry)?;

    match entry.program {
        Program::Trustgraphs => {
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
        Program::Signer => {
            let eas = entry.eas.ok_or_else(|| {
                anyhow!("no EAS address for {}; its parent factory must expose EAS()", entry.name)
            })?;
            let selection_path = selection_path(entry)?;
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
                    "--signer",
                    "--selection",
                    &selection_path,
                    "--module",
                    &format!("{:#x}", entry.submit_to),
                    "--from-block",
                    &entry.created_block.to_string(),
                    "--out",
                    &input_path.display().to_string(),
                ],
            )?;
        }
        Program::Contributions => {
            // The mirrored trust accumulator predates the Contributions registration. The public
            // registry scan floor is guaranteed to precede all factory/deploy children; starting
            // at this round's registration block can silently omit earlier trust edges.
            let contributions_from_block = cfg.registry_from_block.to_string();
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
                    "--from-block",
                    &contributions_from_block,
                    "--recipient",
                    &format!("{recipient:#x}"),
                    "--out",
                    &input_path.display().to_string(),
                ],
            )?;
        }
        Program::Weighted => {
            let eas = entry.eas.ok_or_else(|| anyhow!("no EAS address for {}", entry.name))?;
            let manifest = crate::weighted::recover_for_entry(cfg, rpc, entry)
                .with_context(|| format!("recovering exact prior manifest for {}", entry.name))?;
            let manifest_path = dir.join("prior.tgwp");
            std::fs::write(&manifest_path, manifest.bytes)?;
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
                    "--weighted",
                    "--prior-manifest",
                    &manifest_path.display().to_string(),
                    "--snapshot",
                    &format!("{:#x}", entry.snapshot),
                    "--recipient",
                    &format!("{recipient:#x}"),
                    "--from-block",
                    &entry.created_block.to_string(),
                    "--out",
                    &input_path.display().to_string(),
                ],
            )?;
        }
        Program::Composition => {
            let prepared =
                crate::composition::prepare(cfg, rpc, entry, Some(checkpoint_id), recipient)
                    .with_context(|| {
                        format!("recovering exact composition capture for {}", entry.name)
                    })?;
            std::fs::write(&input_path, serde_json::to_vec_pretty(&prepared.input)?)?;
        }
        Program::NostrWorkspace => {
            let manifest = entry.manifest.as_ref().ok_or_else(|| {
                anyhow!("nostr-workspace {} has no archive manifest configuration", entry.name)
            })?;
            let checkpoint = checkpoint_id.to_string();
            let snapshot = format!("{:#x}", entry.snapshot);
            let recipient = format!("{recipient:#x}");
            let from_block = entry.created_block.to_string();
            let output = input_path.display().to_string();
            let mut args = vec![
                "run",
                "-q",
                "--release",
                "--features",
                "witness-nostr",
                "--manifest-path",
                "zk/prover/Cargo.toml",
                "--",
                "nostr-witness",
                "assemble",
                "--rpc",
                &cfg.rpc,
                "--snapshot",
                &snapshot,
                "--checkpoint",
                &checkpoint,
                "--params",
                &params_path,
                "--from-block",
                &from_block,
                "--recipient",
                &recipient,
                "--out",
                &output,
            ];
            for path in &manifest.witness_manifests {
                args.push("--manifest");
                args.push(path);
            }
            run_tool("cargo", args)?;
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

/// Verify the complete current strict lane before paying to freeze it. Legacy/no-lane instances
/// return `None`; a strict lane without one exact configured reader is an availability error.
pub fn preflight_live_envelope0(
    cfg: &Config,
    rpc: &Rpc,
    entry: &CatalogEntry,
) -> Result<Option<Envelope0PreflightReport>> {
    let view = crate::chain::read_snapshot(rpc, entry.snapshot)?;
    if !uses_strict_envelope0(rpc, entry)? {
        return Ok(None);
    }
    let params_path = params_path(entry)?;

    let mut args = vec![
        "run".to_string(),
        "-q".to_string(),
        "-p".to_string(),
        "input-exporter".to_string(),
        "--bin".to_string(),
        "envelope0-preflight".to_string(),
        "--".to_string(),
        "--rpc".to_string(),
        cfg.rpc.clone(),
        "--registry".to_string(),
        format!("{:#x}", view.anchor_registry),
        "--params".to_string(),
        params_path,
        "--from-block".to_string(),
        entry.created_block.to_string(),
        "--envelope0-cache".to_string(),
        cfg.ipfs.envelope0_cache_dir.clone(),
        "--envelope0-fetch-concurrency".to_string(),
        cfg.ipfs.envelope0_fetch_concurrency.to_string(),
    ];
    for target in cfg.ipfs.resolved_targets() {
        args.push("--envelope0-gateway".to_string());
        args.push(target.gateway);
    }
    let output = run_tool_output("cargo", &args, "strict Envelope0 live preflight")?;
    serde_json::from_str(output.trim())
        .context("strict Envelope0 preflight returned invalid metrics")
        .map(Some)
}

pub fn uses_strict_envelope0(rpc: &Rpc, entry: &CatalogEntry) -> Result<bool> {
    if entry.program != Program::Trustgraphs {
        return Ok(false);
    }
    let view = crate::chain::read_snapshot(rpc, entry.snapshot)?;
    if view.anchor_registry == Address::ZERO {
        return Ok(false);
    }
    let path = params_path(entry)?;
    let params: pagerank_core::Params = serde_json::from_str(&std::fs::read_to_string(path)?)
        .context("parsing trust-graph params for strict lane detection")?;
    Ok(params.envelope0_domain_separators.len() == 2 && params.lane2_max_head_age == 0)
}

/// Compute the journal natively, before asking anyone to prove it.
fn native_journal(program: Program, input_path: &PathBuf, recipient: Address) -> Result<Built> {
    let text = std::fs::read_to_string(input_path)?;
    if program == Program::Signer {
        let input: pagerank_core::SignerInput = serde_json::from_str(&text)?;
        let vk = trustgraph_prover::common::vkey(trustgraph_prover::programs::signer::elf())?;
        return Ok(native_signer_journal(input_path, &input, parse_b256(&vk)?));
    }
    if program == Program::Weighted {
        let input: weighted_prior_core::GuestInput = serde_json::from_str(&text)?;
        let result = weighted_prior_core::compute::compute(&input)?;
        if result.journal.recipient != recipient {
            bail!(
                "input names recipient {:#x}, config says {recipient:#x}",
                result.journal.recipient
            );
        }
        let vk = trustgraph_prover::common::vkey(trustgraph_prover::programs::weighted::elf())?;
        let encoded = weighted_prior_core::encode::journal_encoded(&result.journal);
        return Ok(Built {
            program,
            input_path: input_path.clone(),
            public_values_hash: keccak256(&encoded),
            vk_hash: parse_b256(&vk)?,
            output_root: result.journal.output_root,
            ipfs_hash: result.journal.ipfs_hash,
            cid: result.cid,
            total_value: result.journal.total_value,
            skipped_digest: result.journal.skipped_digest,
            recipient: result.journal.recipient,
            blob: result.blob,
            signers: Vec::new(),
            target_threshold: U256::ZERO,
        });
    }
    if program == Program::Composition {
        let input: composition_core::GuestInput = serde_json::from_str(&text)?;
        let result = composition_core::compute::compute(&input)?;
        if result.journal.recipient != recipient {
            bail!(
                "input names recipient {:#x}, config says {recipient:#x}",
                result.journal.recipient
            );
        }
        let vk = trustgraph_prover::common::vkey(trustgraph_prover::programs::composition::elf())?;
        let encoded = composition_core::codec::journal_encoded(&result.journal);
        return Ok(Built {
            program,
            input_path: input_path.clone(),
            public_values_hash: keccak256(&encoded),
            vk_hash: parse_b256(&vk)?,
            output_root: result.journal.output_root,
            ipfs_hash: result.journal.ipfs_hash,
            cid: result.cid,
            total_value: result.journal.total_value,
            skipped_digest: result.journal.skipped_digest,
            recipient: result.journal.recipient,
            blob: result.blob,
            signers: Vec::new(),
            target_threshold: U256::ZERO,
        });
    }
    if program == Program::NostrWorkspace {
        let input: nostr_workspace_core::compute::GuestInput = serde_json::from_str(&text)?;
        let result = nostr_workspace_core::compute::compute(&input)
            .map_err(|error| anyhow!("nostr-workspace native compute: {error:?}"))?;
        if result.journal.recipient != recipient {
            bail!(
                "input names recipient {:#x}, config says {recipient:#x}",
                result.journal.recipient
            );
        }
        let vk =
            trustgraph_prover::common::vkey(trustgraph_prover::programs::nostr_workspace::elf())?;
        let encoded = pagerank_core::encode::journal_encoded(&result.journal);
        return Ok(Built {
            program,
            input_path: input_path.clone(),
            public_values_hash: keccak256(&encoded),
            vk_hash: parse_b256(&vk)?,
            output_root: result.journal.output_root,
            ipfs_hash: result.journal.ipfs_hash,
            cid: result.cid,
            total_value: result.journal.total_value,
            skipped_digest: result.journal.skipped_digest,
            recipient: result.journal.recipient,
            blob: result.blob,
            signers: Vec::new(),
            target_threshold: U256::ZERO,
        });
    }
    let (j, cid, vk, blob) = match program {
        Program::Trustgraphs => {
            let input: trustgraph_core::GuestInput = serde_json::from_str(&text)?;
            let r = trustgraph_core::compute::compute(&input);
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
        signers: Vec::new(),
        target_threshold: U256::ZERO,
    })
}

/// Pure signer receipt construction, split from vkey derivation so unit tests do not regenerate
/// an SP1 proving key merely to assert the calldata fields.
fn native_signer_journal(
    input_path: &PathBuf,
    input: &pagerank_core::SignerInput,
    vk_hash: B256,
) -> Built {
    let result = pagerank_core::signer::compute_signers(input);
    let encoded = pagerank_core::encode::signer_journal_encoded(&result.journal);
    Built {
        program: Program::Signer,
        input_path: input_path.clone(),
        public_values_hash: keccak256(&encoded),
        vk_hash,
        output_root: result.journal.signer_set_root,
        ipfs_hash: B256::ZERO,
        cid: String::new(),
        total_value: U256::ZERO,
        skipped_digest: B256::ZERO,
        recipient: Address::ZERO,
        blob: Vec::new(),
        signers: result.signers,
        target_threshold: result.target_threshold,
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PublicationFailure {
    pub target: String,
    pub error: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PublicationReport {
    pub cid: String,
    pub successes: Vec<String>,
    pub failures: Vec<PublicationFailure>,
    pub required: usize,
}

impl PublicationReport {
    pub fn satisfied(&self) -> bool {
        self.successes.len() >= self.required
    }

    pub fn failure_strings(&self) -> Vec<String> {
        self.failures
            .iter()
            .map(|failure| format!("{}: {}", failure.target, failure.error))
            .collect()
    }
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
/// `tests/e2e/run.sh` and `taskfile/instances.sh`); the daemon replaced the loop and not that step.
///
/// Every configured target is attempted so one outage does not hide the health of the others.
/// The caller persists the report and refuses submission unless `satisfied()` is true.
pub fn publish(cfg: &Config, cid: &str, blob: &[u8]) -> PublicationReport {
    let targets = cfg.ipfs.resolved_targets();
    let required = cfg.ipfs.required_successes();
    let mut report = PublicationReport {
        cid: cid.to_string(),
        successes: Vec::new(),
        failures: Vec::new(),
        required,
    };
    for target in targets {
        match pin_target(&target, cid, blob) {
            Ok(()) => report.successes.push(target.name),
            Err(error) => report
                .failures
                .push(PublicationFailure { target: target.name, error: error.to_string() }),
        }
    }
    report
}

fn pin_target(target: &PinTarget, cid: &str, blob: &[u8]) -> Result<()> {
    let url = format!(
        "{}/api/v0/add?cid-version=1&raw-leaves=true&pin=true",
        target.api.trim_end_matches('/')
    );

    // Multipart by hand rather than pulling in a client: one field, known bytes.
    let boundary = "----trustgraph-operator-blob";
    let mut body = Vec::new();
    body.extend_from_slice(
        format!(
            "--{boundary}\r\n\
             Content-Disposition: form-data; name=\"file\"; filename=\"blob.json\"\r\n\
             Content-Type: application/json\r\n\r\n"
        )
        .as_bytes(),
    );
    body.extend_from_slice(blob);
    body.extend_from_slice(format!("\r\n--{boundary}--\r\n").as_bytes());

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
        got == cid,
        "ipfs returned CID {got}, the guest committed {cid} — refusing to call target {:?} published",
        target.name
    );

    // "The API accepted it" and "a reader can fetch these exact bytes" are different claims.
    readable(&target.gateway, &got, blob)
}

/// Fetch the CID back through a reader's gateway, so a pin means what it says.
///
/// The failure this exists for: `add` returns the right CID and the daemon reports `pinned`, but
/// the gateway the indexer reads answers 504 for the same CID — because the two are not the same
/// node. The root then lands pointing at bytes nobody can get, and the first symptom is an indexer
/// stuck retrying one event forever while every network page renders empty. Reading it back turns
/// that into a failed pin at the moment it happens, next to the thing that caused it.
fn readable(gateway: &str, cid: &str, expected: &[u8]) -> Result<()> {
    // Concatenated and localhost-rewritten exactly as `packages/indexer/src/merkle.ts` does it, from the
    // same string (`IPFS_GATEWAY`, which ends in `/ipfs/`). If this built the URL its own way the
    // check could pass against a URL no reader ever requests.
    let url = format!("{gateway}{cid}").replace("localhost", "127.0.0.1");
    let resp = reqwest::blocking::Client::new()
        .get(url)
        .timeout(std::time::Duration::from_secs(30))
        .send()
        .with_context(|| format!("reading {cid} back from {gateway}"))?;
    anyhow::ensure!(
        resp.status().is_success(),
        "the API accepted the blob but the gateway {gateway} answers {} for {cid}. The `add` and \
         the read are hitting DIFFERENT nodes: whatever stored the bytes is not what readers ask. \
         Check that `[ipfs] api` and `[ipfs] gateway` are the same kubo (compare \
         `/api/v0/id` against the gateway's host).",
        resp.status()
    );
    let got = resp.bytes()?;
    anyhow::ensure!(
        got.as_ref() == expected,
        "gateway {gateway} served {} bytes for {cid}, but the canonical blob is {} bytes and the bytes differ",
        got.len(),
        expected.len()
    );
    Ok(())
}

/// Prove, with the guest-vs-native byte assert as the precondition.
pub fn prove(cfg: &Config, built: &Built) -> Result<Proved> {
    let text = std::fs::read_to_string(&built.input_path)?;
    let (proof, native_pub) = match built.program {
        Program::Trustgraphs => {
            let input: trustgraph_core::GuestInput = serde_json::from_str(&text)?;
            let native = pagerank_core::encode::journal_encoded(
                &trustgraph_core::compute::compute(&input).journal,
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
        Program::Weighted => {
            let input: weighted_prior_core::GuestInput = serde_json::from_str(&text)?;
            let native = weighted_prior_core::encode::journal_encoded(
                &weighted_prior_core::compute::compute(&input)?.journal,
            );
            let elf = trustgraph_prover::programs::weighted::elf();
            trustgraph_prover::common::execute_values(elf.clone(), &input, &native)?;
            (trustgraph_prover::common::prove_values(elf, &input, cfg.prover.groth16)?, native)
        }
        Program::Composition => {
            let input: composition_core::GuestInput = serde_json::from_str(&text)?;
            let native = composition_core::codec::journal_encoded(
                &composition_core::compute::compute(&input)?.journal,
            );
            let elf = trustgraph_prover::programs::composition::elf();
            trustgraph_prover::common::execute_values(elf.clone(), &input, &native)?;
            (trustgraph_prover::common::prove_values(elf, &input, cfg.prover.groth16)?, native)
        }
        Program::NostrWorkspace => {
            let input: nostr_workspace_core::compute::GuestInput = serde_json::from_str(&text)?;
            let result = nostr_workspace_core::compute::compute(&input)
                .map_err(|error| anyhow!("nostr-workspace native compute: {error:?}"))?;
            let native = pagerank_core::encode::journal_encoded(&result.journal);
            let elf = trustgraph_prover::programs::nostr_workspace::elf();
            trustgraph_prover::common::execute_values(elf.clone(), &input, &native)?;
            (trustgraph_prover::common::prove_values(elf, &input, cfg.prover.groth16)?, native)
        }
        Program::Signer => {
            let input: pagerank_core::SignerInput = serde_json::from_str(&text)?;
            let native = pagerank_core::encode::signer_journal_encoded(
                &pagerank_core::signer::compute_signers(&input).journal,
            );
            let elf = trustgraph_prover::programs::signer::elf();
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
        signers: built.signers.clone(),
        target_threshold: built.target_threshold,
        score_blob: built.blob.clone(),
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

/// Load and self-check the canonical bytes needed for publication.
///
/// `held.json` and `input.json` are both crash-recovery artifacts, not authorities. Recomputing
/// the native journal ties the bytes back to the checkpoint input and catches a stale, truncated,
/// or hand-edited held file before it can be called published. Legacy held files without
/// `score_blob` are transparently reconstructed from the retained input.
pub fn load_publication_blob(
    entry: &CatalogEntry,
    checkpoint_id: u64,
) -> Result<(HeldProof, Vec<u8>)> {
    anyhow::ensure!(
        entry.program != Program::Signer,
        "signer receipts carry their complete owner set and have no IPFS publication"
    );
    let held = load_proof(entry, checkpoint_id)?;
    let rebuilt = native_journal(
        entry.program,
        &out_dir(entry, checkpoint_id).join("input.json"),
        held.recipient,
    )
    .with_context(|| format!("rebuilding canonical blob for checkpoint {checkpoint_id}"))?;

    anyhow::ensure!(
        rebuilt.output_root == held.output_root
            && rebuilt.ipfs_hash == held.ipfs_hash
            && rebuilt.cid == held.cid
            && rebuilt.total_value == held.total_value
            && rebuilt.skipped_digest == held.skipped_digest
            && rebuilt.recipient == held.recipient,
        "held proof metadata does not match the checkpoint input; refusing publication"
    );
    if !held.score_blob.is_empty() {
        anyhow::ensure!(
            held.score_blob == rebuilt.blob,
            "held score blob differs from the canonical checkpoint computation"
        );
    }
    Ok((held, rebuilt.blob))
}

/// What the vault would pay right now. Read BEFORE proving, so a prover never discovers mid-flight
/// that it will not be paid.
pub fn vault_quote(
    rpc: &Rpc,
    vault: Address,
    instance_id: B256,
    checkpoint_id: u64,
) -> Result<VaultView> {
    let ret = rpc.eth_call(
        vault,
        quoteCall { instanceId: instance_id, checkpointId: U256::from(checkpoint_id) }.abi_encode(),
    )?;
    let q = quoteCall::abi_decode_returns(&ret)?;
    Ok(VaultView {
        eligible: q.eligible,
        fee_usd: q.feeUsd.to::<u128>(),
        gas_usd: q.gasUsd.to::<u128>(),
        payable_usd: q.payableUsd.to::<u128>(),
        reason: q.reason,
    })
}

fn params_path(entry: &CatalogEntry) -> Result<String> {
    if let Some(m) = &entry.manifest {
        return Ok(m.params.clone());
    }
    // A factory instance's params came from the chain, so write them out for the tool that needs
    // a file. Nothing is typed in; this is a serialization step, not configuration.
    let dir = PathBuf::from(".trustgraph/operator").join(format!("{:#x}", entry.instance_id));
    std::fs::create_dir_all(&dir)?;
    let path = dir.join("params.json");
    let encoded =
        if entry.program == Program::Contributions {
            serde_json::to_string_pretty(entry.contributions_params.as_ref().ok_or_else(|| {
                anyhow!("no contributions params for {} and no manifest entry", entry.name)
            })?)?
        } else if entry.program == Program::Weighted {
            serde_json::to_string_pretty(entry.weighted_params.as_ref().ok_or_else(|| {
                anyhow!("no weighted params for {} and no manifest entry", entry.name)
            })?)?
        } else if entry.program == Program::Composition {
            serde_json::to_string_pretty(
                entry
                    .composition_params
                    .as_ref()
                    .ok_or_else(|| anyhow!("no composition params for {}", entry.name))?,
            )?
        } else if entry.program == Program::NostrWorkspace {
            // Scoped archive paths stay in the operator manifest. The params preimage is likewise a
            // local pointer, but `nostr-witness assemble` hashes it and requires equality with the
            // checkpoint-pinned on-chain commitment before this file can reach native compute.
            serde_json::to_string_pretty(&serde_json::from_str::<
                nostr_workspace_core::params::Params,
            >(&std::fs::read_to_string(
                entry
                    .manifest
                    .as_ref()
                    .ok_or_else(|| anyhow!("no nostr-workspace manifest for {}", entry.name))?
                    .params
                    .as_str(),
            )?)?)?
        } else {
            serde_json::to_string_pretty(
                entry
                    .params
                    .as_ref()
                    .ok_or_else(|| anyhow!("no params for {} and no manifest entry", entry.name))?,
            )?
        };
    std::fs::write(&path, encoded)?;
    Ok(path.display().to_string())
}

fn selection_path(entry: &CatalogEntry) -> Result<String> {
    if let Some(selection) = &entry.selection {
        let dir = PathBuf::from(".trustgraph/operator").join(format!("{:#x}", entry.instance_id));
        std::fs::create_dir_all(&dir)?;
        let path = dir.join("selection.json");
        std::fs::write(&path, serde_json::to_string_pretty(selection)?)?;
        return Ok(path.display().to_string());
    }
    entry.manifest.as_ref().and_then(|manifest| manifest.selection.clone()).ok_or_else(|| {
        anyhow!("signer entry {} has no selection tuple or manifest path", entry.name)
    })
}

fn run_tool(bin: &str, args: Vec<&str>) -> Result<()> {
    let out = Command::new(bin)
        .args(&args)
        // The spawned prover must use the same guest ELFs this binary's vkey checks were made
        // against. Without this a bare daemon run (no wrapping task exporting it) lets build.rs
        // rebuild the guests mid-tick, and the proof comes back under a vkey no verifier pinned.
        .env("SP1_SKIP_PROGRAM_BUILD", "true")
        .output()
        .with_context(|| format!("running {bin} {}", args.join(" ")))?;
    if !out.status.success() {
        bail!("{bin} {} failed:\n{}", args.join(" "), String::from_utf8_lossy(&out.stderr));
    }
    Ok(())
}

fn run_tool_output(bin: &str, args: &[String], label: &str) -> Result<String> {
    let out = Command::new(bin)
        .args(args)
        .env("SP1_SKIP_PROGRAM_BUILD", "true")
        .output()
        .with_context(|| format!("starting {label}"))?;
    if !out.status.success() {
        // Endpoint URLs can contain credentials. The hold is intentionally specific while its
        // message remains safe for logs, status APIs, and alert webhooks.
        bail!("{label} failed; no exact current bundle set was recovered");
    }
    String::from_utf8(out.stdout).with_context(|| format!("{label} output was not UTF-8"))
}

fn parse_b256(s: &str) -> Result<B256> {
    let b = hex::decode(s.trim().trim_start_matches("0x"))?;
    anyhow::ensure!(b.len() == 32, "expected 32 bytes, got {}", b.len());
    Ok(B256::from_slice(&b))
}

#[cfg(test)]
mod readback_tests {
    use super::{native_journal, native_signer_journal, publish, readable};
    use crate::config::Config;
    use alloy_primitives::{Address, B256, U256};
    use alloy_sol_types::SolValue;
    use operator_core::types::Program;
    use pagerank_core::{Params, RawEdge, SelectionParams, SignerInput};
    use std::io::{Read, Write};
    use std::net::TcpListener;

    #[test]
    #[ignore = "release gate: executes the real SP1 guest; run with --release --ignored"]
    fn weighted_operator_native_journal_byte_matches_the_isolated_guest() {
        // The one-iteration Hamilton tie fixture exercises the complete journal encoding while
        // keeping this real SP1 execution practical in the ordinary operator test suite.
        let input = trustgraph_prover::programs::weighted::parity_inputs().pop().unwrap().1;
        let recipient = input.binding.recipient;
        let file = tempfile::NamedTempFile::new().unwrap();
        std::fs::write(file.path(), serde_json::to_vec(&input).unwrap()).unwrap();
        let path = file.path().to_path_buf();

        let built = native_journal(Program::Weighted, &path, recipient).unwrap();
        let expected = weighted_prior_core::compute::compute(&input).unwrap();
        let native = weighted_prior_core::encode::journal_encoded(&expected.journal);
        let execution = trustgraph_prover::common::execute_values(
            trustgraph_prover::programs::weighted::elf(),
            &input,
            &native,
        )
        .unwrap();

        assert_eq!(execution.public_values, native);
        assert_eq!(built.public_values_hash, alloy_primitives::keccak256(&native));
        assert_eq!(built.output_root, expected.journal.output_root);
    }

    #[test]
    #[ignore = "release gate: derives the real SP1 composition proving key"]
    fn composition_operator_native_journal_reproduces_the_cross_language_golden() {
        let input = composition_core::fixture::sample_input();
        let recipient = input.binding.recipient;
        let file = tempfile::NamedTempFile::new().unwrap();
        std::fs::write(file.path(), serde_json::to_vec(&input).unwrap()).unwrap();
        let built =
            native_journal(Program::Composition, &file.path().to_path_buf(), recipient).unwrap();
        let expected = composition_core::compute::compute(&input).unwrap();
        assert_eq!(built.output_root, expected.journal.output_root);
        assert_eq!(built.ipfs_hash, expected.journal.ipfs_hash);
        assert_eq!(built.cid, expected.cid);
        assert_eq!(built.blob, expected.blob);
        assert_eq!(
            built.public_values_hash,
            alloy_primitives::keccak256(composition_core::codec::journal_encoded(
                &expected.journal
            ))
        );
    }

    #[test]
    #[ignore = "release gate: executes the real SP1 composition guest; run with --release --ignored"]
    fn composition_operator_native_journal_byte_matches_the_isolated_guest() {
        let input = composition_core::fixture::remainder_tie_input();
        let recipient = input.binding.recipient;
        let file = tempfile::NamedTempFile::new().unwrap();
        std::fs::write(file.path(), serde_json::to_vec(&input).unwrap()).unwrap();
        let built =
            native_journal(Program::Composition, &file.path().to_path_buf(), recipient).unwrap();
        let expected = composition_core::compute::compute(&input).unwrap();
        let native = composition_core::codec::journal_encoded(&expected.journal);
        let execution = trustgraph_prover::common::execute_values(
            trustgraph_prover::programs::composition::elf(),
            &input,
            &native,
        )
        .unwrap();
        assert_eq!(execution.public_values, native);
        assert_eq!(built.public_values_hash, alloy_primitives::keccak256(&native));
    }

    #[test]
    fn signer_native_journal_carries_the_complete_submit_receipt() {
        let scale = U256::from(10u64).pow(U256::from(18u64));
        let seed = Address::from([0x22; 20]);
        let input = SignerInput {
            edges: vec![RawEdge {
                kind: 0,
                attester: seed,
                recipient: seed,
                uid: B256::from([0x11; 32]),
                block_timestamp: 1,
                data: (String::new(), scale).abi_encode(),
            }],
            params: Params {
                damping_fp: scale * U256::from(85) / U256::from(100),
                tolerance_fp: scale / U256::from(1_000_000),
                max_iterations: 100,
                min_weight_fp: U256::ZERO,
                max_weight_fp: scale * U256::from(100),
                trust_multiplier_fp: scale * U256::from(2),
                trust_share_fp: scale,
                trust_decay_fp: scale,
                trusted_seeds: vec![seed],
                total_pool: scale,
                precision_scale: scale,
                schema_uid: B256::ZERO,
                weight_field_index: 1,
                envelope0_domain_separators: Vec::new(),
                lane2_max_head_age: 0,
                accumulator: Address::from([0x33; 20]),
                chain_id: 31_337,
            },
            selection: SelectionParams { top_n: 5, min_threshold: 1, target_threshold_bps: 5_000 },
            instance_domain: B256::from([0x44; 32]),
        };
        let path = std::path::PathBuf::from("signer.json");
        let vkey = B256::from([0x55; 32]);
        let built = native_signer_journal(&path, &input, vkey);
        assert_eq!(built.program, Program::Signer);
        assert_eq!(built.vk_hash, vkey);
        assert_eq!(built.signers, vec![seed]);
        assert_eq!(built.target_threshold, U256::from(1));
        assert_eq!(built.output_root, pagerank_core::signer::signer_set_root(&[seed]));
        assert_eq!(built.recipient, Address::ZERO);
        assert!(built.cid.is_empty());
        assert!(built.blob.is_empty(), "signer receipts need no score publication blob");
    }

    /// A one-shot HTTP server that answers the first request with `status`, then stops.
    fn serve_once(status: &'static str, body: &'static str) -> String {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        std::thread::spawn(move || {
            if let Ok((mut stream, _)) = listener.accept() {
                let mut buf = [0u8; 1024];
                let _ = stream.read(&mut buf);
                let _ = stream.write_all(
                    format!(
                        "HTTP/1.1 {status}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                        body.len()
                    )
                    .as_bytes(),
                );
            }
        });
        format!("http://127.0.0.1:{port}/ipfs/")
    }

    #[test]
    fn a_gateway_that_serves_the_blob_is_readable() {
        let body = b"{\"0xabc\":\"1\"}";
        let gw = serve_once("200 OK", std::str::from_utf8(body).unwrap());
        readable(&gw, "bafkreitest", body).expect("the exact bytes are readable");
    }

    /// The failure this check exists for. `add` succeeded and returned the right CID, so the
    /// daemon believed it had published; the gateway readers actually use answered 504 because it
    /// is a different node. Without this the root lands anyway and the first symptom is an indexer
    /// wedged retrying one event while every network page renders empty.
    #[test]
    fn a_gateway_that_times_out_is_not_published() {
        let gw = serve_once("504 Gateway Timeout", "");
        let err = readable(&gw, "bafkreitest", b"expected").unwrap_err().to_string();
        assert!(err.contains("504"), "{err}");
        assert!(err.contains("DIFFERENT nodes"), "the message must name the cause: {err}");
    }

    /// A 404 is the same class of problem and must not be treated as success either.
    #[test]
    fn a_gateway_missing_the_block_is_not_published() {
        let gw = serve_once("404 Not Found", "");
        assert!(readable(&gw, "bafkreitest", b"expected").is_err());
    }

    #[test]
    fn a_gateway_serving_different_bytes_is_not_published() {
        let gw = serve_once("200 OK", "wrong");
        let err = readable(&gw, "bafkreitest", b"right").unwrap_err().to_string();
        assert!(err.contains("bytes differ"), "{err}");
    }

    /// The URL is built by plain concatenation, exactly as `packages/indexer/src/merkle.ts` does it, so the
    /// check cannot pass against a URL no reader ever requests.
    #[test]
    fn the_url_is_the_gateway_string_plus_the_cid() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            if let Ok((mut stream, _)) = listener.accept() {
                let mut buf = [0u8; 1024];
                let n = stream.read(&mut buf).unwrap_or(0);
                let _ = tx.send(String::from_utf8_lossy(&buf[..n]).to_string());
                let _ = stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n");
            }
        });
        // `localhost` is rewritten to 127.0.0.1 the way the indexer does, to dodge kubo's
        // subdomain-gateway redirect.
        let _ = readable(&format!("http://localhost:{port}/ipfs/"), "bafkreicid", b"");
        let request = rx.recv_timeout(std::time::Duration::from_secs(10)).unwrap();
        assert!(request.starts_with("GET /ipfs/bafkreicid "), "{request}");
    }

    /// A minimal kubo-compatible target: one `add` response followed by gateway readback.
    fn serve_target(cid: &'static str, blob: &'static [u8], add_ok: bool) -> String {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        std::thread::spawn(move || {
            let requests = if add_ok { 2 } else { 1 };
            for _ in 0..requests {
                let (mut stream, _) = listener.accept().unwrap();
                let mut buf = [0u8; 8192];
                let n = stream.read(&mut buf).unwrap_or(0);
                let request = String::from_utf8_lossy(&buf[..n]);
                if request.starts_with("POST ") {
                    if add_ok {
                        let body = format!("{{\"Hash\":\"{cid}\"}}");
                        let _ = stream.write_all(
                            format!(
                                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                                body.len()
                            )
                            .as_bytes(),
                        );
                    } else {
                        let _ = stream.write_all(
                            b"HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                        );
                    }
                } else {
                    let _ = stream.write_all(
                        format!(
                            "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                            blob.len()
                        )
                        .as_bytes(),
                    );
                    let _ = stream.write_all(blob);
                }
            }
        });
        format!("http://127.0.0.1:{port}")
    }

    fn publication_config(primary: &str, backup: &str, minimum: usize) -> Config {
        toml::from_str(&format!(
            r#"
rpc = "http://127.0.0.1:8545"
registry = "0x8D08973774F1Da59728e5a0f66453113A3E35A0F"
[ipfs]
min_success = {minimum}
[[ipfs.targets]]
name = "primary"
api = "{primary}"
gateway = "{primary}/ipfs/"
[[ipfs.targets]]
name = "backup"
api = "{backup}"
gateway = "{backup}/ipfs/"
"#
        ))
        .unwrap()
    }

    #[test]
    fn publication_succeeds_when_the_configured_minimum_is_met() {
        const CID: &str = "bafkreipolicy";
        const BLOB: &[u8] = b"canonical score bytes";
        let primary = serve_target(CID, BLOB, true);
        let backup = serve_target(CID, BLOB, false);
        let report = publish(&publication_config(&primary, &backup, 1), CID, BLOB);
        assert!(report.satisfied());
        assert_eq!(report.successes, vec!["primary"]);
        assert_eq!(report.failures.len(), 1);
    }

    #[test]
    fn publication_blocks_when_the_minimum_is_not_met() {
        const CID: &str = "bafkreipolicytwo";
        const BLOB: &[u8] = b"canonical score bytes";
        let primary = serve_target(CID, BLOB, true);
        let backup = serve_target(CID, BLOB, false);
        let report = publish(&publication_config(&primary, &backup, 2), CID, BLOB);
        assert!(!report.satisfied());
        assert_eq!(report.successes.len(), 1);
        assert_eq!(report.required, 2);
    }
}
