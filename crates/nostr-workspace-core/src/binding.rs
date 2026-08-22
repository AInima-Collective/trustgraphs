//! Kind-36383 mutual Nostr/EVM binding.

use alloy_primitives::{keccak256, Address, B256, U256};
use envelopes::ecdsa::recover_address;
use nostr_envelope::nostr::event::{lowercase_hex, NostrEvent};
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BindingContent {
    pub address: String,
    pub chain_id: String,
    pub timestamp: String,
    pub nonce: String,
    pub signature: String,
}

fn canonical_decimal(value: &str) -> Option<U256> {
    if value.is_empty()
        || (value.len() > 1 && value.starts_with('0'))
        || !value.bytes().all(|byte| byte.is_ascii_digit())
    {
        return None;
    }
    U256::from_str_radix(value, 10).ok()
}

fn canonical_address(value: &str) -> Option<Address> {
    let body = value.strip_prefix("0x")?;
    if body.len() != 40
        || !body.bytes().all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return None;
    }
    value.parse().ok()
}

fn domain_separator(chain_id: U256) -> B256 {
    let mut words = Vec::with_capacity(32 * 4);
    words.extend_from_slice(
        keccak256(b"EIP712Domain(string name,string version,uint256 chainId)").as_slice(),
    );
    words.extend_from_slice(keccak256(b"IdentityLink").as_slice());
    words.extend_from_slice(keccak256(b"1").as_slice());
    words.extend_from_slice(&chain_id.to_be_bytes::<32>());
    keccak256(words)
}

pub fn binding_digest(
    did: &str,
    address: Address,
    chain_id: U256,
    timestamp: U256,
    nonce: U256,
) -> B256 {
    let mut words = Vec::with_capacity(32 * 6);
    words.extend_from_slice(
        keccak256(
            b"LinkAttestation(string did,address evmAddress,uint256 chainId,uint256 timestamp,uint256 nonce)",
        )
        .as_slice(),
    );
    words.extend_from_slice(keccak256(did.as_bytes()).as_slice());
    words.extend_from_slice(&zk_core::words::word_addr(address));
    words.extend_from_slice(&chain_id.to_be_bytes::<32>());
    words.extend_from_slice(&timestamp.to_be_bytes::<32>());
    words.extend_from_slice(&nonce.to_be_bytes::<32>());
    let struct_hash = keccak256(words);

    let mut input = Vec::with_capacity(66);
    input.extend_from_slice(&[0x19, 0x01]);
    input.extend_from_slice(domain_separator(chain_id).as_slice());
    input.extend_from_slice(struct_hash.as_slice());
    keccak256(input)
}

pub fn verify(event: &NostrEvent, expected_chain_id: u64) -> Option<Address> {
    if event.kind != 36_383 || event.tags.len() != 1 {
        return None;
    }
    let tag = &event.tags[0];
    if tag.len() != 2 || tag[0] != "d" {
        return None;
    }
    let content: BindingContent = serde_json::from_str(&event.content).ok()?;
    if serde_json::to_string(&content).ok()? != event.content || tag[1] != content.address {
        return None;
    }
    let address = canonical_address(&content.address)?;
    let chain_id = canonical_decimal(&content.chain_id)?;
    if chain_id != U256::from(expected_chain_id) {
        return None;
    }
    let timestamp = canonical_decimal(&content.timestamp)?;
    let nonce = canonical_decimal(&content.nonce)?;
    let signature = content.signature.strip_prefix("0x")?;
    if signature.len() != 130
        || !signature.bytes().all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return None;
    }
    let signature = alloy_primitives::hex::decode(signature).ok()?;
    let did = format!("did:nostr:{}", lowercase_hex(&event.pubkey));
    let digest = binding_digest(&did, address, chain_id, timestamp, nonce);
    (recover_address(&digest, &signature).ok()? == address).then_some(address)
}
