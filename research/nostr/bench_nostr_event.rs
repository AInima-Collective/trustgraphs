//! Full Nostr event verification bench: NIP-01 canonical serialization (hand-rolled, spec
//! escaping rules) -> sha256 (patched sha2) -> BIP340 schnorr verify (patched k256) of the
//! 64-byte sig over the 32-byte event id, against the x-only pubkey. This is exactly what a
//! relay/client does to validate an event. XOR-folds every event id into an accumulator and
//! commits it, so the work cannot be optimised away.
#![no_main]
sp1_zkvm::entrypoint!(main);

use k256::schnorr::signature::Verifier;
use k256::schnorr::{Signature, VerifyingKey};
use sha2::{Digest, Sha256};

/// NIP-01 escaping: \n \" \\ \r \t \b \f; all other bytes verbatim.
fn esc(s: &str, out: &mut Vec<u8>) {
    for &b in s.as_bytes() {
        match b {
            0x0A => out.extend_from_slice(b"\\n"),
            0x22 => out.extend_from_slice(b"\\\""),
            0x5C => out.extend_from_slice(b"\\\\"),
            0x0D => out.extend_from_slice(b"\\r"),
            0x09 => out.extend_from_slice(b"\\t"),
            0x08 => out.extend_from_slice(b"\\b"),
            0x0C => out.extend_from_slice(b"\\f"),
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
    // (xonly_pubkey[32], created_at, kind, tags, content, sig[64])
    let cases: Vec<(Vec<u8>, u64, u16, Vec<Vec<String>>, String, Vec<u8>)> = sp1_zkvm::io::read();
    let mut acc = [0u8; 32];
    for (pk, created_at, kind, tags, content, sig_bytes) in &cases {
        let ser = nip01_serialize(pk, *created_at, *kind, tags, content);
        let id: [u8; 32] = Sha256::digest(&ser).into();
        let vk = VerifyingKey::from_bytes(pk).expect("xonly pubkey");
        let sig = Signature::try_from(sig_bytes.as_slice()).expect("sig");
        vk.verify(&id, &sig).expect("schnorr verify over event id");
        for i in 0..32 {
            acc[i] ^= id[i];
        }
    }
    sp1_zkvm::io::commit_slice(&acc);
}
