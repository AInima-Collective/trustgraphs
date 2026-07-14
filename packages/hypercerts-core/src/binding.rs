//! `app.certified.link.evm` — DID ↔ EVM binding, verified in-guest (HYPERCERTS plan §4).
//!
//! EIP-712 derivation pinned at M1 by three-way agreement (viem / Rust / cast; the domain
//! lives in the lexicon's TESTS, not the schema): domain `EIP712Domain(string name,string
//! version,uint256 chainId)` with name "IdentityLink", version "1", NO verifyingContract,
//! NO salt; struct `LinkAttestation(string did,address evmAddress,uint256 chainId,uint256
//! timestamp,uint256 nonce)`; digest = keccak256(0x1901 ‖ domainSeparator ‖ structHash).
//! Verification recovers the signer and requires it to equal both the message's
//! `evmAddress` and the record's top-level `address` — plus the record living in the DID's
//! own signed repo supplies the DID-side consent (model C, both directions).

use crate::records::LinkEvmMessage;
use alloy_primitives::{keccak256, Address, B256, U256};
use envelopes::ecdsa::recover_address;

fn domain_separator(chain_id: U256) -> B256 {
    let typehash = keccak256(b"EIP712Domain(string name,string version,uint256 chainId)");
    let mut buf = Vec::with_capacity(32 * 4);
    buf.extend_from_slice(typehash.as_slice());
    buf.extend_from_slice(keccak256(b"IdentityLink").as_slice());
    buf.extend_from_slice(keccak256(b"1").as_slice());
    buf.extend_from_slice(&chain_id.to_be_bytes::<32>());
    keccak256(&buf)
}

fn struct_hash(
    m: &LinkEvmMessage,
    evm_address: Address,
    chain_id: U256,
    timestamp: U256,
    nonce: U256,
) -> B256 {
    let typehash = keccak256(
        b"LinkAttestation(string did,address evmAddress,uint256 chainId,uint256 timestamp,uint256 nonce)",
    );
    let mut buf = Vec::with_capacity(32 * 6);
    buf.extend_from_slice(typehash.as_slice());
    buf.extend_from_slice(keccak256(m.did.as_bytes()).as_slice());
    buf.extend_from_slice(&zk_core::words::word_addr(evm_address));
    buf.extend_from_slice(&chain_id.to_be_bytes::<32>());
    buf.extend_from_slice(&timestamp.to_be_bytes::<32>());
    buf.extend_from_slice(&nonce.to_be_bytes::<32>());
    keccak256(&buf)
}

/// Verify a link.evm record for `did`. Returns the bound EVM address, or `None`
/// (deterministic skip — the DID stays a satellite node).
pub fn verify_binding(
    did: &str,
    address_field: &str,
    m: &LinkEvmMessage,
    signature_hex: &str,
) -> Option<Address> {
    // The message must name the DID whose repo carries it (DID-side consent).
    if m.did != did {
        return None;
    }
    let evm_address: Address = m.evm_address.parse().ok()?;
    let top_address: Address = address_field.parse().ok()?;
    if evm_address != top_address {
        return None;
    }
    // The numeric fields are decimal strings.
    let chain_id = U256::from_str_radix(&m.chain_id, 10).ok()?;
    let timestamp = U256::from_str_radix(&m.timestamp, 10).ok()?;
    let nonce = U256::from_str_radix(&m.nonce, 10).ok()?;

    let sh = struct_hash(m, evm_address, chain_id, timestamp, nonce);
    let ds = domain_separator(chain_id);
    let mut digest_input = Vec::with_capacity(2 + 64);
    digest_input.extend_from_slice(&[0x19, 0x01]);
    digest_input.extend_from_slice(ds.as_slice());
    digest_input.extend_from_slice(sh.as_slice());
    let digest = keccak256(&digest_input);

    let sig = alloy_primitives::hex::decode(signature_hex.strip_prefix("0x")?).ok()?;
    let recovered = recover_address(&digest, &sig).ok()?;
    (recovered == evm_address).then_some(evm_address)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::records::{decode, Record};
    use envelopes::atproto::carset::Car;

    /// The fixture's link.evm record carries a REAL viem signature (three-way pinned at M1)
    /// — recovering it through this implementation locks the digest derivation.
    #[test]
    fn fixture_binding_recovers() {
        let root = concat!(env!("CARGO_MANIFEST_DIR"), "/../..");
        let car = std::fs::read(format!("{root}/spike/hypercerts-fixture/fixtures/hypercerts.car"))
            .unwrap();
        let parsed = Car::parse(&car).unwrap();
        let tsv = std::fs::read_to_string(format!(
            "{root}/spike/hypercerts-fixture/fixtures/hypercerts.records.tsv"
        ))
        .unwrap();
        let line = tsv.lines().find(|l| l.starts_with("app.certified.link.evm/")).unwrap();
        let cid: ipld_core::cid::Cid = line.split_once('\t').unwrap().1.parse().unwrap();
        let Some(Record::LinkEvm { address, message, signature, .. }) =
            decode("app.certified.link.evm", parsed.get(&cid).unwrap())
        else {
            panic!("link.evm must decode")
        };
        let bound =
            verify_binding("did:plc:ss2ib2f37vegrihrkrfkrw55", &address, &message, &signature)
                .expect("binding must verify");
        assert_eq!(bound, "0xD030e52949a1D6BC7D00a2040268410eE3AFd65A".parse::<Address>().unwrap());

        // wrong DID (consent direction) rejected
        assert!(verify_binding("did:plc:attacker", &address, &message, &signature).is_none());
        // tampered signature rejected (flip a byte of r — flipping only v can map to the
        // same recovery id, e.g. 27 -> 0)
        let mut bad = signature.clone();
        let orig = &bad[2..4].to_string();
        bad.replace_range(2..4, if orig == "00" { "01" } else { "00" });
        assert!(
            verify_binding("did:plc:ss2ib2f37vegrihrkrfkrw55", &address, &message, &bad).is_none()
        );
    }
}
