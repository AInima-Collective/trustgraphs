//! Envelope 0 — the EAS-offchain chained log (OFFCHAIN_ATTESTATIONS_ZK §4.2).
//!
//! An attester maintains an append-only log of their own EAS offchain-v2 attestations and
//! revocations, and signs the running head. The head is what gets anchored; this module
//! turns `(head, witness)` into the complete authenticated edge set, or fails.
//!
//! Log discipline (frozen; golden-locked):
//!   entryLeaf = keccak256(abi.encode(uint8 kind, bytes32 uid))     kind: 0 attest, 1 revoke
//!   h_i       = keccak256(abi.encode(h_{i-1}, entryLeaf_i))        h_0 = bytes32(0)
//!   headSig   = EIP-191(keccak256(abi.encode(HEAD_DOMAIN_TAG, head, uint64 count)))
//!
//! Revocation is IN-LOG: a revoke entry deletes a previously-attested UID, and completeness
//! of the deletion set is inherited from the signed head — the same way the atproto envelope
//! gets revocation by record absence. The on-chain `EAS.revokeOffchain` channel is
//! deliberately OUT of the proven statement in v1 (research/DEVIATIONS.md #3): binding it
//! soundly requires a storage-proof witness against a checkpointed block hash, or an
//! on-chain revocation-mirror accumulator — both deliberate future events, not silent
//! best-effort reads.
//!
//! Per-edge authorization: each attestation carries its own EAS offchain-v2 EIP-712
//! signature (`Attest` struct, salt included), verified in-guest with ecrecover; the
//! recovered address must equal the log owner, and the leaf/UID binds `(attester, uid)` —
//! the offchain UID alone does not bind the attester (dossier 02 §1.2).

use alloy_primitives::{keccak256, Address, B256, U256};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use zk_core::fold::fold;
use zk_core::words::{word_addr, word_u256, word_u64, word_u8};

use crate::ecdsa::{eip191_digest32, recover_address};
use crate::{AuthedEdge, EnvelopeError};

/// Frozen v1 domain tag for head signatures. The pre-rename bytes remain part of the protocol:
/// `keccak256("TRUSTGRAPH_ENVELOPE0_HEAD_V1")`.
pub fn head_domain_tag() -> B256 {
    keccak256(b"TRUSTGRAPH_ENVELOPE0_HEAD_V1")
}

/// The EIP-712 `Attest` type hash for EAS offchain v2 (verified byte-for-byte against
/// eas-sdk `OFFCHAIN_ATTESTATION_TYPES[Version2]`).
pub fn attest_typehash() -> B256 {
    keccak256(
        b"Attest(uint16 version,bytes32 schema,address recipient,uint64 time,uint64 expirationTime,bool revocable,bytes32 refUID,bytes data,bytes32 salt)"
    )
}

/// One log entry. `kind`: 0 = attest, 1 = revoke.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct LogEntry {
    pub kind: u8,
    pub uid: B256,
}

pub const ENTRY_ATTEST: u8 = 0;
pub const ENTRY_REVOKE: u8 = 1;

/// A full EAS offchain-v2 attestation + its EIP-712 signature (65 bytes, r‖s‖v).
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

/// The witness behind one anchored envelope-0 head.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Envelope0Witness {
    /// The log owner (the attester). `nodeId = keccak256(abi.encode(owner))`.
    pub owner: Address,
    /// The full log, in fold order.
    pub entries: Vec<LogEntry>,
    /// One attestation per ATTEST entry, in the same order as those entries appear.
    pub attestations: Vec<OffchainAttestation>,
    /// 65-byte signature over `EIP-191(keccak256(abi.encode(HEAD_DOMAIN_TAG, head, count)))`.
    #[serde(with = "serde_bytes_hex")]
    pub head_signature: Vec<u8>,
}

/// Pinned verification parameters (inside `paramsHash`, governance-tunable).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Envelope0Config {
    /// Accepted EIP-712 domain separators for `EAS Attestation` (computed host-side from the
    /// EAS deployment(s) + contract version strings, pinned here so the guest never trusts a
    /// witness-supplied domain).
    pub accepted_domain_separators: Vec<B256>,
    /// The attestation schema this graph consumes (same as lane 1).
    pub schema_uid: B256,
}

/// The chained-log entry leaf: `keccak256(abi.encode(uint8 kind, bytes32 uid))`.
pub fn entry_leaf(kind: u8, uid: B256) -> B256 {
    let mut buf = Vec::with_capacity(64);
    buf.extend_from_slice(&word_u8(kind));
    buf.extend_from_slice(uid.as_slice());
    keccak256(&buf)
}

/// Re-fold a log to its head: `h_i = fold(h_{i-1}, entry_leaf_i)`, `h_0 = 0`.
pub fn log_head(entries: &[LogEntry]) -> B256 {
    let mut h = B256::ZERO;
    for e in entries {
        h = fold(h, entry_leaf(e.kind, e.uid));
    }
    h
}

/// The head-signature payload: `keccak256(abi.encode(HEAD_DOMAIN_TAG, head, uint64 count))`.
pub fn head_payload(head: B256, count: u64) -> B256 {
    let mut buf = Vec::with_capacity(96);
    buf.extend_from_slice(head_domain_tag().as_slice());
    buf.extend_from_slice(head.as_slice());
    buf.extend_from_slice(&word_u64(count));
    keccak256(&buf)
}

/// The EIP-712 struct hash of an offchain-v2 attestation (dynamic `data` hashes first).
pub fn attest_struct_hash(a: &OffchainAttestation) -> B256 {
    let mut buf = Vec::with_capacity(32 * 10);
    buf.extend_from_slice(attest_typehash().as_slice());
    buf.extend_from_slice(&word_u256(U256::from(a.version)));
    buf.extend_from_slice(a.schema.as_slice());
    buf.extend_from_slice(&word_addr(a.recipient));
    buf.extend_from_slice(&word_u64(a.time));
    buf.extend_from_slice(&word_u64(a.expiration_time));
    buf.extend_from_slice(&word_u8(u8::from(a.revocable)));
    buf.extend_from_slice(a.ref_uid.as_slice());
    buf.extend_from_slice(keccak256(&a.data).as_slice());
    buf.extend_from_slice(a.salt.as_slice());
    keccak256(&buf)
}

/// The EIP-712 signing digest: `keccak256(0x1901 ‖ domainSeparator ‖ structHash)`.
pub fn eip712_digest(domain_separator: B256, struct_hash: B256) -> B256 {
    let mut buf = Vec::with_capacity(2 + 64);
    buf.extend_from_slice(&[0x19, 0x01]);
    buf.extend_from_slice(domain_separator.as_slice());
    buf.extend_from_slice(struct_hash.as_slice());
    keccak256(&buf)
}

/// The EAS offchain-v2 UID (`Offchain.getOffchainUID`, verified against eas-sdk):
/// `keccak256(abi.encodePacked(uint16 version, bytes utf8("0x"+hex(schema)), address recipient,
///  address 0, uint64 time, uint64 expirationTime, bool revocable, bytes32 refUID, bytes data,
///  bytes32 salt, uint32 0))`. NOTE the schema is packed as the UTF-8 BYTES OF ITS HEX STRING
/// (66 bytes) — an eas-sdk quirk that is now wire format.
pub fn offchain_uid_v2(a: &OffchainAttestation) -> B256 {
    let mut buf = Vec::with_capacity(2 + 66 + 20 + 20 + 8 + 8 + 1 + 32 + a.data.len() + 32 + 4);
    buf.extend_from_slice(&a.version.to_be_bytes());
    let mut schema_str = Vec::with_capacity(66);
    schema_str.extend_from_slice(b"0x");
    schema_str.extend_from_slice(alloy_primitives::hex::encode(a.schema.as_slice()).as_bytes());
    buf.extend_from_slice(&schema_str);
    buf.extend_from_slice(a.recipient.as_slice());
    buf.extend_from_slice(Address::ZERO.as_slice());
    buf.extend_from_slice(&a.time.to_be_bytes());
    buf.extend_from_slice(&a.expiration_time.to_be_bytes());
    buf.push(u8::from(a.revocable));
    buf.extend_from_slice(a.ref_uid.as_slice());
    buf.extend_from_slice(&a.data);
    buf.extend_from_slice(a.salt.as_slice());
    buf.extend_from_slice(&0u32.to_be_bytes());
    keccak256(&buf)
}

/// The canonical node id of an address-kind node: `keccak256(abi.encode(address))` — must
/// match `AnchorRegistry.register()`.
pub fn address_node_id(owner: Address) -> B256 {
    keccak256(word_addr(owner))
}

/// Verify one anchored envelope-0 head: either the COMPLETE authenticated live edge set
/// behind `head`, or an error (which the program crate converts into a rule-Φ skip).
///
/// `count` is the ANCHORED count (pinned by `anchorAcc`); the witnessed log must have exactly
/// that length and the owner's head signature must cover `(head, count)` — so a lied-about
/// anchored count can never verify (H-5). `now` is the head's anchor block timestamp
/// (witnessed on-chain data, pinned by `anchorAcc`) — used only for the deterministic
/// expiration rule.
pub fn verify(
    node_id: B256,
    head: B256,
    count: u64,
    now: u64,
    config: &Envelope0Config,
    witness: &Envelope0Witness,
) -> Result<Vec<AuthedEdge>, EnvelopeError> {
    // 1. The witness's owner must be the anchored identity.
    if address_node_id(witness.owner) != node_id {
        return Err(EnvelopeError::Malformed);
    }

    // 2. Completeness: the witnessed log must re-fold to the anchored head, at exactly the
    //    anchored count (H-5: the count is part of the anchored claim, not prover-chosen).
    if witness.entries.len() as u64 != count {
        return Err(EnvelopeError::CountMismatch);
    }
    if log_head(&witness.entries) != head {
        return Err(EnvelopeError::HeadMismatch);
    }

    // 3. The owner authorized exactly this head at exactly this length.
    let payload = head_payload(head, count);
    let signer = recover_address(&eip191_digest32(&payload), &witness.head_signature)
        .map_err(|_| EnvelopeError::BadHeadSignature)?;
    if signer != witness.owner {
        return Err(EnvelopeError::BadHeadSignature);
    }

    // 4. Walk the log in order; last-write-wins per UID with in-log revocation.
    //    BTreeMap keyed by UID keeps iteration deterministic.
    let mut live: BTreeMap<B256, (usize, AuthedEdge)> = BTreeMap::new();
    let mut atts = witness.attestations.iter();
    for (i, e) in witness.entries.iter().enumerate() {
        match e.kind {
            ENTRY_ATTEST => {
                let a = atts.next().ok_or(EnvelopeError::MissingAttestation)?;
                if a.version != 2 {
                    return Err(EnvelopeError::Malformed);
                }
                if a.schema != config.schema_uid {
                    return Err(EnvelopeError::Malformed);
                }
                // The UID binds the entry to this exact attestation content.
                if offchain_uid_v2(a) != e.uid {
                    return Err(EnvelopeError::MissingAttestation);
                }
                if live.contains_key(&e.uid) {
                    // A UID can appear as ATTEST at most once (salt makes UIDs unique).
                    return Err(EnvelopeError::Malformed);
                }
                // Per-edge authorization: try each pinned domain separator in order.
                let sh = attest_struct_hash(a);
                let mut authorized = false;
                for ds in &config.accepted_domain_separators {
                    if let Ok(rec) = recover_address(&eip712_digest(*ds, sh), &a.signature) {
                        if rec == witness.owner {
                            authorized = true;
                            break;
                        }
                    }
                }
                if !authorized {
                    return Err(EnvelopeError::BadEdgeSignature);
                }
                // Deterministic expiration: 0 = never; else the edge dies at that time.
                if a.expiration_time != 0 && a.expiration_time <= now {
                    continue;
                }
                live.insert(
                    e.uid,
                    (
                        i,
                        AuthedEdge {
                            attester: witness.owner,
                            recipient: a.recipient,
                            uid: e.uid,
                            time: a.time,
                            data: a.data.clone(),
                        },
                    ),
                );
            }
            ENTRY_REVOKE => {
                // In-log revocation: deletes a previously attested UID. Revoking an unknown
                // UID is malformed (an honest log never does it; completeness demands the
                // attest precede its revoke).
                if live.remove(&e.uid).is_none() {
                    return Err(EnvelopeError::RevokeUnknownUid);
                }
            }
            _ => return Err(EnvelopeError::Malformed),
        }
    }
    if atts.next().is_some() {
        // Extra witnessed attestations with no log entry — reject rather than ignore.
        return Err(EnvelopeError::Malformed);
    }

    // 5. Emit surviving edges in LOG ORDER (position of their attest entry) — deterministic,
    //    and the program's reconciliation applies its own total order on top.
    let mut out: Vec<(usize, AuthedEdge)> = live.into_values().collect();
    out.sort_by_key(|(i, _)| *i);
    Ok(out.into_iter().map(|(_, e)| e).collect())
}

/// Minimal `serde` helper so byte fields round-trip as `0x`-hex in fixtures/goldens.
mod serde_bytes_hex {
    use serde::{Deserialize, Deserializer, Serializer};

    pub fn serialize<S: Serializer>(bytes: &[u8], s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&format!("0x{}", alloy_primitives::hex::encode(bytes)))
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<Vec<u8>, D::Error> {
        let s = String::deserialize(d)?;
        let s = s.strip_prefix("0x").unwrap_or(&s);
        alloy_primitives::hex::decode(s).map_err(serde::de::Error::custom)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use k256::ecdsa::SigningKey;

    fn sign_prehash(sk: &SigningKey, prehash: &B256) -> Vec<u8> {
        let (sig, rid) = sk.sign_prehash_recoverable(prehash.as_slice()).unwrap();
        // normalize low-S
        let sig = sig.normalize_s().unwrap_or(sig);
        // recompute recovery id for normalized sig by trial recovery
        for v in 0u8..=1 {
            let rid2 = k256::ecdsa::RecoveryId::from_byte(v).unwrap();
            if let Ok(vk) =
                k256::ecdsa::VerifyingKey::recover_from_prehash(prehash.as_slice(), &sig, rid2)
            {
                if vk == *sk.verifying_key() {
                    let mut out = sig.to_bytes().to_vec();
                    out.push(v);
                    return out;
                }
            }
        }
        let mut out = sig.to_bytes().to_vec();
        out.push(rid.to_byte());
        out
    }

    fn addr_of(sk: &SigningKey) -> Address {
        let unc = sk.verifying_key().to_encoded_point(false);
        let h = keccak256(&unc.as_bytes()[1..]);
        Address::from_slice(&h[12..])
    }

    fn make_att(
        sk: &SigningKey,
        ds: B256,
        schema: B256,
        to: u8,
        conf: u64,
        salt: u8,
    ) -> (OffchainAttestation, B256) {
        let mut data = vec![0u8; 64];
        data[32..].copy_from_slice(&U256::from(conf).to_be_bytes::<32>());
        let mut a = OffchainAttestation {
            version: 2,
            schema,
            recipient: Address::from([to; 20]),
            time: 1000,
            expiration_time: 0,
            revocable: true,
            ref_uid: B256::ZERO,
            data,
            salt: B256::from([salt; 32]),
            signature: vec![],
        };
        let digest = eip712_digest(ds, attest_struct_hash(&a));
        a.signature = sign_prehash(sk, &digest);
        let uid = offchain_uid_v2(&a);
        (a, uid)
    }

    fn setup() -> (SigningKey, Address, B256, Envelope0Config) {
        let sk = SigningKey::from_slice(&[0x42u8; 32]).unwrap();
        let owner = addr_of(&sk);
        let ds = keccak256(b"test-domain");
        let cfg = Envelope0Config {
            accepted_domain_separators: vec![ds],
            schema_uid: B256::from([0xAB; 32]),
        };
        (sk, owner, ds, cfg)
    }

    fn witness_for(
        sk: &SigningKey,
        owner: Address,
        entries: Vec<LogEntry>,
        attestations: Vec<OffchainAttestation>,
    ) -> (B256, Envelope0Witness) {
        let head = log_head(&entries);
        let payload = head_payload(head, entries.len() as u64);
        let head_signature = sign_prehash(sk, &eip191_digest32(&payload));
        (head, Envelope0Witness { owner, entries, attestations, head_signature })
    }

    #[test]
    fn attest_then_revoke_yields_survivors_only() {
        let (sk, owner, ds, cfg) = setup();
        let (a1, u1) = make_att(&sk, ds, cfg.schema_uid, 2, 50, 1);
        let (a2, u2) = make_att(&sk, ds, cfg.schema_uid, 3, 75, 2);
        let entries = vec![
            LogEntry { kind: ENTRY_ATTEST, uid: u1 },
            LogEntry { kind: ENTRY_ATTEST, uid: u2 },
            LogEntry { kind: ENTRY_REVOKE, uid: u1 },
        ];
        let (head, w) = witness_for(&sk, owner, entries, vec![a1, a2]);
        let edges = verify(address_node_id(owner), head, 3, 2000, &cfg, &w).unwrap();
        assert_eq!(edges.len(), 1);
        assert_eq!(edges[0].uid, u2);
        assert_eq!(edges[0].attester, owner);
        assert_eq!(edges[0].recipient, Address::from([3u8; 20]));
    }

    #[test]
    fn tampered_log_fails_head_mismatch() {
        let (sk, owner, ds, cfg) = setup();
        let (a1, u1) = make_att(&sk, ds, cfg.schema_uid, 2, 50, 1);
        let entries = vec![LogEntry { kind: ENTRY_ATTEST, uid: u1 }];
        let (head, mut w) = witness_for(&sk, owner, entries, vec![a1]);
        w.entries[0].uid = B256::from([0xEE; 32]); // withhold the real entry
        assert_eq!(
            verify(address_node_id(owner), head, w.entries.len() as u64, 0, &cfg, &w),
            Err(EnvelopeError::HeadMismatch)
        );
    }

    #[test]
    fn foreign_edge_signature_rejected() {
        let (sk, owner, ds, cfg) = setup();
        let intruder = SigningKey::from_slice(&[0x66u8; 32]).unwrap();
        let (a1, u1) = make_att(&intruder, ds, cfg.schema_uid, 2, 50, 1);
        let entries = vec![LogEntry { kind: ENTRY_ATTEST, uid: u1 }];
        let (head, w) = witness_for(&sk, owner, entries, vec![a1]);
        assert_eq!(
            verify(address_node_id(owner), head, w.entries.len() as u64, 0, &cfg, &w),
            Err(EnvelopeError::BadEdgeSignature)
        );
    }

    #[test]
    fn wrong_head_signer_rejected() {
        let (sk, owner, ds, cfg) = setup();
        let intruder = SigningKey::from_slice(&[0x66u8; 32]).unwrap();
        let (a1, u1) = make_att(&sk, ds, cfg.schema_uid, 2, 50, 1);
        let entries = vec![LogEntry { kind: ENTRY_ATTEST, uid: u1 }];
        let head = log_head(&entries);
        let payload = head_payload(head, 1);
        let w = Envelope0Witness {
            owner,
            entries,
            attestations: vec![a1],
            head_signature: sign_prehash(&intruder, &eip191_digest32(&payload)),
        };
        assert_eq!(
            verify(address_node_id(owner), head, w.entries.len() as u64, 0, &cfg, &w),
            Err(EnvelopeError::BadHeadSignature)
        );
    }

    #[test]
    fn expired_edge_excluded_deterministically() {
        let (sk, owner, ds, cfg) = setup();
        let (mut a1, _) = make_att(&sk, ds, cfg.schema_uid, 2, 50, 1);
        a1.expiration_time = 1500;
        let digest = eip712_digest(ds, attest_struct_hash(&a1));
        a1.signature = sign_prehash(&sk, &digest);
        let u1 = offchain_uid_v2(&a1);
        let entries = vec![LogEntry { kind: ENTRY_ATTEST, uid: u1 }];
        let (head, w) = witness_for(&sk, owner, entries, vec![a1]);
        // now past expiry: excluded
        assert!(verify(address_node_id(owner), head, 1, 1600, &cfg, &w).unwrap().is_empty());
        // now before expiry: included
        assert_eq!(verify(address_node_id(owner), head, 1, 1400, &cfg, &w).unwrap().len(), 1);
    }

    #[test]
    fn anchored_count_mismatch_rejected() {
        // H-5: a head can only verify at the exact length its owner co-signed. An anchored
        // count that differs from the witnessed log length is rejected BEFORE any signature
        // work — a lied-about ingress count can never validate.
        let (sk, owner, ds, cfg) = setup();
        let (a1, u1) = make_att(&sk, ds, cfg.schema_uid, 2, 50, 1);
        let entries = vec![LogEntry { kind: ENTRY_ATTEST, uid: u1 }];
        let (head, w) = witness_for(&sk, owner, entries, vec![a1]);
        // True count is 1; both a higher and a zero anchored count must fail.
        assert_eq!(
            verify(address_node_id(owner), head, 2, 0, &cfg, &w),
            Err(EnvelopeError::CountMismatch)
        );
        assert_eq!(
            verify(address_node_id(owner), head, 0, 0, &cfg, &w),
            Err(EnvelopeError::CountMismatch)
        );
        // At the exact signed count it verifies.
        assert_eq!(verify(address_node_id(owner), head, 1, 0, &cfg, &w).unwrap().len(), 1);
    }

    #[test]
    fn revoke_unknown_uid_rejected() {
        let (sk, owner, _ds, cfg) = setup();
        let entries = vec![LogEntry { kind: ENTRY_REVOKE, uid: B256::from([0x99; 32]) }];
        let (head, w) = witness_for(&sk, owner, entries, vec![]);
        assert_eq!(
            verify(address_node_id(owner), head, w.entries.len() as u64, 0, &cfg, &w),
            Err(EnvelopeError::RevokeUnknownUid)
        );
    }
}
