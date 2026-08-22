//! Envelope 0 — the strict EAS off-chain v2 append-only log.
//!
//! The production wire protocol, bounded decoder, typed head authorization, and verifier live in
//! [`payload_v1`]. This parent module contains only the shared canonical primitives used by that
//! codec and by fixture/debug tooling. The earlier JSON witness, portable EIP-191 head, live-set
//! pruning, expiration, and Rule-Φ verifier were removed when M1 switched consensus ingestion.

use alloy_primitives::{keccak256, Address, B256, U256};
use serde::{Deserialize, Serialize};
use zk_core::fold::fold;
use zk_core::words::{word_addr, word_u256, word_u64, word_u8};

pub mod ecdsa;
pub mod payload_v1;

/// The EIP-712 `Attest` type hash for EAS off-chain v2, locked to the official SDK corpus.
pub fn attest_typehash() -> B256 {
    keccak256(
        b"Attest(uint16 version,bytes32 schema,address recipient,uint64 time,uint64 expirationTime,bool revocable,bytes32 refUID,bytes data,bytes32 salt)",
    )
}

/// One ordered log entry. `kind`: 0 = attest, 1 = revoke.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct LogEntry {
    pub kind: u8,
    pub uid: B256,
}

pub const ENTRY_ATTEST: u8 = 0;
pub const ENTRY_REVOKE: u8 = 1;

/// One complete supported EAS off-chain v2 attestation record.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct OffchainAttestation {
    pub version: u16,
    pub schema: B256,
    pub recipient: Address,
    pub time: u64,
    pub expiration_time: u64,
    pub revocable: bool,
    pub ref_uid: B256,
    #[serde(with = "serde_bytes_hex")]
    pub data: Vec<u8>,
    pub salt: B256,
    #[serde(with = "serde_bytes_hex")]
    pub signature: Vec<u8>,
}

/// `keccak256(abi.encode(uint8 kind, bytes32 uid))`.
pub fn entry_leaf(kind: u8, uid: B256) -> B256 {
    let mut encoded = Vec::with_capacity(64);
    encoded.extend_from_slice(&word_u8(kind));
    encoded.extend_from_slice(uid.as_slice());
    keccak256(encoded)
}

/// `h_i = keccak256(abi.encode(h_(i-1), entryLeaf_i))`, starting from zero.
pub fn log_head(entries: &[LogEntry]) -> B256 {
    let mut head = B256::ZERO;
    for entry in entries {
        head = fold(head, entry_leaf(entry.kind, entry.uid));
    }
    head
}

/// EIP-712 struct hash of the supported EAS off-chain v2 `Attest` message.
pub fn attest_struct_hash(attestation: &OffchainAttestation) -> B256 {
    let mut encoded = Vec::with_capacity(32 * 10);
    encoded.extend_from_slice(attest_typehash().as_slice());
    encoded.extend_from_slice(&word_u256(U256::from(attestation.version)));
    encoded.extend_from_slice(attestation.schema.as_slice());
    encoded.extend_from_slice(&word_addr(attestation.recipient));
    encoded.extend_from_slice(&word_u64(attestation.time));
    encoded.extend_from_slice(&word_u64(attestation.expiration_time));
    encoded.extend_from_slice(&word_u8(u8::from(attestation.revocable)));
    encoded.extend_from_slice(attestation.ref_uid.as_slice());
    encoded.extend_from_slice(keccak256(&attestation.data).as_slice());
    encoded.extend_from_slice(attestation.salt.as_slice());
    keccak256(encoded)
}

/// `keccak256(0x1901 || domainSeparator || structHash)`.
pub fn eip712_digest(domain_separator: B256, struct_hash: B256) -> B256 {
    let mut encoded = Vec::with_capacity(66);
    encoded.extend_from_slice(&[0x19, 0x01]);
    encoded.extend_from_slice(domain_separator.as_slice());
    encoded.extend_from_slice(struct_hash.as_slice());
    keccak256(encoded)
}

/// Reproduce the official SDK's off-chain v2 UID. The schema is intentionally encoded as the
/// 66 UTF-8 bytes of its lowercase `0x` hexadecimal string, not as 32 raw bytes.
pub fn offchain_uid_v2(attestation: &OffchainAttestation) -> B256 {
    let mut encoded =
        Vec::with_capacity(2 + 66 + 20 + 20 + 8 + 8 + 1 + 32 + attestation.data.len() + 32 + 4);
    encoded.extend_from_slice(&attestation.version.to_be_bytes());
    encoded.extend_from_slice(b"0x");
    encoded
        .extend_from_slice(alloy_primitives::hex::encode(attestation.schema.as_slice()).as_bytes());
    encoded.extend_from_slice(attestation.recipient.as_slice());
    encoded.extend_from_slice(Address::ZERO.as_slice());
    encoded.extend_from_slice(&attestation.time.to_be_bytes());
    encoded.extend_from_slice(&attestation.expiration_time.to_be_bytes());
    encoded.push(u8::from(attestation.revocable));
    encoded.extend_from_slice(attestation.ref_uid.as_slice());
    encoded.extend_from_slice(&attestation.data);
    encoded.extend_from_slice(attestation.salt.as_slice());
    encoded.extend_from_slice(&0u32.to_be_bytes());
    keccak256(encoded)
}

/// Canonical address node id: `keccak256(abi.encode(owner))`.
pub fn address_node_id(owner: Address) -> B256 {
    keccak256(word_addr(owner))
}

mod serde_bytes_hex {
    use serde::{Deserialize, Deserializer, Serializer};

    pub fn serialize<S: Serializer>(bytes: &[u8], serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&format!("0x{}", alloy_primitives::hex::encode(bytes)))
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Vec<u8>, D::Error> {
        let value = String::deserialize(deserializer)?;
        alloy_primitives::hex::decode(value.strip_prefix("0x").unwrap_or(&value))
            .map_err(serde::de::Error::custom)
    }
}
