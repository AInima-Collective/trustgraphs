//! envelope0-gen — build a signed envelope-0 chained log (an `Envelope0Witness`) for a key.
//!
//! This is the attester-side tool: it appends EAS-offchain-v2 attestations (and in-log
//! revocations) to a log, signs each attestation (EIP-712) and the running head (EIP-191),
//! and writes the witness JSON the exporter merges into `GuestInput.lane2`. It also prints
//! the values needed on-chain: the nodeId to `register()` and the head to `anchor()`.
//!
//! Example (one edge, confidence 60):
//!   envelope0-gen --key 0x... --domain-separator 0x... --schema 0xab..ab \
//!     --attest 0x<recipient>:60 --out log.json

use alloy_primitives::{hex, keccak256, Address, B256, U256};
use anyhow::{anyhow, bail, Context, Result};
use clap::Parser;
use envelopes_crate::eas_offchain::{
    address_node_id, attest_struct_hash, eip712_digest, head_payload, log_head, offchain_uid_v2,
    Envelope0Witness, LogEntry, OffchainAttestation, ENTRY_ATTEST, ENTRY_REVOKE,
};
use envelopes_crate::ecdsa::eip191_digest32;
use k256::ecdsa::SigningKey;

#[derive(Parser, Debug)]
#[command(about = "Build a signed envelope-0 chained log (Envelope0Witness JSON)")]
struct Args {
    /// The attester's secp256k1 private key (0x-hex, 32 bytes).
    #[arg(long)]
    key: String,
    /// The pinned EIP-712 domain separator the instance's params accept.
    #[arg(long)]
    domain_separator: String,
    /// The attestation schema UID (same as lane 1's).
    #[arg(long)]
    schema: String,
    /// Attestations to append, as `0x<recipient>:<confidence>[:<time>]` (repeatable, in order).
    #[arg(long)]
    attest: Vec<String>,
    /// In-log revocations, as 0-based indexes into the ATTEST list (repeatable; applied after
    /// all attests, in the given order).
    #[arg(long)]
    revoke: Vec<usize>,
    /// Output path for the witness JSON.
    #[arg(long, default_value = "envelope0_log.json")]
    out: String,
}

fn sign_prehash(sk: &SigningKey, prehash: &B256) -> Result<Vec<u8>> {
    let (sig, _) = sk
        .sign_prehash_recoverable(prehash.as_slice())
        .map_err(|e| anyhow!("signing failed: {e}"))?;
    let sig = sig.normalize_s().unwrap_or(sig);
    for v in 0u8..=1 {
        let rid = k256::ecdsa::RecoveryId::from_byte(v).unwrap();
        if let Ok(vk) =
            k256::ecdsa::VerifyingKey::recover_from_prehash(prehash.as_slice(), &sig, rid)
        {
            if vk == *sk.verifying_key() {
                let mut out = sig.to_bytes().to_vec();
                out.push(v);
                return Ok(out);
            }
        }
    }
    bail!("no recovery id matched (unreachable)")
}

fn ethereum_wire_signature(mut signature: Vec<u8>) -> Vec<u8> {
    if let Some(v) = signature.last_mut() {
        if *v < 27 {
            *v += 27;
        }
    }
    signature
}

fn parse_b256(s: &str) -> Result<B256> {
    let b = hex::decode(s.trim_start_matches("0x"))?;
    if b.len() != 32 {
        bail!("expected 32 bytes, got {}", b.len());
    }
    Ok(B256::from_slice(&b))
}

fn main() -> Result<()> {
    let args = Args::parse();
    let key_bytes = hex::decode(args.key.trim_start_matches("0x")).context("bad --key hex")?;
    let sk = SigningKey::from_slice(&key_bytes).map_err(|e| anyhow!("bad --key: {e}"))?;
    let unc = sk.verifying_key().to_encoded_point(false);
    let owner = Address::from_slice(&keccak256(&unc.as_bytes()[1..])[12..]);
    let ds = parse_b256(&args.domain_separator)?;
    let schema = parse_b256(&args.schema)?;

    let mut entries: Vec<LogEntry> = Vec::new();
    let mut attestations: Vec<OffchainAttestation> = Vec::new();
    let mut uids: Vec<B256> = Vec::new();

    for (i, spec) in args.attest.iter().enumerate() {
        let parts: Vec<&str> = spec.split(':').collect();
        if parts.len() < 2 {
            bail!("--attest must be 0x<recipient>:<confidence>[:<time>], got {spec}");
        }
        let recipient: Address = parts[0].parse().context("bad recipient")?;
        let confidence: u64 = parts[1].parse().context("bad confidence")?;
        let time: u64 = if parts.len() > 2 { parts[2].parse()? } else { 1000 + i as u64 };

        // Same ABI shape as lane 1: (string comment, uint256 confidence) — comment empty.
        let mut data = vec![0u8; 64];
        data[32..].copy_from_slice(&U256::from(confidence).to_be_bytes::<32>());

        let mut salt = [0u8; 32];
        salt[31] = (i + 1) as u8; // deterministic per-entry salt for reproducible fixtures
        let mut a = OffchainAttestation {
            version: 2,
            schema,
            recipient,
            time,
            expiration_time: 0,
            revocable: true,
            ref_uid: B256::ZERO,
            data,
            salt: B256::from(salt),
            signature: vec![],
        };
        a.signature = sign_prehash(&sk, &eip712_digest(ds, attest_struct_hash(&a)))?;
        let uid = offchain_uid_v2(&a);
        entries.push(LogEntry { kind: ENTRY_ATTEST, uid });
        uids.push(uid);
        attestations.push(a);
    }

    for idx in &args.revoke {
        let uid = *uids.get(*idx).ok_or_else(|| anyhow!("--revoke {idx} out of range"))?;
        entries.push(LogEntry { kind: ENTRY_REVOKE, uid });
    }

    let head = log_head(&entries);
    let head_signature =
        sign_prehash(&sk, &eip191_digest32(&head_payload(head, entries.len() as u64)))?;
    let witness = Envelope0Witness { owner, entries, attestations, head_signature };

    std::fs::write(&args.out, serde_json::to_string_pretty(&witness)?)?;
    println!("owner:   0x{}", hex::encode(owner));
    println!("nodeId:  0x{}", hex::encode(address_node_id(owner)));
    println!("head:    0x{}", hex::encode(head));
    println!("count:   {}", witness.entries.len());
    // The head co-signature doubles as the on-chain ingress proof (H-5):
    // anchor(bytes32 nodeId, uint8 0, bytes32 head, uint64 count, bytes32 dataCommitment, bytes headSig)
    // The guest's k256 recovery accepts parity 0/1, while OpenZeppelin ECDSA uses the Ethereum
    // wire convention 27/28. Normalize only the printed transaction argument; keep the witness
    // bytes exactly as signed for guest/native parity.
    let onchain_head_signature = ethereum_wire_signature(witness.head_signature.clone());
    println!("headSig: 0x{}", hex::encode(onchain_head_signature));
    println!("wrote {}", args.out);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::ethereum_wire_signature;

    #[test]
    fn printed_signature_uses_openzeppelin_recovery_ids() {
        let mut parity_zero = vec![0u8; 65];
        let mut parity_one = vec![0u8; 65];
        parity_one[64] = 1;
        let mut already_wire = vec![0u8; 65];
        already_wire[64] = 28;

        assert_eq!(ethereum_wire_signature(parity_zero.clone())[64], 27);
        assert_eq!(ethereum_wire_signature(parity_one)[64], 28);
        assert_eq!(ethereum_wire_signature(already_wire.clone()), already_wire);
        parity_zero.clear();
        assert!(ethereum_wire_signature(parity_zero).is_empty());
    }
}
