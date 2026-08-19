//! Full Nostr event verification bench: byte-exact rust-nostr/serde_json NIP-01 serialization ->
//! sha256 (patched sha2) -> BIP340 schnorr prehash verify (patched k256) of the 64-byte signature
//! over the 32-byte event id. The host supplies the rust-nostr-compatible expected id and the guest
//! rejects any serializer mismatch before verifying. XOR-folds every event id into an accumulator
//! and commits it, so the work cannot be optimised away.
#![no_main]
sp1_zkvm::entrypoint!(main);

use k256::schnorr::signature::hazmat::PrehashVerifier;
use k256::schnorr::{Signature, VerifyingKey};
use sha2::{Digest, Sha256};

/// `serde_json` string escaping used by rust-nostr's NIP-01 serializer.
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

fn hex32(b: &[u8], out: &mut Vec<u8>) {
    const H: &[u8; 16] = b"0123456789abcdef";
    for &x in b {
        out.push(H[(x >> 4) as usize]);
        out.push(H[(x & 15) as usize]);
    }
}

/// `[0,"<pk hex>",<created_at>,<kind>,<tags>,"<content>"]` — no whitespace.
fn nip01_serialize(
    pk: &[u8],
    created_at: u64,
    kind: u16,
    tags: &[Vec<String>],
    content: &str,
) -> Vec<u8> {
    let mut o = Vec::with_capacity(192 + content.len());
    o.extend_from_slice(b"[0,\"");
    hex32(pk, &mut o);
    o.extend_from_slice(b"\",");
    o.extend_from_slice(created_at.to_string().as_bytes());
    o.push(b',');
    o.extend_from_slice(kind.to_string().as_bytes());
    o.extend_from_slice(b",[");
    for (i, tag) in tags.iter().enumerate() {
        if i > 0 {
            o.push(b',');
        }
        o.push(b'[');
        for (j, s) in tag.iter().enumerate() {
            if j > 0 {
                o.push(b',');
            }
            o.push(b'"');
            esc(s, &mut o);
            o.push(b'"');
        }
        o.push(b']');
    }
    o.extend_from_slice(b"],\"");
    esc(content, &mut o);
    o.extend_from_slice(b"\"]");
    o
}

pub fn main() {
    // (xonly_pubkey[32], created_at, kind, tags, content, sig[64], expected_event_id[32])
    let cases: Vec<(Vec<u8>, u64, u16, Vec<Vec<String>>, String, Vec<u8>, Vec<u8>)> =
        sp1_zkvm::io::read();
    let mut acc = [0u8; 32];
    for (pk, created_at, kind, tags, content, sig_bytes, expected_id) in &cases {
        let ser = nip01_serialize(pk, *created_at, *kind, tags, content);
        let id: [u8; 32] = Sha256::digest(&ser).into();
        assert_eq!(id.as_slice(), expected_id.as_slice(), "NIP-01 serializer parity");
        let vk = VerifyingKey::from_bytes(pk).expect("xonly pubkey");
        let sig = Signature::try_from(sig_bytes.as_slice()).expect("sig");
        vk.verify_prehash(&id, &sig).expect("schnorr prehash verify over event id");
        for i in 0..32 {
            acc[i] ^= id[i];
        }
    }
    sp1_zkvm::io::commit_slice(&acc);
}
