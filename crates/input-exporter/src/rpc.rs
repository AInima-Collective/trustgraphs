//! A tiny JSON-RPC client, shared by the crate's binaries.
//!
//! Deliberately dependency-light: `reqwest` + `serde_json` and nothing else, so the exporter and the
//! instance scanner can talk to any endpoint without pulling a provider stack in. Everything here is
//! read-only — nothing in this crate ever signs or sends a transaction.

use alloy_primitives::{hex, Address, B256};
use anyhow::{anyhow, bail, Context, Result};
use serde_json::{json, Value};
use std::time::Duration;

pub const DEFAULT_RPC_TIMEOUT_SECONDS: u64 = 30;

/// A JSON-RPC endpoint.
pub struct Rpc {
    pub client: reqwest::Client,
    pub url: String,
}

/// A log as the node returns it, reduced to what `alloy_sol_types::SolEvent` needs.
pub struct RawLog {
    /// The contract that emitted it (the discovery hook for factory-created instances).
    pub address: Address,
    pub topics: Vec<B256>,
    pub data: Vec<u8>,
    pub block_number: u64,
    pub transaction_hash: B256,
}

impl Rpc {
    pub fn new(url: impl Into<String>) -> Self {
        Self::with_timeout(url, Duration::from_secs(DEFAULT_RPC_TIMEOUT_SECONDS))
    }

    pub fn with_timeout(url: impl Into<String>, timeout: Duration) -> Self {
        let client = reqwest::Client::builder()
            .timeout(timeout)
            .connect_timeout(timeout.min(Duration::from_secs(10)))
            .build()
            .expect("a reqwest client with finite timeouts is valid");
        Rpc { client, url: url.into() }
    }

    pub async fn call(&self, method: &str, params: Value) -> Result<Value> {
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

    /// The chain id of the endpoint we are reading from (a params-schema v2 domain separator).
    pub async fn eth_chain_id(&self) -> Result<u64> {
        let r = self.call("eth_chainId", json!([])).await?;
        parse_quantity(&r).context("eth_chainId returned no data")
    }

    /// The latest block number.
    pub async fn block_number(&self) -> Result<u64> {
        let r = self.call("eth_blockNumber", json!([])).await?;
        parse_quantity(&r).context("eth_blockNumber returned no data")
    }

    pub async fn eth_call(&self, to: Address, data: Vec<u8>) -> Result<Vec<u8>> {
        self.eth_call_at(to, data, "latest").await
    }

    /// Execute a read against one explicit block tag, keeping state reads and log prefixes on the
    /// same canonical view during live availability preflight.
    pub async fn eth_call_at(
        &self,
        to: Address,
        data: Vec<u8>,
        block: impl Into<String>,
    ) -> Result<Vec<u8>> {
        let params = json!([{
            "to": to,
            "data": format!("0x{}", hex::encode(&data))
        }, block.into()]);
        let r = self.call("eth_call", params).await?;
        let s = r.as_str().ok_or_else(|| anyhow!("eth_call returned no data"))?;
        Ok(hex::decode(s.trim_start_matches("0x"))?)
    }

    /// Every log of one transaction, in log order.
    pub async fn transaction_receipt_logs(&self, tx_hash: B256) -> Result<Vec<RawLog>> {
        let r = self
            .call("eth_getTransactionReceipt", json!([format!("0x{}", hex::encode(tx_hash))]))
            .await?;
        if r.is_null() {
            bail!("no receipt for transaction {tx_hash:#x}");
        }
        let logs = r["logs"].as_array().ok_or_else(|| anyhow!("receipt has no logs array"))?;
        logs.iter().map(decode_log).collect()
    }

    /// `eth_getLogs` across `[from, to]`, chunked to `chunk` blocks. `topics` may contain nulls.
    pub async fn get_logs(
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
                out.push(decode_log(log)?);
            }
            start = end + 1;
        }
        Ok(out)
    }
}

fn decode_log(log: &Value) -> Result<RawLog> {
    let topics = log["topics"]
        .as_array()
        .ok_or_else(|| anyhow!("log missing topics"))?
        .iter()
        .map(|t| parse_b256(t.as_str().unwrap_or("")))
        .collect::<Result<Vec<_>>>()?;
    let data = hex::decode(log["data"].as_str().unwrap_or("0x").trim_start_matches("0x"))?;
    let address = log["address"]
        .as_str()
        .unwrap_or_default()
        .parse()
        .unwrap_or(alloy_primitives::Address::ZERO);
    let block_number = parse_quantity(&log["blockNumber"]).unwrap_or_default();
    let transaction_hash =
        parse_b256(log["transactionHash"].as_str().unwrap_or("")).unwrap_or(B256::ZERO);
    Ok(RawLog { address, topics, data, block_number, transaction_hash })
}

/// Parse an RPC `QUANTITY` (`"0x…"`) into a u64.
pub fn parse_quantity(v: &Value) -> Result<u64> {
    let s = v.as_str().ok_or_else(|| anyhow!("expected a hex quantity, got {v}"))?;
    Ok(u64::from_str_radix(s.trim_start_matches("0x"), 16)?)
}

pub fn parse_b256(s: &str) -> Result<B256> {
    let bytes = hex::decode(s.trim_start_matches("0x"))?;
    if bytes.len() != 32 {
        bail!("expected 32-byte value, got {} bytes", bytes.len());
    }
    Ok(B256::from_slice(&bytes))
}

pub fn parse_addr(s: &str) -> Result<Address> {
    s.parse().with_context(|| format!("invalid address: {s}"))
}

#[cfg(test)]
mod tests {
    use super::Rpc;
    use std::io::Read as _;
    use std::net::TcpListener;
    use std::time::{Duration, Instant};

    #[tokio::test]
    async fn a_provider_that_accepts_and_never_answers_hits_the_request_deadline() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = [0u8; 1024];
            let _ = stream.read(&mut request);
            std::thread::sleep(Duration::from_millis(500));
        });

        let rpc = Rpc::with_timeout(format!("http://{addr}"), Duration::from_millis(100));
        let started = Instant::now();
        let error = rpc.block_number().await.unwrap_err();
        assert!(started.elapsed() < Duration::from_secs(1), "{error:#}");
    }
}
