//! Exact trust-compose checkpoint recovery and authenticated work pricing.
//!
//! A composition accumulator's `leafCount` is deliberately only 2–8: it counts sources, not the
//! hidden work inside their blobs. This module refuses to use that proxy. It recovers the exact
//! TGCM bytes, derives every raw CID from the committed SHA-256, requires the configured durable
//! gateway quorum to serve those exact bytes, runs the production consensus core, and only then
//! returns a measured work band to the scheduler.

use std::collections::BTreeSet;
use std::time::Duration;

use alloy_primitives::{keccak256, Address, B256};
use anyhow::{anyhow, bail, Context, Result};
use composition_core::{codec, Binding, GuestInput, SourcePreimage};
use operator_core::catalog::CatalogEntry;
use operator_core::types::Program;

use crate::chain::{read_checkpoint, read_composition_manifest, Rpc};
use crate::config::Config;

/// SP1 6.3.1 measurements pinned by issue #63. A shape enters the highest band selected by any
/// authenticated dimension, so a tiny source count cannot hide a large blob or account union.
pub const BAND_1_CYCLES: u64 = 2_616_399;
pub const BAND_2_CYCLES: u64 = 24_312_132;
pub const BAND_3_CYCLES: u64 = 105_652_691;
pub const BAND_4_CYCLES: u64 = 222_311_301;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct WorkShape {
    pub source_count: u8,
    pub aggregate_entries: u32,
    pub union_accounts: u32,
    pub aggregate_blob_bytes: u32,
    pub band: u8,
    pub measured_cycles: u64,
}

pub struct Prepared {
    pub input: GuestInput,
    pub work: WorkShape,
}

pub fn classify_work(
    source_count: usize,
    aggregate_entries: usize,
    union_accounts: usize,
    aggregate_blob_bytes: usize,
) -> Result<WorkShape> {
    let band = if source_count <= 2
        && aggregate_entries <= 128
        && union_accounts <= 128
        && aggregate_blob_bytes <= 16 * 1024
    {
        1
    } else if source_count <= 4
        && aggregate_entries <= 1_024
        && union_accounts <= 1_024
        && aggregate_blob_bytes <= 128 * 1024
    {
        2
    } else if aggregate_entries <= 4_096
        && union_accounts <= 4_096
        && aggregate_blob_bytes <= 512 * 1024
    {
        3
    } else {
        4
    };
    let measured_cycles = match band {
        1 => BAND_1_CYCLES,
        2 => BAND_2_CYCLES,
        3 => BAND_3_CYCLES,
        _ => BAND_4_CYCLES,
    };
    Ok(WorkShape {
        source_count: u8::try_from(source_count).context("source count exceeds uint8")?,
        aggregate_entries: u32::try_from(aggregate_entries)
            .context("aggregate entries exceed uint32")?,
        union_accounts: u32::try_from(union_accounts).context("union accounts exceed uint32")?,
        aggregate_blob_bytes: u32::try_from(aggregate_blob_bytes)
            .context("aggregate source bytes exceed uint32")?,
        band,
        measured_cycles,
    })
}

pub fn work_shape(input: &GuestInput) -> Result<WorkShape> {
    let mut entries = 0usize;
    let mut accounts = BTreeSet::new();
    let mut bytes = 0usize;
    for source in &input.source_preimages {
        bytes = bytes.checked_add(source.blob.len()).context("source byte sum overflow")?;
        let decoded = composition_core::blob::decode_canonical_score_blob(&source.blob)
            .map_err(|error| anyhow!("source blob is not canonical: {error}"))?;
        entries = entries.checked_add(decoded.len()).context("source entry sum overflow")?;
        accounts.extend(decoded.into_iter().map(|(account, _)| account));
    }
    classify_work(input.source_preimages.len(), entries, accounts.len(), bytes)
}

/// Recover and consensus-validate one current or historical capture. `checkpoint_id = None` is a
/// trigger preflight; historical work additionally proves TGCM SHA/count equality against the
/// durable accumulator checkpoint.
pub fn prepare(
    cfg: &Config,
    rpc: &Rpc,
    entry: &CatalogEntry,
    checkpoint_id: Option<u64>,
    recipient: Address,
) -> Result<Prepared> {
    anyhow::ensure!(entry.program == Program::Composition, "not a composition catalog entry");
    let params = entry
        .composition_params
        .ok_or_else(|| anyhow!("{} has no authenticated composition params", entry.name))?;
    params.validate().map_err(|error| anyhow!("invalid composition params: {error}"))?;
    anyhow::ensure!(
        params.accumulator == entry.accumulator,
        "composition params accumulator {:#x} != catalog {:#x}",
        params.accumulator,
        entry.accumulator
    );

    let manifest = read_composition_manifest(rpc, entry.accumulator, checkpoint_id)?;
    let binding = Binding {
        recipient,
        instance_domain: crate::chain::expected_instance_domain(
            entry.snapshot,
            rpc.eth_chain_id()?,
        ),
    };
    let digest = codec::manifest_digest(&manifest);
    let parsed = codec::parse_capture_manifest(&manifest, params.chain_id)
        .map_err(|error| anyhow!("invalid checkpoint TGCM: {error}"))?;
    assert_checkpoint(rpc, entry, checkpoint_id, digest, parsed.sources.len())?;
    let source_preimages = parsed
        .sources
        .iter()
        .map(|source| fetch_source(cfg, source.source_id, source.blob_sha256, source.cid_digest))
        .collect::<Result<Vec<_>>>()?;
    let input = GuestInput {
        params,
        manifest,
        source_preimages,
        capture_commitment: digest,
        capture_count: parsed.sources.len() as u64,
        binding,
    };
    let work = work_shape(&input)?;
    composition_core::compute::compute(&input)
        .map_err(|error| anyhow!("composition consensus refusal: {error}"))?;
    Ok(Prepared { input, work })
}

fn assert_checkpoint(
    rpc: &Rpc,
    entry: &CatalogEntry,
    checkpoint_id: Option<u64>,
    digest: B256,
    source_count: usize,
) -> Result<()> {
    if let Some(id) = checkpoint_id {
        let checkpoint = read_checkpoint(rpc, entry.snapshot, id)?;
        anyhow::ensure!(
            checkpoint.commitments.acc == digest,
            "checkpoint {id} commits {:#x}, recovered TGCM hashes to {digest:#x}",
            checkpoint.commitments.acc
        );
        anyhow::ensure!(
            checkpoint.commitments.leaf_count == source_count as u64,
            "checkpoint {id} source count {} != TGCM {}",
            checkpoint.commitments.leaf_count,
            source_count
        );
    }
    Ok(())
}

fn fetch_source(
    cfg: &Config,
    source_id: B256,
    blob_sha256: B256,
    cid_digest: B256,
) -> Result<SourcePreimage> {
    let cid =
        zk_core::cid::cid_v1_raw(blob_sha256.as_slice().try_into().expect("B256 is 32 bytes"));
    anyhow::ensure!(
        keccak256(cid.as_bytes()) == cid_digest,
        "source {source_id:#x} CID digest does not match its committed SHA-256"
    );
    let targets = cfg.ipfs.resolved_targets();
    let required = cfg.ipfs.required_successes();
    anyhow::ensure!(
        required > 0 && !targets.is_empty(),
        "composition source recovery requires at least one configured durable IPFS target"
    );

    let client = reqwest::blocking::Client::builder().timeout(Duration::from_secs(30)).build()?;
    let mut successes = 0usize;
    let mut accepted = None;
    let mut failures = Vec::new();
    for target in targets {
        let url = format!("{}{}", target.gateway, cid).replace("localhost", "127.0.0.1");
        let attempt = (|| -> Result<Vec<u8>> {
            let response = client.get(&url).send().with_context(|| format!("GET {url}"))?;
            anyhow::ensure!(
                response.status().is_success(),
                "gateway returned {}",
                response.status()
            );
            let blob = response.bytes()?.to_vec();
            let actual = B256::from(zk_core::cid::sha256(&blob));
            anyhow::ensure!(actual == blob_sha256, "served bytes SHA-256 {actual:#x}");
            Ok(blob)
        })();
        match attempt {
            Ok(blob) => {
                if let Some(expected) = accepted.as_ref() {
                    anyhow::ensure!(
                        expected == &blob,
                        "durable gateways served different source bytes"
                    );
                } else {
                    accepted = Some(blob);
                }
                successes += 1;
            }
            Err(error) => failures.push(format!("{}: {error}", target.name)),
        }
    }
    if successes < required {
        bail!(
            "source {source_id:#x} ({cid}) available from {successes}/{required} required gateways: {}",
            failures.join("; ")
        );
    }
    Ok(SourcePreimage { cid, blob: accepted.expect("success count proves bytes exist") })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;

    #[test]
    fn work_band_uses_entries_accounts_bytes_and_sources_independently() {
        assert_eq!(classify_work(2, 128, 128, 16 * 1024).unwrap().band, 1);
        assert_eq!(classify_work(3, 128, 128, 16 * 1024).unwrap().band, 2);
        assert_eq!(classify_work(2, 129, 128, 16 * 1024).unwrap().band, 2);
        assert_eq!(classify_work(2, 128, 129, 16 * 1024).unwrap().band, 2);
        assert_eq!(classify_work(2, 128, 128, 16 * 1024 + 1).unwrap().band, 2);
        assert_eq!(classify_work(2, 128, 128, 512 * 1024 + 1).unwrap().band, 4);
        assert_eq!(classify_work(8, 8_192, 8_192, 1024 * 1024).unwrap().band, 4);
    }

    // Compile-time: the measured cycle bands must stay monotonic and below the guest cap.
    const _: () = assert!(
        BAND_1_CYCLES < BAND_2_CYCLES
            && BAND_2_CYCLES < BAND_3_CYCLES
            && BAND_3_CYCLES < BAND_4_CYCLES
            && BAND_4_CYCLES < 1_000_000_000
    );

    #[test]
    fn mixed_and_exact_maximum_guest_fixtures_select_authenticated_bands() {
        let mixed = composition_core::fixture::mixed_input();
        assert_eq!(work_shape(&mixed).unwrap().band, 1);

        let two = composition_core::fixture::benchmark_input(2, 128);
        assert_eq!(work_shape(&two).unwrap().band, 1);

        let maximum = composition_core::fixture::benchmark_input(
            composition_core::MAX_SOURCES,
            composition_core::MAX_AGGREGATE_ENTRIES,
        );
        let shape = work_shape(&maximum).unwrap();
        assert_eq!(shape.source_count, 8);
        assert_eq!(shape.aggregate_entries, 8_192);
        assert_eq!(shape.union_accounts, 8_192);
        assert_eq!(shape.band, 4);
        composition_core::compute::compute(&maximum).expect("maximum fixture remains provable");
    }

    fn serve_once(status: &'static str, body: Vec<u8>) -> String {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        std::thread::spawn(move || {
            if let Ok((mut stream, _)) = listener.accept() {
                let mut request = [0u8; 1024];
                let _ = stream.read(&mut request);
                let _ = stream.write_all(
                    format!(
                        "HTTP/1.1 {status}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                        body.len()
                    )
                    .as_bytes(),
                );
                let _ = stream.write_all(&body);
            }
        });
        format!("http://127.0.0.1:{port}/ipfs/")
    }

    fn source_config(gateway: &str) -> Config {
        toml::from_str(&format!(
            r#"
rpc = "http://127.0.0.1:8545"
registry = "0x8D08973774F1Da59728e5a0f66453113A3E35A0F"
[ipfs]
min_success = 1
[[ipfs.targets]]
name = "fixture"
api = "http://127.0.0.1:1"
gateway = "{gateway}"
"#
        ))
        .unwrap()
    }

    #[test]
    fn unavailable_and_malformed_source_bytes_fail_before_proving() {
        let input = composition_core::fixture::mixed_input();
        let source = codec::parse_capture_manifest(&input.manifest, input.params.chain_id)
            .unwrap()
            .sources[0];

        let unavailable = serve_once("404 Not Found", Vec::new());
        let error = fetch_source(
            &source_config(&unavailable),
            source.source_id,
            source.blob_sha256,
            source.cid_digest,
        )
        .unwrap_err()
        .to_string();
        assert!(error.contains("available from 0/1"), "{error}");

        let malformed = serve_once("200 OK", b"not the committed source".to_vec());
        let error = fetch_source(
            &source_config(&malformed),
            source.source_id,
            source.blob_sha256,
            source.cid_digest,
        )
        .unwrap_err()
        .to_string();
        assert!(error.contains("served bytes SHA-256"), "{error}");

        let mut noncanonical = composition_core::fixture::mixed_input();
        noncanonical.source_preimages[0].blob.insert(1, b' ');
        assert!(
            work_shape(&noncanonical).unwrap_err().to_string().contains("not canonical"),
            "authenticated work sizing must refuse malformed canonical bytes"
        );
    }
}
