//! Signing and sending, with the two behaviours that separate a daemon from a script: simulate
//! before broadcasting, and replace rather than abandon a stuck transaction.

use alloy_consensus::private::alloy_eips::eip2718::Encodable2718;
use alloy_consensus::{SignableTransaction, TxEip1559, TxEnvelope};
use alloy_primitives::{Address, Bytes, TxKind, B256, U256};
use alloy_signer::SignerSync;
use alloy_signer_local::PrivateKeySigner;
use anyhow::{anyhow, bail, Context, Result};
use serde_json::json;

use crate::chain::Rpc;

pub struct Sender {
    signer: PrivateKeySigner,
    chain_id: u64,
    priority_fee_wei: u128,
}

impl Sender {
    pub fn from_env(var: &str, chain_id: u64, priority_fee_wei: u128) -> Result<Self> {
        let key = std::env::var(var)
            .with_context(|| format!("{var} is not set: the operator cannot send without a key"))?;
        let signer: PrivateKeySigner = key
            .trim()
            .trim_start_matches("0x")
            .parse()
            .with_context(|| format!("{var} is not a valid secp256k1 private key"))?;
        Ok(Self { signer, chain_id, priority_fee_wei })
    }

    pub fn address(&self) -> Address {
        self.signer.address()
    }

    /// Estimate, simulate at the intended limit, then sign and broadcast.
    ///
    /// The simulation is not an optimisation. A submit into a paused instance, or one whose
    /// verifier rotated a block ago, reverts — and paying gas to discover that is exactly the
    /// preventable spend ground rule 3 is about. A revert here is a hold, not a broadcast.
    ///
    /// H-3 (2026-08-13 audit): `gas_cap` is a CEILING, not the limit. The real limit comes from
    /// `eth_estimateGas` plus margin; an estimate above the cap is refused before any broadcast
    /// (previously the hard-coded limit was both blind to a too-big call AND invisible to the
    /// simulation, so an under-gassed revert passed `eth_call` and burned the full limit on-chain).
    pub fn send(
        &self,
        rpc: &Rpc,
        to: Address,
        data: Vec<u8>,
        gas_cap: u64,
        max_fee_wei: u128,
        simulate: bool,
    ) -> Result<B256> {
        let estimate = rpc
            .estimate_gas(self.address(), to, &data)
            .context("gas estimation failed/reverted; not broadcasting")?;
        let gas_limit = gas_with_margin(estimate, gas_cap)?;

        if simulate {
            rpc.simulate(self.address(), to, &data, Some(gas_limit))
                .context("simulation reverted; not broadcasting")?;
        }

        let nonce = rpc.transaction_count(self.address())?;
        self.sign_and_broadcast(rpc, to, data, gas_limit, nonce, max_fee_wei, self.priority_fee_wei)
    }

    /// [`Self::send`] + receipt watching + stuck-transaction replacement (M-11, 2026-08-13
    /// audit). A transaction stranded under the basefee gate used to queue everything behind its
    /// pending nonce forever, despite the `replacement_after_s` knob claiming otherwise. Here:
    /// if no receipt arrives within `replacement_after_s`, the SAME nonce is re-signed with fees
    /// bumped ≥12.5% (the mempool replacement floor) and rebroadcast — up to two replacements —
    /// while every broadcast hash keeps being polled (the original may still land). A timeout is
    /// still UNKNOWN, never "did not happen".
    #[allow(clippy::too_many_arguments)]
    pub fn send_watched(
        &self,
        rpc: &Rpc,
        to: Address,
        data: Vec<u8>,
        gas_cap: u64,
        max_fee_wei: u128,
        simulate: bool,
        replacement_after_s: u64,
        timeout_s: u64,
    ) -> Result<(B256, Receipt)> {
        let estimate = rpc
            .estimate_gas(self.address(), to, &data)
            .context("gas estimation failed/reverted; not broadcasting")?;
        let gas_limit = gas_with_margin(estimate, gas_cap)?;
        if simulate {
            rpc.simulate(self.address(), to, &data, Some(gas_limit))
                .context("simulation reverted; not broadcasting")?;
        }

        let nonce = rpc.transaction_count(self.address())?;
        let mut max_fee = max_fee_wei;
        let mut priority = self.priority_fee_wei;
        let mut hashes = vec![self.sign_and_broadcast(
            rpc,
            to,
            data.clone(),
            gas_limit,
            nonce,
            max_fee,
            priority,
        )?];

        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(timeout_s);
        let mut last_broadcast = std::time::Instant::now();
        let mut replacements = 0u32;
        loop {
            for h in &hashes {
                if let Some(r) = rpc.receipt(*h)? {
                    return Ok((*h, r));
                }
            }
            if std::time::Instant::now() >= deadline {
                bail!(
                    "no receipt for {} broadcast(s) of nonce {nonce} within {timeout_s}s — treat \
                     as UNKNOWN, not failed (hashes: {})",
                    hashes.len(),
                    hashes.iter().map(|h| format!("{h:#x}")).collect::<Vec<_>>().join(", ")
                );
            }
            if replacements < 2
                && last_broadcast.elapsed() >= std::time::Duration::from_secs(replacement_after_s)
            {
                // ≥12.5% bump on both fee fields — the mempool floor for a same-nonce replace.
                max_fee = max_fee.saturating_add(max_fee / 8).saturating_add(1);
                priority = priority.saturating_add(priority / 8).saturating_add(1);
                match self.sign_and_broadcast(
                    rpc,
                    to,
                    data.clone(),
                    gas_limit,
                    nonce,
                    max_fee,
                    priority,
                ) {
                    Ok(h) => {
                        replacements += 1;
                        hashes.push(h);
                    }
                    // "already known" / "nonce too low" here means an earlier broadcast is
                    // winning — keep polling the hashes we have rather than failing the watch.
                    Err(_) => {}
                }
                last_broadcast = std::time::Instant::now();
            }
            std::thread::sleep(std::time::Duration::from_secs(2));
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn sign_and_broadcast(
        &self,
        rpc: &Rpc,
        to: Address,
        data: Vec<u8>,
        gas_limit: u64,
        nonce: u64,
        max_fee_wei: u128,
        priority_fee_wei: u128,
    ) -> Result<B256> {
        let tx = TxEip1559 {
            chain_id: self.chain_id,
            nonce,
            gas_limit,
            max_fee_per_gas: max_fee_wei,
            max_priority_fee_per_gas: priority_fee_wei,
            to: TxKind::Call(to),
            value: U256::ZERO,
            access_list: Default::default(),
            input: Bytes::from(data),
        };
        let sig = self
            .signer
            .sign_hash_sync(&tx.signature_hash())
            .map_err(|e| anyhow!("signing failed: {e}"))?;
        let envelope: TxEnvelope = tx.into_signed(sig).into();

        rpc.send_raw(&envelope.encoded_2718())
    }
}

/// The gas limit a transaction will actually carry: the node's estimate plus 25% headroom,
/// refused outright when the estimate exceeds `cap` (H-3 — a call that legitimately needs more
/// than the cap is a hold for a human, not a broadcast that reverts at full price), and clamped
/// to the cap so the margin cannot exceed it.
pub fn gas_with_margin(estimate: u64, cap: u64) -> Result<u64> {
    if estimate > cap {
        bail!(
            "estimated gas {estimate} exceeds the {cap} cap; refusing to broadcast — if the \
             estimate is legitimate, raise the cap deliberately rather than letting a griefed \
             call burn it"
        );
    }
    Ok(estimate.saturating_add(estimate / 4).min(cap))
}

/// `gas_used × effective_gas_price` (wei), as USD-cents at a crude configured ETH price —
/// the number [`operator_core::journal::Record::SubmitGas`] feeds into the loss budget.
/// Rounds UP: a submit that cost anything must never round to free.
pub fn gas_cost_cents(gas_used: u64, effective_gas_price_wei: u128, eth_usd: u64) -> u64 {
    let wei = (gas_used as u128).saturating_mul(effective_gas_price_wei);
    let cents = wei.saturating_mul(eth_usd as u128).saturating_mul(100).div_ceil(10u128.pow(18));
    u64::try_from(cents).unwrap_or(u64::MAX).max(1)
}

/// Wait for a receipt, or give up. Giving up is not the same as failing: the transaction may still
/// land, so the caller must treat a timeout as "unknown", never as "did not happen".
pub fn await_receipt(rpc: &Rpc, tx: B256, timeout_s: u64, poll_s: u64) -> Result<Receipt> {
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(timeout_s);
    loop {
        if let Some(r) = rpc.receipt(tx)? {
            return Ok(r);
        }
        if std::time::Instant::now() >= deadline {
            bail!("no receipt for {tx:#x} within {timeout_s}s — treat as UNKNOWN, not failed");
        }
        std::thread::sleep(std::time::Duration::from_secs(poll_s));
    }
}

#[derive(Debug, Clone)]
pub struct Receipt {
    pub success: bool,
    pub block_number: u64,
    pub gas_used: u64,
    /// What each gas unit actually cost (EIP-1559 `effectiveGasPrice`); zero when the node
    /// omits it, which only under-counts the budget — never blocks.
    pub effective_gas_price: u128,
}

impl Rpc {
    pub fn transaction_count(&self, who: Address) -> Result<u64> {
        let r = self.call("eth_getTransactionCount", json!([who, "pending"]))?;
        let s = r.as_str().ok_or_else(|| anyhow!("eth_getTransactionCount returned no data"))?;
        Ok(u64::from_str_radix(s.trim_start_matches("0x"), 16)?)
    }

    pub fn balance(&self, who: Address) -> Result<u128> {
        let r = self.call("eth_getBalance", json!([who, "latest"]))?;
        let s = r.as_str().ok_or_else(|| anyhow!("eth_getBalance returned no data"))?;
        Ok(u128::from_str_radix(s.trim_start_matches("0x"), 16)?)
    }

    pub fn send_raw(&self, raw: &[u8]) -> Result<B256> {
        let r = self.call("eth_sendRawTransaction", json!([format!("0x{}", hex::encode(raw))]))?;
        let s = r.as_str().ok_or_else(|| anyhow!("eth_sendRawTransaction returned no hash"))?;
        let b = hex::decode(s.trim_start_matches("0x"))?;
        anyhow::ensure!(b.len() == 32, "transaction hash was not 32 bytes");
        Ok(B256::from_slice(&b))
    }

    pub fn receipt(&self, tx: B256) -> Result<Option<Receipt>> {
        let r =
            self.call("eth_getTransactionReceipt", json!([format!("0x{}", hex::encode(tx))]))?;
        if r.is_null() {
            return Ok(None);
        }
        let hexu = |v: Option<&str>| -> u64 {
            v.and_then(|s| u64::from_str_radix(s.trim_start_matches("0x"), 16).ok()).unwrap_or(0)
        };
        let hexu128 = |v: Option<&str>| -> u128 {
            v.and_then(|s| u128::from_str_radix(s.trim_start_matches("0x"), 16).ok()).unwrap_or(0)
        };
        Ok(Some(Receipt {
            success: r["status"].as_str() == Some("0x1"),
            block_number: hexu(r["blockNumber"].as_str()),
            gas_used: hexu(r["gasUsed"].as_str()),
            effective_gas_price: hexu128(r["effectiveGasPrice"].as_str()),
        }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read as _, Write as _};
    use std::net::TcpListener;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;

    // ---- H-3 pure pieces ---------------------------------------------------

    #[test]
    fn gas_with_margin_pads_and_caps() {
        // 1M estimate → 1.25M limit, under a 1.5M cap.
        assert_eq!(gas_with_margin(1_000_000, 1_500_000).unwrap(), 1_250_000);
        // The margin is clamped to the cap.
        assert_eq!(gas_with_margin(1_400_000, 1_500_000).unwrap(), 1_500_000);
    }

    /// H-3 regression: an estimate above the cap is a REFUSAL, not a broadcast that reverts at
    /// full price.
    #[test]
    fn gas_with_margin_refuses_above_cap() {
        let err = gas_with_margin(1_500_001, 1_500_000).unwrap_err().to_string();
        assert!(err.contains("refusing to broadcast"), "{err}");
    }

    #[test]
    fn gas_cost_cents_rounds_up_and_never_free() {
        // 1M gas at 10 gwei = 0.01 ETH; at $5000/ETH = $50 = 5000 cents.
        assert_eq!(gas_cost_cents(1_000_000, 10_000_000_000, 5_000), 5_000);
        // Tiny-but-nonzero cost never rounds to free.
        assert_eq!(gas_cost_cents(1, 1, 1), 1);
        // A node that omits effectiveGasPrice under-counts but still books the floor.
        assert_eq!(gas_cost_cents(1_000_000, 0, 5_000), 1);
    }

    // ---- H-3 end-to-end: a reverting estimate is a hold, not a broadcast ----

    /// A single-request JSON-RPC stub: answers `eth_estimateGas` with an execution revert and
    /// records whether anything was ever broadcast.
    fn stub_rpc(broadcast_seen: Arc<AtomicBool>) -> String {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut s) = stream else { continue };
                let mut buf = [0u8; 65536];
                let n = s.read(&mut buf).unwrap_or(0);
                let req = String::from_utf8_lossy(&buf[..n]).to_string();
                let body = if req.contains("eth_estimateGas") {
                    r#"{"jsonrpc":"2.0","id":1,"error":{"code":3,"message":"execution reverted: StaleCheckpoint"}}"#
                } else if req.contains("eth_sendRawTransaction") {
                    broadcast_seen.store(true, Ordering::SeqCst);
                    r#"{"jsonrpc":"2.0","id":1,"result":"0x1111111111111111111111111111111111111111111111111111111111111111"}"#
                } else {
                    r#"{"jsonrpc":"2.0","id":1,"result":"0x0"}"#
                };
                let resp = format!(
                    "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\n\r\n{}",
                    body.len(),
                    body
                );
                let _ = s.write_all(resp.as_bytes());
            }
        });
        format!("http://{addr}")
    }

    /// H-3 regression: pre-fix, a submit that could only revert passed the gasless `eth_call`
    /// simulation and burned its full hard-coded limit on-chain. Now the estimate itself reverts
    /// the attempt — nothing is ever broadcast.
    #[test]
    fn reverting_estimate_never_broadcasts() {
        let broadcast_seen = Arc::new(AtomicBool::new(false));
        let url = stub_rpc(broadcast_seen.clone());
        let rpc = Rpc::new(url);

        std::env::set_var("TEST_SUBMITTER_KEY", "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
        let sender = Sender::from_env("TEST_SUBMITTER_KEY", 31337, 100_000_000).unwrap();

        let err = sender
            .send(&rpc, Address::ZERO, vec![0xAB; 4], 1_500_000, 80_000_000_000, true)
            .unwrap_err()
            .to_string();
        assert!(err.contains("not broadcasting"), "{err}");
        assert!(
            !broadcast_seen.load(Ordering::SeqCst),
            "REGRESSION: a reverting estimate must never reach eth_sendRawTransaction"
        );
    }
}
