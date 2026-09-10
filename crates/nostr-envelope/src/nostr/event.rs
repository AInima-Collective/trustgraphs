use k256::schnorr::signature::hazmat::PrehashVerifier;
use k256::schnorr::{Signature, VerifyingKey};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use super::NostrError;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct NostrEvent {
    pub id: [u8; 32],
    pub pubkey: [u8; 32],
    pub created_at: u64,
    pub kind: u16,
    pub tags: Vec<Vec<String>>,
    pub content: String,
    pub sig: Vec<u8>,
}

fn escape_json(value: &str, output: &mut Vec<u8>) {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    for &byte in value.as_bytes() {
        match byte {
            b'\n' => output.extend_from_slice(b"\\n"),
            b'"' => output.extend_from_slice(b"\\\""),
            b'\\' => output.extend_from_slice(b"\\\\"),
            b'\r' => output.extend_from_slice(b"\\r"),
            b'\t' => output.extend_from_slice(b"\\t"),
            0x08 => output.extend_from_slice(b"\\b"),
            0x0c => output.extend_from_slice(b"\\f"),
            0x00..=0x1f => {
                output.extend_from_slice(b"\\u00");
                output.push(HEX[(byte >> 4) as usize]);
                output.push(HEX[(byte & 0x0f) as usize]);
            }
            _ => output.push(byte),
        }
    }
}

pub fn encode_hex(bytes: &[u8], output: &mut Vec<u8>) {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    for &byte in bytes {
        output.push(HEX[(byte >> 4) as usize]);
        output.push(HEX[(byte & 0x0f) as usize]);
    }
}

pub fn lowercase_hex(bytes: &[u8]) -> String {
    let mut output = Vec::with_capacity(bytes.len() * 2);
    encode_hex(bytes, &mut output);
    String::from_utf8(output).expect("hex is UTF-8")
}

pub fn decode_hex<const N: usize>(value: &str) -> Result<[u8; N], NostrError> {
    if value.len() != N * 2 {
        return Err(NostrError::Malformed);
    }
    let mut output = [0u8; N];
    for (index, pair) in value.as_bytes().chunks_exact(2).enumerate() {
        let high = nibble(pair[0]).ok_or(NostrError::Malformed)?;
        let low = nibble(pair[1]).ok_or(NostrError::Malformed)?;
        output[index] = (high << 4) | low;
    }
    Ok(output)
}

fn nibble(value: u8) -> Option<u8> {
    match value {
        b'0'..=b'9' => Some(value - b'0'),
        b'a'..=b'f' => Some(value - b'a' + 10),
        _ => None,
    }
}

pub fn nip01_preimage(event: &NostrEvent) -> Vec<u8> {
    let mut output = Vec::with_capacity(192 + event.content.len());
    output.extend_from_slice(b"[0,\"");
    encode_hex(&event.pubkey, &mut output);
    output.extend_from_slice(b"\",");
    output.extend_from_slice(event.created_at.to_string().as_bytes());
    output.push(b',');
    output.extend_from_slice(event.kind.to_string().as_bytes());
    output.extend_from_slice(b",[");
    for (tag_index, tag) in event.tags.iter().enumerate() {
        if tag_index != 0 {
            output.push(b',');
        }
        output.push(b'[');
        for (element_index, element) in tag.iter().enumerate() {
            if element_index != 0 {
                output.push(b',');
            }
            output.push(b'"');
            escape_json(element, &mut output);
            output.push(b'"');
        }
        output.push(b']');
    }
    output.extend_from_slice(b"],\"");
    escape_json(&event.content, &mut output);
    output.extend_from_slice(b"\"]");
    output
}

pub fn verify(event: &NostrEvent) -> Result<(), NostrError> {
    let id: [u8; 32] = Sha256::digest(nip01_preimage(event)).into();
    if id != event.id {
        return Err(NostrError::BadEventId);
    }
    let key = VerifyingKey::from_bytes(&event.pubkey).map_err(|_| NostrError::BadEventSignature)?;
    if event.sig.len() != 64 {
        return Err(NostrError::BadEventSignature);
    }
    let signature =
        Signature::try_from(event.sig.as_slice()).map_err(|_| NostrError::BadEventSignature)?;
    key.verify_prehash(&id, &signature).map_err(|_| NostrError::BadEventSignature)
}
