//! `Envelope0PayloadV1`, frozen in `research/EAS_OFFCHAIN_SUPPORT.md`.
//!
//! This module is the bounded binary codec and cryptographic reference used by host and the
//! dedicated strict Trustgraphs guest. Consensus ingestion accepts these exact bytes; JSON is only
//! a transport/debug representation of the outer witness.

use super::{
    address_node_id, eip712_digest, entry_leaf, log_head, offchain_uid_v2, LogEntry,
    OffchainAttestation, ENTRY_ATTEST, ENTRY_REVOKE,
};
use crate::ecdsa::recover_address;
use alloy_primitives::{keccak256, Address, B256, U256};
use k256::ecdsa::Signature;
use sha2::{Digest, Sha256};
use std::collections::BTreeSet;
use zk_core::cid::cid_v1_raw;
use zk_core::words::{word_addr, word_u256, word_u64, word_u8};

pub const MAGIC: &[u8; 8] = b"TGEAS0PL";
pub const PAYLOAD_VERSION: u16 = 1;
pub const HEADER_BYTES: usize = 38;
pub const ATTESTATION_FIXED_BYTES: usize = 204;
pub const MAX_PAYLOAD_BYTES: usize = 1_048_576;
pub const MAX_ENTRIES_PER_NODE: usize = 2_048;
pub const MAX_COMMENT_BYTES: usize = 4_096;
pub const MIN_DATA_BYTES: usize = 96;
pub const MAX_DATA_BYTES: usize = 4_192;
pub const E0_ENTRY_WORK_UNITS: u64 = 4;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PayloadV1 {
    pub owner: Address,
    pub entries: Vec<LogEntry>,
    pub attestations: Vec<OffchainAttestation>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PayloadError {
    Magic,
    PayloadVersion,
    Truncated,
    TrailingBytes,
    PayloadLimit,
    EntryLimit,
    DataLimit,
    CountMismatch,
    LogKind,
    DuplicateAttest,
    RevokeBeforeAttest,
    AlreadyRevoked,
    ProfileVersion,
    Schema,
    Recipient,
    FutureTime,
    Expiration,
    Revocable,
    RefUid,
    ZeroSalt,
    DataAbi,
    Uid,
    SignatureForm,
    EasSignature,
    Commitment,
    NodeId,
    Head,
    PreviousHead,
    HeadSignature,
}

impl PayloadError {
    pub const fn code(self) -> &'static str {
        match self {
            Self::Magic => "E0_MAGIC",
            Self::PayloadVersion => "E0_PAYLOAD_VERSION",
            Self::Truncated => "E0_TRUNCATED",
            Self::TrailingBytes => "E0_TRAILING_BYTES",
            Self::PayloadLimit => "E0_PAYLOAD_LIMIT",
            Self::EntryLimit => "E0_ENTRY_LIMIT",
            Self::DataLimit => "E0_DATA_LIMIT",
            Self::CountMismatch => "E0_COUNT_MISMATCH",
            Self::LogKind => "E0_LOG_KIND",
            Self::DuplicateAttest => "E0_DUPLICATE_ATTEST",
            Self::RevokeBeforeAttest => "E0_REVOKE_BEFORE_ATTEST",
            Self::AlreadyRevoked => "E0_ALREADY_REVOKED",
            Self::ProfileVersion => "E0_PROFILE_VERSION",
            Self::Schema => "E0_SCHEMA",
            Self::Recipient => "E0_RECIPIENT",
            Self::FutureTime => "E0_FUTURE_TIME",
            Self::Expiration => "E0_EXPIRATION",
            Self::Revocable => "E0_REVOCABLE",
            Self::RefUid => "E0_REF_UID",
            Self::ZeroSalt => "E0_ZERO_SALT",
            Self::DataAbi => "E0_DATA_ABI",
            Self::Uid => "E0_UID",
            Self::SignatureForm => "E0_SIGNATURE_FORM",
            Self::EasSignature => "E0_EAS_SIGNATURE",
            Self::Commitment => "E0_COMMITMENT",
            Self::NodeId => "E0_NODE_ID",
            Self::Head => "E0_HEAD",
            Self::PreviousHead => "E0_PREVIOUS_HEAD",
            Self::HeadSignature => "E0_HEAD_SIGNATURE",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct AnchorMessage {
    pub node_id: B256,
    pub envelope_kind: u8,
    pub schema_uid: B256,
    pub previous_head: B256,
    pub head: B256,
    pub count: u64,
    pub data_commitment: B256,
}

#[derive(Clone, Copy, Debug)]
pub struct VerificationContext<'a> {
    pub expected_schema: B256,
    pub eas_domain_separator: B256,
    /// The exact `Trustgraphs Offchain Head` v2 domain separator. The factory derives it from
    /// `(chainId, EasOffchainAnchorRegistry)` and pins it beside the EAS separator in params.
    pub head_domain_separator: B256,
    pub anchor: AnchorMessage,
    pub anchor_timestamp: u64,
    pub head_signature: &'a [u8],
}

struct Decoder<'a> {
    bytes: &'a [u8],
    offset: usize,
}

impl<'a> Decoder<'a> {
    fn new(bytes: &'a [u8]) -> Self {
        Self { bytes, offset: 0 }
    }

    fn take(&mut self, len: usize) -> Result<&'a [u8], PayloadError> {
        let end = self.offset.checked_add(len).ok_or(PayloadError::Truncated)?;
        let out = self.bytes.get(self.offset..end).ok_or(PayloadError::Truncated)?;
        self.offset = end;
        Ok(out)
    }

    fn u8(&mut self) -> Result<u8, PayloadError> {
        Ok(self.take(1)?[0])
    }

    fn u16(&mut self) -> Result<u16, PayloadError> {
        Ok(u16::from_be_bytes(self.take(2)?.try_into().unwrap()))
    }

    fn u32(&mut self) -> Result<u32, PayloadError> {
        Ok(u32::from_be_bytes(self.take(4)?.try_into().unwrap()))
    }

    fn u64(&mut self) -> Result<u64, PayloadError> {
        Ok(u64::from_be_bytes(self.take(8)?.try_into().unwrap()))
    }

    fn b256(&mut self) -> Result<B256, PayloadError> {
        Ok(B256::from_slice(self.take(32)?))
    }

    fn address(&mut self) -> Result<Address, PayloadError> {
        Ok(Address::from_slice(self.take(20)?))
    }
}

fn push_uint(out: &mut Vec<u8>, value: u64, width: usize) {
    let bytes = value.to_be_bytes();
    out.extend_from_slice(&bytes[8 - width..]);
}

pub fn canonical_signature(signature: &[u8]) -> Result<(), PayloadError> {
    if signature.len() != 65 || !matches!(signature[64], 27 | 28) {
        return Err(PayloadError::SignatureForm);
    }
    let parsed =
        Signature::from_slice(&signature[..64]).map_err(|_| PayloadError::SignatureForm)?;
    if parsed.normalize_s().is_some() {
        return Err(PayloadError::SignatureForm);
    }
    Ok(())
}

fn canonical_data(data: &[u8]) -> Result<(), PayloadError> {
    if !(MIN_DATA_BYTES..=MAX_DATA_BYTES).contains(&data.len()) {
        return Err(PayloadError::DataLimit);
    }
    if data.len() % 32 != 0 {
        return Err(PayloadError::DataAbi);
    }
    let mut offset_word = [0u8; 32];
    offset_word[31] = 64;
    if data[..32] != offset_word {
        return Err(PayloadError::DataAbi);
    }
    let length = U256::from_be_slice(&data[64..96]);
    if length > U256::from(MAX_COMMENT_BYTES) {
        return Err(PayloadError::DataLimit);
    }
    let length = length.to::<usize>();
    let padded = length.checked_add(31).ok_or(PayloadError::DataAbi)? / 32 * 32;
    let expected = MIN_DATA_BYTES.checked_add(padded).ok_or(PayloadError::DataAbi)?;
    if data.len() != expected {
        return Err(PayloadError::DataAbi);
    }
    if data[MIN_DATA_BYTES + length..].iter().any(|b| *b != 0) {
        return Err(PayloadError::DataAbi);
    }
    Ok(())
}

pub fn decode(bytes: &[u8], expected_schema: B256) -> Result<PayloadV1, PayloadError> {
    if bytes.len() > MAX_PAYLOAD_BYTES {
        return Err(PayloadError::PayloadLimit);
    }
    let mut decoder = Decoder::new(bytes);
    if decoder.take(MAGIC.len())? != MAGIC {
        return Err(PayloadError::Magic);
    }
    if decoder.u16()? != PAYLOAD_VERSION {
        return Err(PayloadError::PayloadVersion);
    }
    let owner = decoder.address()?;
    let entry_count = decoder.u32()? as usize;
    let attestation_count = decoder.u32()? as usize;
    if entry_count == 0 || entry_count > MAX_ENTRIES_PER_NODE {
        return Err(PayloadError::EntryLimit);
    }
    if attestation_count > entry_count {
        return Err(PayloadError::CountMismatch);
    }

    let remaining = bytes.len().saturating_sub(decoder.offset);
    let log_bytes = entry_count.checked_mul(33).ok_or(PayloadError::EntryLimit)?;
    let fixed_attestation_bytes =
        attestation_count.checked_mul(ATTESTATION_FIXED_BYTES).ok_or(PayloadError::PayloadLimit)?;
    if log_bytes.checked_add(fixed_attestation_bytes).ok_or(PayloadError::PayloadLimit)? > remaining
    {
        return Err(PayloadError::Truncated);
    }

    let mut entries = Vec::with_capacity(entry_count);
    for _ in 0..entry_count {
        entries.push(LogEntry { kind: decoder.u8()?, uid: decoder.b256()? });
    }

    let mut attestations = Vec::with_capacity(attestation_count);
    for _ in 0..attestation_count {
        let version = decoder.u16()?;
        if version != 2 {
            return Err(PayloadError::ProfileVersion);
        }
        let schema = decoder.b256()?;
        if schema != expected_schema {
            return Err(PayloadError::Schema);
        }
        let recipient = decoder.address()?;
        if recipient.is_zero() {
            return Err(PayloadError::Recipient);
        }
        let time = decoder.u64()?;
        let expiration_time = decoder.u64()?;
        if expiration_time != 0 {
            return Err(PayloadError::Expiration);
        }
        let revocable_byte = decoder.u8()?;
        if revocable_byte != 1 {
            return Err(PayloadError::Revocable);
        }
        let ref_uid = decoder.b256()?;
        if !ref_uid.is_zero() {
            return Err(PayloadError::RefUid);
        }
        let data_len = decoder.u32()? as usize;
        if !(MIN_DATA_BYTES..=MAX_DATA_BYTES).contains(&data_len) {
            return Err(PayloadError::DataLimit);
        }
        let data = decoder.take(data_len)?.to_vec();
        canonical_data(&data)?;
        let salt = decoder.b256()?;
        if salt.is_zero() {
            return Err(PayloadError::ZeroSalt);
        }
        let signature = decoder.take(65)?.to_vec();
        canonical_signature(&signature)?;
        attestations.push(OffchainAttestation {
            version,
            schema,
            recipient,
            time,
            expiration_time,
            revocable: true,
            ref_uid,
            data,
            salt,
            signature,
        });
    }
    if decoder.offset != bytes.len() {
        return Err(PayloadError::TrailingBytes);
    }

    let mut attestation_iter = attestations.iter();
    let mut seen = BTreeSet::new();
    let mut live = BTreeSet::new();
    let mut observed_attestations = 0usize;
    for entry in &entries {
        match entry.kind {
            ENTRY_ATTEST => {
                observed_attestations += 1;
                let attestation = attestation_iter.next().ok_or(PayloadError::CountMismatch)?;
                if !seen.insert(entry.uid) {
                    return Err(PayloadError::DuplicateAttest);
                }
                if offchain_uid_v2(attestation) != entry.uid {
                    return Err(PayloadError::Uid);
                }
                live.insert(entry.uid);
            }
            ENTRY_REVOKE => {
                if !seen.contains(&entry.uid) {
                    return Err(PayloadError::RevokeBeforeAttest);
                }
                if !live.remove(&entry.uid) {
                    return Err(PayloadError::AlreadyRevoked);
                }
            }
            _ => return Err(PayloadError::LogKind),
        }
    }
    if observed_attestations != attestation_count || attestation_iter.next().is_some() {
        return Err(PayloadError::CountMismatch);
    }
    Ok(PayloadV1 { owner, entries, attestations })
}

pub fn encode(payload: &PayloadV1) -> Result<Vec<u8>, PayloadError> {
    if payload.entries.is_empty() || payload.entries.len() > MAX_ENTRIES_PER_NODE {
        return Err(PayloadError::EntryLimit);
    }
    let mut out = Vec::with_capacity(HEADER_BYTES + payload.entries.len() * 33);
    out.extend_from_slice(MAGIC);
    out.extend_from_slice(&PAYLOAD_VERSION.to_be_bytes());
    out.extend_from_slice(payload.owner.as_slice());
    push_uint(&mut out, payload.entries.len() as u64, 4);
    push_uint(&mut out, payload.attestations.len() as u64, 4);
    for entry in &payload.entries {
        out.push(entry.kind);
        out.extend_from_slice(entry.uid.as_slice());
    }
    for attestation in &payload.attestations {
        out.extend_from_slice(&attestation.version.to_be_bytes());
        out.extend_from_slice(attestation.schema.as_slice());
        out.extend_from_slice(attestation.recipient.as_slice());
        out.extend_from_slice(&attestation.time.to_be_bytes());
        out.extend_from_slice(&attestation.expiration_time.to_be_bytes());
        out.push(u8::from(attestation.revocable));
        out.extend_from_slice(attestation.ref_uid.as_slice());
        push_uint(&mut out, attestation.data.len() as u64, 4);
        out.extend_from_slice(&attestation.data);
        out.extend_from_slice(attestation.salt.as_slice());
        out.extend_from_slice(&attestation.signature);
    }
    if out.len() > MAX_PAYLOAD_BYTES {
        return Err(PayloadError::PayloadLimit);
    }
    // Encoding is only canonical if the fully encoded value passes the same bounded decoder.
    let decoded = decode(&out, payload.attestations.first().map(|a| a.schema).unwrap_or_default())?;
    if &decoded != payload {
        return Err(PayloadError::CountMismatch);
    }
    Ok(out)
}

pub fn data_commitment(bytes: &[u8]) -> B256 {
    let digest = Sha256::digest(bytes);
    B256::from_slice(&digest)
}

pub fn cid(bytes: &[u8]) -> String {
    let digest: [u8; 32] = data_commitment(bytes).into();
    cid_v1_raw(&digest)
}

pub fn eip712_domain_separator(
    name: &str,
    version: &str,
    chain_id: u64,
    verifying_contract: Address,
) -> B256 {
    let typehash = keccak256(
        b"EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)",
    );
    let mut encoded = Vec::with_capacity(160);
    encoded.extend_from_slice(typehash.as_slice());
    encoded.extend_from_slice(keccak256(name.as_bytes()).as_slice());
    encoded.extend_from_slice(keccak256(version.as_bytes()).as_slice());
    encoded.extend_from_slice(&word_u256(U256::from(chain_id)));
    encoded.extend_from_slice(&word_addr(verifying_contract));
    keccak256(encoded)
}

pub fn anchor_typehash() -> B256 {
    keccak256(
        b"Anchor(bytes32 nodeId,uint8 envelopeKind,bytes32 schemaUid,bytes32 previousHead,bytes32 head,uint64 count,bytes32 dataCommitment)",
    )
}

pub fn anchor_struct_hash(message: &AnchorMessage) -> B256 {
    let mut encoded = Vec::with_capacity(8 * 32);
    encoded.extend_from_slice(anchor_typehash().as_slice());
    encoded.extend_from_slice(message.node_id.as_slice());
    encoded.extend_from_slice(&word_u8(message.envelope_kind));
    encoded.extend_from_slice(message.schema_uid.as_slice());
    encoded.extend_from_slice(message.previous_head.as_slice());
    encoded.extend_from_slice(message.head.as_slice());
    encoded.extend_from_slice(&word_u64(message.count));
    encoded.extend_from_slice(message.data_commitment.as_slice());
    keccak256(encoded)
}

pub fn anchor_digest(chain_id: u64, registry: Address, message: &AnchorMessage) -> B256 {
    let domain = eip712_domain_separator("Trustgraphs Offchain Head", "2", chain_id, registry);
    eip712_digest(domain, anchor_struct_hash(message))
}

/// Verify a canonical typed head authorization against an already-pinned domain separator.
/// Returning the signer lets the caller bind the authorization to the address-derived node id
/// without trusting an owner field supplied by the witness.
pub fn verify_anchor_authorization(
    head_domain_separator: B256,
    message: &AnchorMessage,
    signature: &[u8],
) -> Result<Address, PayloadError> {
    canonical_signature(signature)?;
    recover_address(&eip712_digest(head_domain_separator, anchor_struct_hash(message)), signature)
        .map_err(|_| PayloadError::HeadSignature)
}

pub fn verify(bytes: &[u8], context: &VerificationContext<'_>) -> Result<PayloadV1, PayloadError> {
    if data_commitment(bytes) != context.anchor.data_commitment {
        return Err(PayloadError::Commitment);
    }
    let payload = decode(bytes, context.expected_schema)?;
    if address_node_id(payload.owner) != context.anchor.node_id {
        return Err(PayloadError::NodeId);
    }
    if context.anchor.envelope_kind != 0 {
        return Err(PayloadError::Head);
    }
    if context.anchor.schema_uid != context.expected_schema {
        return Err(PayloadError::Schema);
    }
    if payload.entries.len() as u64 != context.anchor.count {
        return Err(PayloadError::CountMismatch);
    }
    if log_head(&payload.entries) != context.anchor.head {
        return Err(PayloadError::Head);
    }
    let signer = verify_anchor_authorization(
        context.head_domain_separator,
        &context.anchor,
        context.head_signature,
    )?;
    if signer != payload.owner {
        return Err(PayloadError::HeadSignature);
    }
    for attestation in &payload.attestations {
        if attestation.time > context.anchor_timestamp {
            return Err(PayloadError::FutureTime);
        }
        let digest =
            eip712_digest(context.eas_domain_separator, super::attest_struct_hash(attestation));
        let signer = recover_address(&digest, &attestation.signature)
            .map_err(|_| PayloadError::EasSignature)?;
        if signer != payload.owner {
            return Err(PayloadError::EasSignature);
        }
    }
    Ok(payload)
}

/// All prefix heads, in log order. Used to bind a newest payload to every earlier anchor.
pub fn prefix_heads(entries: &[LogEntry]) -> Vec<B256> {
    let mut out = Vec::with_capacity(entries.len());
    let mut head = B256::ZERO;
    for entry in entries {
        head = zk_core::fold::fold(head, entry_leaf(entry.kind, entry.uid));
        out.push(head);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;
    use std::path::PathBuf;

    fn fixture_dir() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../tests/fixtures/eas-offchain/v1")
    }

    fn manifest() -> Value {
        serde_json::from_slice(&std::fs::read(fixture_dir().join("manifest.json")).unwrap())
            .unwrap()
    }

    fn b256(value: &Value) -> B256 {
        value.as_str().unwrap().parse().unwrap()
    }

    fn address(value: &Value) -> Address {
        value.as_str().unwrap().parse().unwrap()
    }

    fn u64_string(value: &Value) -> u64 {
        value.as_str().unwrap().parse().unwrap()
    }

    fn signature(value: &Value) -> Vec<u8> {
        alloy_primitives::hex::decode(value.as_str().unwrap().trim_start_matches("0x")).unwrap()
    }

    fn context<'a>(
        manifest: &'a Value,
        index: usize,
        signature: &'a [u8],
    ) -> VerificationContext<'a> {
        let positive = &manifest["positive"];
        let anchor = &positive["anchorHistory"][index];
        let authorization = &anchor["authorization"];
        let message = &authorization["message"];
        VerificationContext {
            expected_schema: b256(&manifest["schemaUid"]),
            eas_domain_separator: b256(&manifest["easDomain"]["separator"]),
            head_domain_separator: b256(&manifest["headDomain"]["separator"]),
            anchor: AnchorMessage {
                node_id: b256(&message["nodeId"]),
                envelope_kind: message["envelopeKind"].as_u64().unwrap() as u8,
                schema_uid: b256(&message["schemaUid"]),
                previous_head: b256(&message["previousHead"]),
                head: b256(&message["head"]),
                count: u64_string(&message["count"]),
                data_commitment: b256(&message["dataCommitment"]),
            },
            anchor_timestamp: u64_string(&anchor["blockTimestamp"]),
            head_signature: signature,
        }
    }

    #[test]
    fn official_sdk_positive_fixture_matches_every_frozen_byte() {
        let manifest = manifest();
        let payload_bytes = std::fs::read(fixture_dir().join("payload.bin")).unwrap();
        assert_eq!(
            payload_bytes.len(),
            manifest["positive"]["payloadLength"].as_u64().unwrap() as usize
        );
        assert_eq!(data_commitment(&payload_bytes), b256(&manifest["positive"]["dataCommitment"]));
        assert_eq!(cid(&payload_bytes), manifest["positive"]["cid"].as_str().unwrap());

        let head_sig =
            signature(&manifest["positive"]["anchorHistory"][1]["authorization"]["signature"]);
        let context = context(&manifest, 1, &head_sig);
        assert_eq!(
            eip712_digest(context.head_domain_separator, anchor_struct_hash(&context.anchor),),
            b256(&manifest["positive"]["anchorHistory"][1]["authorization"]["typedDigest"])
        );
        let decoded = verify(&payload_bytes, &context).unwrap();
        assert_eq!(decoded.owner, address(&manifest["owner"]));
        assert_eq!(decoded.entries.len(), 3);
        assert_eq!(decoded.attestations.len(), 2);
        assert_eq!(encode(&decoded).unwrap(), payload_bytes);
        assert_eq!(
            prefix_heads(&decoded.entries),
            manifest["positive"]["prefixHeads"]
                .as_array()
                .unwrap()
                .iter()
                .map(b256)
                .collect::<Vec<_>>()
        );

        for (decoded_attestation, fixture_attestation) in decoded
            .attestations
            .iter()
            .zip(manifest["positive"]["attestations"].as_array().unwrap())
        {
            assert_eq!(offchain_uid_v2(decoded_attestation), b256(&fixture_attestation["uid"]));
            let digest = eip712_digest(
                b256(&fixture_attestation["domainSeparator"]),
                super::super::attest_struct_hash(decoded_attestation),
            );
            assert_eq!(digest, b256(&fixture_attestation["typedDigest"]));
        }
    }

    #[test]
    fn first_anchor_fixture_verifies_independently() {
        let manifest = manifest();
        let bytes = std::fs::read(fixture_dir().join("payload-count-1.bin")).unwrap();
        let head_sig =
            signature(&manifest["positive"]["anchorHistory"][0]["authorization"]["signature"]);
        let context = context(&manifest, 0, &head_sig);
        let decoded = verify(&bytes, &context).unwrap();
        assert_eq!(decoded.entries.len(), 1);
        assert_eq!(context.anchor.previous_head, B256::ZERO);
    }

    #[test]
    fn structural_negative_fixtures_fail_at_the_named_rule() {
        let manifest = manifest();
        let expected = [
            ("eas-v1", PayloadError::ProfileVersion),
            ("wrong-schema", PayloadError::Schema),
            ("nonzero-expiration", PayloadError::Expiration),
            ("nonzero-ref-uid", PayloadError::RefUid),
            ("zero-salt", PayloadError::ZeroSalt),
            ("high-s", PayloadError::SignatureForm),
            ("trailing-payload-byte", PayloadError::TrailingBytes),
        ];
        for (name, error) in expected {
            let fixture = manifest["negatives"]
                .as_array()
                .unwrap()
                .iter()
                .find(|entry| entry["name"] == name)
                .unwrap();
            let bytes = std::fs::read(fixture_dir().join(fixture["payloadFile"].as_str().unwrap()))
                .unwrap();
            assert_eq!(decode(&bytes, b256(&manifest["schemaUid"])), Err(error), "{name}");
            assert_eq!(error.code(), fixture["expectedReason"].as_str().unwrap(), "{name}");
        }
    }

    #[test]
    fn domain_time_commitment_and_head_negative_fixtures_fail_closed() {
        let manifest = manifest();
        for name in [
            "wrong-eas-address",
            "wrong-chain",
            "future-time",
            "bad-head-domain",
            "changed-data-commitment",
        ] {
            let fixture = manifest["negatives"]
                .as_array()
                .unwrap()
                .iter()
                .find(|entry| entry["name"] == name)
                .unwrap();
            let bytes = std::fs::read(fixture_dir().join(fixture["payloadFile"].as_str().unwrap()))
                .unwrap();
            let head_sig = signature(&fixture["authorization"]["signature"]);
            let authorization = &fixture["authorization"];
            let message = &authorization["message"];
            let context = VerificationContext {
                expected_schema: b256(&manifest["schemaUid"]),
                eas_domain_separator: b256(&manifest["easDomain"]["separator"]),
                head_domain_separator: b256(&manifest["headDomain"]["separator"]),
                anchor: AnchorMessage {
                    node_id: b256(&message["nodeId"]),
                    envelope_kind: 0,
                    schema_uid: b256(&message["schemaUid"]),
                    previous_head: b256(&message["previousHead"]),
                    head: b256(&message["head"]),
                    count: u64_string(&message["count"]),
                    data_commitment: b256(&message["dataCommitment"]),
                },
                anchor_timestamp: u64_string(&fixture["anchorTimestamp"]),
                head_signature: &head_sig,
            };
            let error = verify(&bytes, &context).unwrap_err();
            assert_eq!(error.code(), fixture["expectedReason"].as_str().unwrap(), "{name}");
        }
    }

    #[test]
    fn domain_separators_match_typescript_fixture() {
        let manifest = manifest();
        assert_eq!(
            eip712_domain_separator(
                "EAS Attestation",
                manifest["easDomain"]["version"].as_str().unwrap(),
                u64_string(&manifest["easDomain"]["chainId"]),
                address(&manifest["easDomain"]["verifyingContract"]),
            ),
            b256(&manifest["easDomain"]["separator"])
        );
        assert_eq!(
            eip712_domain_separator(
                "Trustgraphs Offchain Head",
                "2",
                u64_string(&manifest["headDomain"]["chainId"]),
                address(&manifest["headDomain"]["verifyingContract"]),
            ),
            b256(&manifest["headDomain"]["separator"])
        );
    }
}
