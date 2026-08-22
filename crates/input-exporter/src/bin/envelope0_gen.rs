//! `envelope0-gen` — deterministic fixture/debug generator for `Envelope0PayloadV1`.
//!
//! This raw-key CLI is not the product signing path. M3 uses wallet-provider signatures and random
//! salts. Here deterministic salts make local fixtures reproducible; the output is the exact binary
//! payload consumed by the guest and accepted by `input-exporter --envelope0-log`.

use alloy_primitives::{hex, keccak256, Address, B256, U256};
use anyhow::{anyhow, bail, Context, Result};
use clap::Parser;
use eas_offchain_v2::{
    address_node_id, attest_struct_hash, eip712_digest, log_head, offchain_uid_v2, payload_v1,
    LogEntry, OffchainAttestation, ENTRY_ATTEST, ENTRY_REVOKE,
};
use k256::ecdsa::SigningKey;

const ZERO_B256: &str = "0x0000000000000000000000000000000000000000000000000000000000000000";

#[derive(Parser, Debug)]
#[command(about = "Build canonical Envelope0PayloadV1 bytes and a typed head authorization")]
struct Args {
    /// Fixture/debug secp256k1 key. Never pass a funded or deployment key.
    #[arg(long)]
    key: String,
    /// Pinned official EAS `EAS Attestation` domain separator.
    #[arg(long, alias = "domain-separator")]
    eas_domain_separator: String,
    /// Pinned `Trustgraphs Offchain Head` v2 domain separator for this chain and registry.
    #[arg(long)]
    head_domain_separator: String,
    /// Canonical vouch schema UID.
    #[arg(long)]
    schema: String,
    /// Registry predecessor head (zero for a first anchor).
    #[arg(long, default_value = ZERO_B256)]
    previous_head: String,
    /// Append `0x<recipient>:<confidence>[:<time>]` (repeatable, in order).
    #[arg(long)]
    attest: Vec<String>,
    /// Append a revoke naming a 0-based index in the attest list (repeatable, after all attests).
    #[arg(long)]
    revoke: Vec<usize>,
    /// Output path for exact canonical payload bytes.
    #[arg(long, default_value = "envelope0_payload.bin")]
    out: String,
}

fn sign_canonical(sk: &SigningKey, prehash: &B256) -> Result<Vec<u8>> {
    let (signature, _) = sk
        .sign_prehash_recoverable(prehash.as_slice())
        .map_err(|error| anyhow!("signing failed: {error}"))?;
    let signature = signature.normalize_s().unwrap_or(signature);
    for parity in 0u8..=1 {
        let recovery_id = k256::ecdsa::RecoveryId::from_byte(parity).unwrap();
        if let Ok(verifying_key) = k256::ecdsa::VerifyingKey::recover_from_prehash(
            prehash.as_slice(),
            &signature,
            recovery_id,
        ) {
            if verifying_key == *sk.verifying_key() {
                let mut output = signature.to_bytes().to_vec();
                output.push(parity + 27);
                return Ok(output);
            }
        }
    }
    bail!("no recovery id matched")
}

fn parse_b256(value: &str) -> Result<B256> {
    let bytes = hex::decode(value.trim_start_matches("0x"))?;
    if bytes.len() != 32 {
        bail!("expected 32 bytes, got {}", bytes.len());
    }
    Ok(B256::from_slice(&bytes))
}

fn main() -> Result<()> {
    let args = Args::parse();
    if args.attest.is_empty() {
        bail!("at least one --attest is required");
    }
    let key_bytes = hex::decode(args.key.trim_start_matches("0x")).context("bad --key hex")?;
    let signing_key =
        SigningKey::from_slice(&key_bytes).map_err(|error| anyhow!("bad --key: {error}"))?;
    let uncompressed = signing_key.verifying_key().to_encoded_point(false);
    let owner = Address::from_slice(&keccak256(&uncompressed.as_bytes()[1..])[12..]);
    let eas_domain = parse_b256(&args.eas_domain_separator)?;
    let head_domain = parse_b256(&args.head_domain_separator)?;
    let schema = parse_b256(&args.schema)?;
    let previous_head = parse_b256(&args.previous_head)?;

    let mut entries = Vec::new();
    let mut attestations = Vec::new();
    let mut uids = Vec::new();
    for (index, spec) in args.attest.iter().enumerate() {
        let parts = spec.split(':').collect::<Vec<_>>();
        if !(2..=3).contains(&parts.len()) {
            bail!("--attest must be 0x<recipient>:<confidence>[:<time>], got {spec}");
        }
        let recipient: Address = parts[0].parse().context("bad recipient")?;
        let confidence: u64 = parts[1].parse().context("bad confidence")?;
        let time = if parts.len() == 3 { parts[2].parse()? } else { 1000 + index as u64 };

        // Canonical abi.encode(string(""), confidence): offset=64, confidence, length=0.
        let mut data = vec![0u8; 96];
        data[31] = 64;
        data[32..64].copy_from_slice(&U256::from(confidence).to_be_bytes::<32>());
        let mut salt = [0u8; 32];
        salt[24..].copy_from_slice(&(index as u64 + 1).to_be_bytes());
        let mut attestation = OffchainAttestation {
            version: 2,
            schema,
            recipient,
            time,
            expiration_time: 0,
            revocable: true,
            ref_uid: B256::ZERO,
            data,
            salt: B256::from(salt),
            signature: Vec::new(),
        };
        attestation.signature = sign_canonical(
            &signing_key,
            &eip712_digest(eas_domain, attest_struct_hash(&attestation)),
        )?;
        let uid = offchain_uid_v2(&attestation);
        entries.push(LogEntry { kind: ENTRY_ATTEST, uid });
        attestations.push(attestation);
        uids.push(uid);
    }
    for index in args.revoke {
        let uid = *uids.get(index).ok_or_else(|| anyhow!("--revoke {index} out of range"))?;
        entries.push(LogEntry { kind: ENTRY_REVOKE, uid });
    }

    let payload = payload_v1::PayloadV1 { owner, entries, attestations };
    let bytes = payload_v1::encode(&payload)
        .map_err(|error| anyhow!("{}: payload encoding failed", error.code()))?;
    let node_id = address_node_id(owner);
    let head = log_head(&payload.entries);
    let data_commitment = payload_v1::data_commitment(&bytes);
    let message = payload_v1::AnchorMessage {
        node_id,
        envelope_kind: 0,
        schema_uid: schema,
        previous_head,
        head,
        count: payload.entries.len() as u64,
        data_commitment,
    };
    let head_signature = sign_canonical(
        &signing_key,
        &eip712_digest(head_domain, payload_v1::anchor_struct_hash(&message)),
    )?;

    std::fs::write(&args.out, &bytes)?;
    println!("owner:          0x{}", hex::encode(owner));
    println!("nodeId:         0x{}", hex::encode(node_id));
    println!("previousHead:   0x{}", hex::encode(previous_head));
    println!("head:           0x{}", hex::encode(head));
    println!("count:          {}", payload.entries.len());
    println!("dataCommitment: 0x{}", hex::encode(data_commitment));
    println!("cid:             {}", payload_v1::cid(&bytes));
    println!("headSignature:   0x{}", hex::encode(head_signature));
    println!("wrote {} canonical bytes to {}", bytes.len(), args.out);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn debug_signatures_use_the_canonical_wire_recovery_ids() {
        let signing_key = SigningKey::from_slice(&[0x42; 32]).unwrap();
        let signature = sign_canonical(&signing_key, &B256::from([7; 32])).unwrap();
        assert_eq!(signature.len(), 65);
        assert!(matches!(signature[64], 27 | 28));
        payload_v1::canonical_signature(&signature).unwrap();
    }
}
