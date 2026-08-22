//! Authenticated multi-gateway recovery for strict Envelope0PayloadV1 bytes.
//!
//! The chain commits SHA-256, so readers are availability sources rather than authorities. One
//! exact response is sufficient even when every other gateway is stale or down. Cache entries are
//! rehashed on every use; corruption is a miss, never an accepted witness.

use alloy_primitives::B256;
use anyhow::{bail, Context, Result};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::Semaphore;
use tokio::task::JoinSet;

#[derive(Clone, Debug)]
pub struct FetchConfig {
    pub gateways: Vec<String>,
    pub cache_dir: PathBuf,
    pub concurrency: usize,
    pub timeout: Duration,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct FetchMetrics {
    pub payloads: usize,
    pub cache_hits: usize,
    pub gateway_attempts: usize,
    pub gateway_successes: usize,
    pub latency_ms: u64,
}

#[derive(Clone, Debug)]
pub struct FetchRequest {
    pub node_id: B256,
    pub data_commitment: B256,
}

#[derive(Debug)]
struct OneFetch {
    node_id: B256,
    bytes: Vec<u8>,
    cache_hit: bool,
    attempts: usize,
    successes: usize,
    latency_ms: u64,
}

fn commitment(bytes: &[u8]) -> B256 {
    B256::from(zk_core::cid::sha256(bytes))
}

pub fn cid_for(commitment: B256) -> String {
    zk_core::cid::cid_v1_raw(commitment.as_slice().try_into().expect("B256 is 32 bytes"))
}

fn cache_path(cache_dir: &Path, cid: &str) -> PathBuf {
    cache_dir.join(format!("{cid}.bin"))
}

async fn fetch_one(
    client: reqwest::Client,
    config: Arc<FetchConfig>,
    request: FetchRequest,
) -> Result<OneFetch> {
    let started = Instant::now();
    let cid = cid_for(request.data_commitment);
    let path = cache_path(&config.cache_dir, &cid);
    if let Ok(bytes) = tokio::fs::read(&path).await {
        if commitment(&bytes) == request.data_commitment {
            return Ok(OneFetch {
                node_id: request.node_id,
                bytes,
                cache_hit: true,
                attempts: 0,
                successes: 0,
                latency_ms: started.elapsed().as_millis().try_into().unwrap_or(u64::MAX),
            });
        }
    }

    let mut failures = Vec::new();
    let mut attempts = 0usize;
    for gateway in &config.gateways {
        attempts += 1;
        let url = format!("{gateway}{cid}").replace("localhost", "127.0.0.1");
        let attempt = async {
            let mut response =
                client.get(&url).send().await.with_context(|| format!("GET {url}"))?;
            anyhow::ensure!(response.status().is_success(), "HTTP {}", response.status());
            if let Some(length) = response.content_length() {
                anyhow::ensure!(
                    length <= eas_offchain_v2::payload_v1::MAX_PAYLOAD_BYTES as u64,
                    "declared body is {length} bytes"
                );
            }
            // Enforce the bound while streaming too. `Content-Length` is only a hint: a hostile or
            // broken gateway can omit it and stream an arbitrarily large chunked body.
            let mut bytes = Vec::new();
            while let Some(chunk) = response.chunk().await? {
                anyhow::ensure!(
                    bytes.len().saturating_add(chunk.len())
                        <= eas_offchain_v2::payload_v1::MAX_PAYLOAD_BYTES,
                    "streamed body exceeds {} bytes",
                    eas_offchain_v2::payload_v1::MAX_PAYLOAD_BYTES
                );
                bytes.extend_from_slice(&chunk);
            }
            let actual = commitment(&bytes);
            anyhow::ensure!(
                actual == request.data_commitment,
                "SHA-256 {actual:#x} != committed {:#x}",
                request.data_commitment
            );
            Ok::<_, anyhow::Error>(bytes)
        }
        .await;
        match attempt {
            Ok(bytes) => {
                tokio::fs::create_dir_all(&config.cache_dir)
                    .await
                    .with_context(|| format!("create cache {}", config.cache_dir.display()))?;
                tokio::fs::write(&path, &bytes)
                    .await
                    .with_context(|| format!("write verified cache {}", path.display()))?;
                return Ok(OneFetch {
                    node_id: request.node_id,
                    bytes,
                    cache_hit: false,
                    attempts,
                    successes: 1,
                    latency_ms: started.elapsed().as_millis().try_into().unwrap_or(u64::MAX),
                });
            }
            Err(error) => failures.push(format!("{gateway}: {error}")),
        }
    }
    bail!(
        "E0_AVAILABILITY: node {:#x} CID {cid} unavailable from {} gateway(s): {}",
        request.node_id,
        attempts,
        failures.join("; ")
    )
}

/// Recover exactly one newest payload for every anchored node.
pub async fn fetch_payloads(
    requests: Vec<FetchRequest>,
    config: FetchConfig,
) -> Result<(Vec<(B256, Vec<u8>)>, FetchMetrics)> {
    if requests.is_empty() {
        return Ok((Vec::new(), FetchMetrics::default()));
    }
    if config.gateways.is_empty() {
        bail!("E0_AVAILABILITY: no --envelope0-gateway configured");
    }
    if config.concurrency == 0 || config.concurrency > 64 {
        bail!("--envelope0-fetch-concurrency must be in 1..=64");
    }
    let client = reqwest::Client::builder().timeout(config.timeout).build()?;
    let config = Arc::new(config);
    let semaphore = Arc::new(Semaphore::new(config.concurrency));
    let mut tasks = JoinSet::new();
    for request in requests {
        let permit = semaphore.clone().acquire_owned().await?;
        let client = client.clone();
        let config = config.clone();
        tasks.spawn(async move {
            let _permit = permit;
            fetch_one(client, config, request).await
        });
    }

    let mut payloads = Vec::new();
    let mut metrics = FetchMetrics::default();
    while let Some(joined) = tasks.join_next().await {
        let fetched = joined.context("Envelope0 fetch task panicked")??;
        metrics.payloads += 1;
        metrics.cache_hits += usize::from(fetched.cache_hit);
        metrics.gateway_attempts += fetched.attempts;
        metrics.gateway_successes += fetched.successes;
        metrics.latency_ms = metrics.latency_ms.saturating_add(fetched.latency_ms);
        payloads.push((fetched.node_id, fetched.bytes));
    }
    payloads.sort_by_key(|(node_id, _)| *node_id);
    Ok((payloads, metrics))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;

    fn one_response(status: &str, body: Vec<u8>) -> String {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let status = status.to_owned();
        std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = [0u8; 4096];
            let _ = stream.read(&mut request);
            write!(
                stream,
                "HTTP/1.1 {status}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                body.len()
            )
            .unwrap();
            stream.write_all(&body).unwrap();
        });
        format!("http://{address}/ipfs/")
    }

    fn one_chunked_response(body: Vec<u8>, chunk_size: usize) -> String {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = [0u8; 4096];
            let _ = stream.read(&mut request);
            let _ = write!(
                stream,
                "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n"
            );
            for chunk in body.chunks(chunk_size) {
                if write!(stream, "{:x}\r\n", chunk.len()).is_err()
                    || stream.write_all(chunk).is_err()
                    || stream.write_all(b"\r\n").is_err()
                {
                    return;
                }
            }
            let _ = stream.write_all(b"0\r\n\r\n");
        });
        format!("http://{address}/ipfs/")
    }

    fn temporary_cache(label: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "tg-e0-fetch-{label}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()
        ))
    }

    #[tokio::test]
    async fn one_failed_gateway_does_not_interrupt_exact_recovery() {
        let bytes = b"canonical payload bytes".to_vec();
        let digest = commitment(&bytes);
        let cache = temporary_cache("fallback");
        let bad = one_response("503 Unavailable", Vec::new());
        let good = one_response("200 OK", bytes.clone());
        let (payloads, metrics) = fetch_payloads(
            vec![FetchRequest { node_id: B256::from([7; 32]), data_commitment: digest }],
            FetchConfig {
                gateways: vec![bad, good],
                cache_dir: cache.clone(),
                concurrency: 2,
                timeout: Duration::from_secs(2),
            },
        )
        .await
        .unwrap();
        assert_eq!(payloads[0].1, bytes);
        assert_eq!(metrics.gateway_attempts, 2);
        assert_eq!(metrics.gateway_successes, 1);

        // A second read is authenticated from cache and needs no live gateway.
        let (cached, cached_metrics) = fetch_payloads(
            vec![FetchRequest { node_id: B256::from([7; 32]), data_commitment: digest }],
            FetchConfig {
                gateways: vec!["http://127.0.0.1:1/ipfs/".into()],
                cache_dir: cache.clone(),
                concurrency: 1,
                timeout: Duration::from_millis(50),
            },
        )
        .await
        .unwrap();
        assert_eq!(cached[0].1, bytes);
        assert_eq!(cached_metrics.cache_hits, 1);
        let _ = std::fs::remove_dir_all(cache);
    }

    #[tokio::test]
    async fn corrupt_stale_cache_and_gateway_are_skipped_for_an_exact_reader() {
        let bytes = b"new canonical payload bytes".to_vec();
        let digest = commitment(&bytes);
        let cid = cid_for(digest);
        let cache = temporary_cache("stale");
        std::fs::create_dir_all(&cache).unwrap();
        std::fs::write(cache_path(&cache, &cid), b"stale cached bytes").unwrap();
        let corrupt = one_response("200 OK", b"corrupt gateway bytes".to_vec());
        let exact = one_response("200 OK", bytes.clone());

        let (payloads, metrics) = fetch_payloads(
            vec![FetchRequest { node_id: B256::from([8; 32]), data_commitment: digest }],
            FetchConfig {
                gateways: vec![corrupt, exact],
                cache_dir: cache.clone(),
                concurrency: 1,
                timeout: Duration::from_secs(2),
            },
        )
        .await
        .unwrap();

        assert_eq!(payloads[0].1, bytes);
        assert_eq!(metrics.cache_hits, 0);
        assert_eq!(metrics.gateway_attempts, 2);
        assert_eq!(std::fs::read(cache_path(&cache, &cid)).unwrap(), bytes);
        let _ = std::fs::remove_dir_all(cache);
    }

    #[tokio::test]
    async fn missing_all_readers_fails_strict_availability() {
        let bytes = b"unavailable canonical bytes".to_vec();
        let result = fetch_payloads(
            vec![FetchRequest {
                node_id: B256::from([9; 32]),
                data_commitment: commitment(&bytes),
            }],
            FetchConfig {
                gateways: vec![
                    one_response("404 Not Found", Vec::new()),
                    one_response("503 Unavailable", Vec::new()),
                ],
                cache_dir: temporary_cache("missing"),
                concurrency: 1,
                timeout: Duration::from_secs(2),
            },
        )
        .await;
        let message = result.unwrap_err().to_string();
        assert!(message.contains("E0_AVAILABILITY"), "{message}");
        assert!(message.contains("2 gateway(s)"), "{message}");
    }

    #[tokio::test]
    async fn declared_and_chunked_oversized_bodies_are_bounded() {
        let maximum = eas_offchain_v2::payload_v1::MAX_PAYLOAD_BYTES;
        for (label, gateway) in [
            ("declared", one_response("200 OK", vec![0; maximum + 1])),
            ("chunked", one_chunked_response(vec![0; maximum + 1], 32 * 1024)),
        ] {
            let result = fetch_payloads(
                vec![FetchRequest {
                    node_id: B256::from([10; 32]),
                    data_commitment: B256::from([11; 32]),
                }],
                FetchConfig {
                    gateways: vec![gateway],
                    cache_dir: temporary_cache(label),
                    concurrency: 1,
                    timeout: Duration::from_secs(2),
                },
            )
            .await;
            let message = result.unwrap_err().to_string();
            assert!(message.contains("E0_AVAILABILITY"), "{label}: {message}");
            assert!(message.contains("body"), "{label}: {message}");
        }
    }
}
