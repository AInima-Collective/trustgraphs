#![allow(dead_code)]

use k256::schnorr::signature::hazmat::PrehashVerifier;
use k256::schnorr::{Signature, VerifyingKey};
use sha2::{Digest, Sha256};

pub type AuditCase = (
    Vec<u8>,
    u64,
    String,
    String,
    Option<Vec<u8>>,
    Option<String>,
    String,
    Option<Vec<u8>>,
    Vec<u8>,
);
pub type EventCase = (Vec<u8>, u64, u16, Vec<Vec<String>>, String, Vec<u8>, Vec<u8>);
pub type OaCase = (Vec<u8>, Vec<u8>, String, Vec<u8>, u16, u64);

fn esc(s: &str, out: &mut Vec<u8>) {
    const H: &[u8; 16] = b"0123456789abcdef";
    for &b in s.as_bytes() {
        match b {
            0x0A => out.extend_from_slice(b"\\n"),
            0x22 => out.extend_from_slice(b"\\\""),
            0x5C => out.extend_from_slice(b"\\\\"),
            0x0D => out.extend_from_slice(b"\\r"),
            0x09 => out.extend_from_slice(b"\\t"),
            0x08 => out.extend_from_slice(b"\\b"),
            0x0C => out.extend_from_slice(b"\\f"),
            0x00..=0x1F => {
                out.extend_from_slice(b"\\u00");
                out.push(H[(b >> 4) as usize]);
                out.push(H[(b & 15) as usize]);
            }
            _ => out.push(b),
        }
    }
}

fn hex_bytes(bytes: &[u8], out: &mut Vec<u8>) {
    const H: &[u8; 16] = b"0123456789abcdef";
    for &byte in bytes {
        out.push(H[(byte >> 4) as usize]);
        out.push(H[(byte & 15) as usize]);
    }
}

fn decode_hex_32(value: &str) -> [u8; 32] {
    assert_eq!(value.len(), 64, "32-byte lowercase hex length");
    let mut output = [0u8; 32];
    for (index, pair) in value.as_bytes().chunks_exact(2).enumerate() {
        output[index] = (nibble(pair[0]) << 4) | nibble(pair[1]);
    }
    output
}

fn decode_hex_64(value: &str) -> [u8; 64] {
    assert_eq!(value.len(), 128, "64-byte lowercase hex length");
    let mut output = [0u8; 64];
    for (index, pair) in value.as_bytes().chunks_exact(2).enumerate() {
        output[index] = (nibble(pair[0]) << 4) | nibble(pair[1]);
    }
    output
}

fn nibble(value: u8) -> u8 {
    match value {
        b'0'..=b'9' => value - b'0',
        b'a'..=b'f' => value - b'a' + 10,
        _ => panic!("non-canonical lowercase hex"),
    }
}

pub fn nip01_serialize(
    pubkey: &[u8],
    created_at: u64,
    kind: u16,
    tags: &[Vec<String>],
    content: &str,
) -> Vec<u8> {
    let mut output = Vec::with_capacity(192 + content.len());
    output.extend_from_slice(b"[0,\"");
    hex_bytes(pubkey, &mut output);
    output.extend_from_slice(b"\",");
    output.extend_from_slice(created_at.to_string().as_bytes());
    output.push(b',');
    output.extend_from_slice(kind.to_string().as_bytes());
    output.extend_from_slice(b",[");
    for (tag_index, tag) in tags.iter().enumerate() {
        if tag_index != 0 {
            output.push(b',');
        }
        output.push(b'[');
        for (element_index, element) in tag.iter().enumerate() {
            if element_index != 0 {
                output.push(b',');
            }
            output.push(b'"');
            esc(element, &mut output);
            output.push(b'"');
        }
        output.push(b']');
    }
    output.extend_from_slice(b"],\"");
    esc(content, &mut output);
    output.extend_from_slice(b"\"]");
    output
}

pub fn verify_event(case: &EventCase) -> [u8; 32] {
    let (pubkey, created_at, kind, tags, content, signature, expected_id) = case;
    assert_eq!(pubkey.len(), 32, "x-only public key length");
    assert_eq!(signature.len(), 64, "BIP-340 signature length");
    assert_eq!(expected_id.len(), 32, "Nostr event id length");
    let preimage = nip01_serialize(pubkey, *created_at, *kind, tags, content);
    let event_id: [u8; 32] = Sha256::digest(&preimage).into();
    assert_eq!(event_id.as_slice(), expected_id.as_slice(), "NIP-01 serializer parity");
    let verifying_key = VerifyingKey::from_bytes(pubkey).expect("x-only public key");
    let signature = Signature::try_from(signature.as_slice()).expect("BIP-340 signature");
    verifying_key.verify_prehash(&event_id, &signature).expect("Nostr BIP-340 prehash signature");
    event_id
}

pub fn verify_audit(cases: &[AuditCase]) -> [u8; 32] {
    let mut previous: Option<[u8; 32]> = None;
    for (index, case) in cases.iter().enumerate() {
        let (
            community,
            sequence,
            created_at,
            action,
            actor,
            object_id,
            detail,
            recorded_previous,
            expected_hash,
        ) = case;
        assert_eq!(community.len(), 16, "UUID byte length");
        assert_eq!(*sequence, (index + 1) as u64, "gap-free audit prefix");
        assert_eq!(recorded_previous.as_deref(), previous.as_ref().map(<[u8; 32]>::as_slice));
        if let Some(actor) = actor {
            assert_eq!(actor.len(), 32, "audit actor key length");
        }
        assert_eq!(expected_hash.len(), 32, "audit hash length");

        let mut preimage = Vec::with_capacity(256);
        preimage.extend_from_slice(community);
        preimage.extend_from_slice(&sequence.to_be_bytes());
        preimage.extend_from_slice(created_at.as_bytes());
        preimage.extend_from_slice(action.as_bytes());
        match actor {
            Some(actor) => {
                preimage.push(1);
                preimage.extend_from_slice(actor);
            }
            None => preimage.push(0),
        }
        match object_id {
            Some(object_id) => {
                preimage.push(1);
                preimage.extend_from_slice(object_id.as_bytes());
            }
            None => preimage.push(0),
        }
        preimage.extend_from_slice(detail.as_bytes());
        preimage.extend_from_slice(previous.as_ref().unwrap_or(&[0u8; 32]));
        let hash: [u8; 32] = Sha256::digest(&preimage).into();
        assert_eq!(hash.as_slice(), expected_hash.as_slice(), "Buzz audit hash");
        previous = Some(hash);
    }
    previous.unwrap_or([0u8; 32])
}

fn canonical_decimal(value: &str) -> Option<u32> {
    if value.is_empty() || (value.len() > 1 && value.starts_with('0')) {
        return None;
    }
    if !value.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    value.parse::<u32>().ok()
}

fn conditions_apply(conditions: &str, kind: u16, created_at: u64) -> bool {
    if conditions.is_empty() {
        return true;
    }
    conditions.split('&').all(|clause| {
        if let Some(value) = clause.strip_prefix("kind=") {
            canonical_decimal(value).is_some_and(|value| value == u32::from(kind))
        } else if let Some(value) = clause.strip_prefix("created_at<") {
            canonical_decimal(value).is_some_and(|value| created_at < u64::from(value))
        } else if let Some(value) = clause.strip_prefix("created_at>") {
            canonical_decimal(value).is_some_and(|value| created_at > u64::from(value))
        } else {
            false
        }
    })
}

pub fn verify_oa(case: &OaCase) -> [u8; 32] {
    let (agent, owner, conditions, signature, kind, created_at) = case;
    assert_eq!(agent.len(), 32, "OA agent key length");
    assert_eq!(owner.len(), 32, "OA owner key length");
    assert_ne!(agent, owner, "OA self-attestation");
    assert!(conditions_apply(conditions, *kind, *created_at), "OA conditions");
    assert_eq!(signature.len(), 64, "OA signature length");

    let mut preimage = Vec::with_capacity(128 + conditions.len());
    preimage.extend_from_slice(b"nostr:agent-auth:");
    hex_bytes(agent, &mut preimage);
    preimage.push(b':');
    preimage.extend_from_slice(conditions.as_bytes());
    let digest: [u8; 32] = Sha256::digest(&preimage).into();
    let verifying_key = VerifyingKey::from_bytes(owner).expect("OA owner public key");
    let signature = Signature::try_from(signature.as_slice()).expect("OA signature");
    verifying_key.verify_prehash(&digest, &signature).expect("OA BIP-340 signature");
    digest
}

pub fn oa_from_auth_tag(agent: &[u8], kind: u16, created_at: u64, tag: &[String]) -> OaCase {
    assert_eq!(tag.len(), 4, "OA auth tag cardinality");
    assert_eq!(tag[0], "auth", "OA auth tag name");
    (
        agent.to_vec(),
        decode_hex_32(&tag[1]).to_vec(),
        tag[2].clone(),
        decode_hex_64(&tag[3]).to_vec(),
        kind,
        created_at,
    )
}

pub struct Cursor<'a> {
    input: &'a [u8],
    offset: usize,
}

impl<'a> Cursor<'a> {
    pub fn new(input: &'a [u8]) -> Self {
        assert!(input.len() <= 12_582_912, "TGNW envelope byte cap");
        Self { input, offset: 0 }
    }

    pub fn take(&mut self, length: usize) -> &'a [u8] {
        let end = self.offset.checked_add(length).expect("TGNW offset overflow");
        assert!(end <= self.input.len(), "truncated TGNW");
        let value = &self.input[self.offset..end];
        self.offset = end;
        value
    }

    pub fn byte(&mut self) -> u8 {
        self.take(1)[0]
    }

    pub fn u16(&mut self) -> u16 {
        u16::from_be_bytes(self.take(2).try_into().unwrap())
    }

    pub fn u32(&mut self) -> u32 {
        u32::from_be_bytes(self.take(4).try_into().unwrap())
    }

    pub fn u64(&mut self) -> u64 {
        u64::from_be_bytes(self.take(8).try_into().unwrap())
    }

    pub fn string(&mut self, maximum: usize) -> String {
        let length = self.u32() as usize;
        assert!(length <= maximum, "TGNW string cap");
        String::from_utf8(self.take(length).to_vec()).expect("TGNW UTF-8")
    }

    pub fn finished(&self) -> bool {
        self.offset == self.input.len()
    }
}

fn action_name(code: u8) -> &'static str {
    match code {
        0 => "event_created",
        1 => "event_deleted",
        2 => "channel_created",
        3 => "channel_updated",
        4 => "channel_deleted",
        5 => "member_added",
        6 => "member_removed",
        7 => "auth_success",
        8 => "auth_failure",
        9 => "rate_limit_exceeded",
        10 => "media_uploaded",
        _ => panic!("unknown TGNW audit action"),
    }
}

pub fn verify_tgnw_option_a(bundle: &[u8], expected_commitment: &[u8]) -> [u8; 32] {
    assert_eq!(expected_commitment.len(), 32, "data commitment length");
    let data_commitment: [u8; 32] = Sha256::digest(bundle).into();
    assert_eq!(data_commitment.as_slice(), expected_commitment, "TGNW data commitment");

    let mut cursor = Cursor::new(bundle);
    assert_eq!(cursor.take(4), b"TGNW", "TGNW magic");
    assert_eq!(cursor.byte(), 1, "TGNW version");
    assert_eq!(cursor.byte(), 1, "TGNW Option-A variant");
    assert_eq!(cursor.u16(), 0, "TGNW flags");
    let community = cursor.take(16).to_vec();
    cursor.take(32); // instance domain
    cursor.take(32); // relay authority

    let audit_count = cursor.u32() as usize;
    assert!(audit_count <= 4_096, "TGNW audit count cap");
    let mut audits = Vec::with_capacity(audit_count);
    let mut audited_ids = Vec::with_capacity(audit_count);
    for _ in 0..audit_count {
        let sequence = cursor.u64();
        let hash = cursor.take(32).to_vec();
        let previous = match cursor.byte() {
            0 => None,
            1 => Some(cursor.take(32).to_vec()),
            _ => panic!("audit prev_hash presence"),
        };
        let action = action_name(cursor.byte()).to_owned();
        let actor = match cursor.byte() {
            0 => None,
            1 => Some(cursor.take(32).to_vec()),
            _ => panic!("audit actor presence"),
        };
        let object_id = match cursor.byte() {
            0 => None,
            1 => Some(cursor.string(1_024)),
            _ => panic!("audit object presence"),
        };
        let created_at = cursor.string(64);
        let detail = cursor.string(4_096);
        assert_eq!(action, "event_created", "live Option-A action");
        audited_ids.push(object_id.clone().expect("EventCreated object id"));
        audits.push((
            community.clone(),
            sequence,
            created_at,
            action,
            actor,
            object_id,
            detail,
            previous,
            hash,
        ));
    }
    let audit_head = verify_audit(&audits);

    let event_count = cursor.u32() as usize;
    assert!(event_count <= 512, "TGNW event count cap");
    let mut event_ids = Vec::with_capacity(event_count);
    let mut oa_digests = Vec::new();
    for _ in 0..event_count {
        let event_start = cursor.offset;
        let expected_id = cursor.take(32).to_vec();
        let pubkey = cursor.take(32).to_vec();
        let created_at = cursor.u64();
        let kind_u32 = cursor.u32();
        assert!(kind_u32 <= u32::from(u16::MAX), "Nostr kind cap");
        let kind = kind_u32 as u16;
        let tag_count = cursor.u32() as usize;
        assert!(tag_count <= 64, "TGNW tag count cap");
        let mut tags = Vec::with_capacity(tag_count);
        let mut total_tag_bytes = 0usize;
        for _ in 0..tag_count {
            let element_count = cursor.u32() as usize;
            assert!(element_count <= 8, "TGNW tag element cap");
            let mut tag = Vec::with_capacity(element_count);
            for _ in 0..element_count {
                let element = cursor.string(1_024);
                total_tag_bytes = total_tag_bytes.checked_add(element.len()).expect("tag bytes");
                assert!(total_tag_bytes <= 16_384, "TGNW total tag bytes cap");
                tag.push(element);
            }
            tags.push(tag);
        }
        let content = cursor.string(65_536);
        let signature = cursor.take(64).to_vec();
        let case =
            (pubkey.clone(), created_at, kind, tags.clone(), content, signature, expected_id);
        let event_id = verify_event(&case);
        event_ids.push(event_id);

        let auth_tags: Vec<&Vec<String>> =
            tags.iter().filter(|tag| tag.first().is_some_and(|name| name == "auth")).collect();
        assert!(auth_tags.len() <= 1, "ambiguous OA auth tags");
        if let Some(tag) = auth_tags.first() {
            oa_digests.push(verify_oa(&oa_from_auth_tag(&pubkey, kind, created_at, tag)));
            assert!(oa_digests.len() <= 256, "TGNW OA signature cap");
        }
        assert!(cursor.offset - event_start <= 131_072, "TGNW encoded event cap");
    }
    assert!(cursor.finished(), "trailing TGNW bytes");
    for object_id in &audited_ids {
        let object_id = decode_hex_32(object_id);
        assert!(event_ids.contains(&object_id), "audited event bytes missing");
    }

    let mut output = Sha256::new();
    output.update(data_commitment);
    output.update(audit_head);
    for digest in oa_digests {
        output.update(digest);
    }
    output.finalize().into()
}
