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

    /// Simulate, then sign and broadcast.
    ///
    /// The simulation is not an optimisation. A submit into a paused instance, or one whose
    /// verifier rotated a block ago, reverts — and paying gas to discover that is exactly the
    /// preventable spend ground rule 3 is about. A revert here is a hold, not a broadcast.
    pub fn send(
        &self,
        rpc: &Rpc,
        to: Address,
        data: Vec<u8>,
        gas_limit: u64,
        max_fee_wei: u128,
        simulate: bool,
    ) -> Result<B256> {
        if simulate {
            rpc.simulate(self.address(), to, &data)
                .context("simulation reverted; not broadcasting")?;
        }

        let nonce = rpc.transaction_count(self.address())?;
        let tx = TxEip1559 {
            chain_id: self.chain_id,
            nonce,
            gas_limit,
            max_fee_per_gas: max_fee_wei,
            max_priority_fee_per_gas: self.priority_fee_wei,
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
        Ok(Some(Receipt {
            success: r["status"].as_str() == Some("0x1"),
            block_number: hexu(r["blockNumber"].as_str()),
            gas_used: hexu(r["gasUsed"].as_str()),
        }))
    }
}
