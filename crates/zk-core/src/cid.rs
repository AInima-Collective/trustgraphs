//! Canonical IPFS blob + CIDv1 (raw codec, sha2-256), reproducible in-circuit
//! (`research/ZK_ARCHITECTURE.md` §4.2).
//!
//! The blob is a compact JSON object `{"0x<addr>":"<decimal value>",...}` with addresses lowercased
//! and sorted ascending. Its SHA2-256 digest is `ipfsHash`; the CIDv1-raw string is `ipfsHashCid`.
//! Pin with `ipfs add --cid-version=1 --raw-leaves` (single raw block for content < 256 KiB).

use alloy_primitives::{Address, U256};
use sha2::{Digest, Sha256};

/// Serialize the scored set to the canonical blob. `scores` MUST be sorted ascending by address
/// and contain only `value > 0` entries.
pub fn canonical_blob(scores: &[(Address, U256)]) -> Vec<u8> {
    let mut s = String::from("{");
    for (i, (addr, value)) in scores.iter().enumerate() {
        if i > 0 {
            s.push(',');
        }
        s.push('"');
        s.push_str("0x");
        s.push_str(&alloy_primitives::hex::encode(addr.as_slice()));
        s.push('"');
        s.push(':');
        s.push('"');
        s.push_str(&value.to_string());
        s.push('"');
    }
    s.push('}');
    s.into_bytes()
}

/// SHA2-256 digest of arbitrary bytes.
pub fn sha256(data: &[u8]) -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update(data);
    let result = hasher.finalize();
    let mut out = [0u8; 32];
    out.copy_from_slice(&result);
    out
}

/// CIDv1, raw codec (0x55), sha2-256 multihash, multibase base32-lower ("b" prefix).
///
/// Bytes: `0x01 (cidv1) || 0x55 (raw) || 0x12 (sha2-256) || 0x20 (len 32) || digest`.
pub fn cid_v1_raw(digest: &[u8; 32]) -> String {
    let mut bytes = Vec::with_capacity(4 + 32);
    bytes.extend_from_slice(&[0x01, 0x55, 0x12, 0x20]);
    bytes.extend_from_slice(digest);
    let mut out = String::from("b");
    out.push_str(&base32_lower_nopad(&bytes));
    out
}

/// CIDv1, dag-cbor codec (0x71), sha2-256 multihash, multibase base32-lower ("b" prefix).
///
/// The inverse of [`verify_dagcbor_cid`]'s parse: `0x01 || 0x71 || 0x12 || 0x20 || digest`.
/// atproto tooling produces these for every record block; this mirrors it for tests/tools.
pub fn cid_v1_dagcbor(digest: &[u8; 32]) -> String {
    let mut bytes = Vec::with_capacity(4 + 32);
    bytes.extend_from_slice(&[0x01, 0x71, 0x12, 0x20]);
    bytes.extend_from_slice(digest);
    let mut out = String::from("b");
    out.push_str(&base32_lower_nopad(&bytes));
    out
}

/// Verify that `block` is the content addressed by `cid` — a CIDv1, dag-cbor codec
/// (0x71), sha2-256 multihash, multibase base32-lower ("b" prefix). This is the codec
/// atproto uses for every record block, so a badge-definition strongRef resolves here.
///
/// Content-addressing is what makes a prover-supplied `(cid -> bytes)` map trustworthy:
/// only a block whose sha2-256 digest matches the multihash embedded in the CID is the
/// block the author actually referenced. Returns `false` on any structural mismatch
/// (wrong multibase/codec/hash/length) or digest mismatch — callers should treat a
/// `false` as "no verifiable definition" and fall back to their default.
pub fn verify_dagcbor_cid(cid: &str, block: &[u8]) -> bool {
    match dagcbor_sha256_digest(cid) {
        Some(digest) => sha256(block) == digest,
        None => false,
    }
}

/// Extract the sha2-256 digest from a CIDv1 dag-cbor CID string, or `None` if the string
/// is not exactly `'b' || base32-lower(0x01 0x71 0x12 0x20 || digest[32])`.
fn dagcbor_sha256_digest(cid: &str) -> Option<[u8; 32]> {
    let rest = cid.strip_prefix('b')?;
    let bytes = base32_lower_decode(rest)?;
    // 0x01 (cidv1) || 0x71 (dag-cbor) || 0x12 (sha2-256) || 0x20 (len 32) || digest[32]
    if bytes.len() != 4 + 32 {
        return None;
    }
    if bytes[0] != 0x01 || bytes[1] != 0x71 || bytes[2] != 0x12 || bytes[3] != 0x20 {
        return None;
    }
    let mut out = [0u8; 32];
    out.copy_from_slice(&bytes[4..]);
    Some(out)
}

/// RFC 4648 base32 lowercase, no padding — inverse of `base32_lower_nopad`. Returns
/// `None` on any character outside the alphabet or non-zero trailing pad bits (so a
/// non-canonical encoding is rejected, keeping the CID→bytes map deterministic).
fn base32_lower_decode(s: &str) -> Option<Vec<u8>> {
    let mut out = Vec::with_capacity(s.len() * 5 / 8);
    let mut acc: u32 = 0;
    let mut bits: u32 = 0;
    for c in s.bytes() {
        let val = match c {
            b'a'..=b'z' => c - b'a',
            b'2'..=b'7' => c - b'2' + 26,
            _ => return None,
        } as u32;
        acc = (acc << 5) | val;
        bits += 5;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
        }
    }
    // Canonical no-pad: fewer than 5 leftover bits, and they must be zero.
    if bits >= 5 || (bits > 0 && (acc & ((1 << bits) - 1)) != 0) {
        return None;
    }
    Some(out)
}

/// RFC 4648 base32, lowercase alphabet, no padding.
fn base32_lower_nopad(data: &[u8]) -> String {
    const ALPHABET: &[u8; 32] = b"abcdefghijklmnopqrstuvwxyz234567";
    let mut out = String::new();
    let mut acc: u32 = 0;
    let mut bits: u32 = 0;
    for &b in data {
        acc = (acc << 8) | b as u32;
        bits += 8;
        while bits >= 5 {
            bits -= 5;
            let idx = ((acc >> bits) & 0x1f) as usize;
            out.push(ALPHABET[idx] as char);
        }
    }
    if bits > 0 {
        let idx = ((acc << (5 - bits)) & 0x1f) as usize;
        out.push(ALPHABET[idx] as char);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::str::FromStr;

    #[test]
    fn base32_known_vector() {
        // RFC 4648: base32("foobar") = "MZXW6YTBOI" (lowercased, no pad).
        assert_eq!(base32_lower_nopad(b"foobar"), "mzxw6ytboi");
    }

    #[test]
    fn blob_is_sorted_and_compact() {
        let a = Address::from([0x01; 20]);
        let b = Address::from([0x02; 20]);
        let blob = canonical_blob(&[(a, U256::from(5)), (b, U256::from(9))]);
        let s = String::from_utf8(blob).unwrap();
        assert_eq!(
            s,
            "{\"0x0101010101010101010101010101010101010101\":\"5\",\
              \"0x0202020202020202020202020202020202020202\":\"9\"}"
        );
    }

    /// Build a CIDv1 dag-cbor (0x71) sha2-256 CID over `block` — mirrors how atproto
    /// content-addresses a record block.
    fn dagcbor_cid(block: &[u8]) -> String {
        let digest = sha256(block);
        let mut bytes = vec![0x01, 0x71, 0x12, 0x20];
        bytes.extend_from_slice(&digest);
        let mut out = String::from("b");
        out.push_str(&base32_lower_nopad(&bytes));
        out
    }

    #[test]
    fn base32_roundtrips() {
        for v in [&b""[..], b"f", b"fo", b"foo", b"foob", b"fooba", b"foobar", &[0u8; 36]] {
            let enc = base32_lower_nopad(v);
            assert_eq!(base32_lower_decode(&enc).as_deref(), Some(v), "roundtrip {v:?}");
        }
    }

    #[test]
    fn base32_decode_rejects_bad_chars() {
        assert_eq!(base32_lower_decode("abc1"), None); // '1' not in alphabet
        assert_eq!(base32_lower_decode("ABC"), None); // uppercase not accepted
    }

    #[test]
    fn verify_accepts_matching_block() {
        let block = b"a badge definition record, dag-cbor bytes";
        let cid = dagcbor_cid(block);
        assert!(verify_dagcbor_cid(&cid, block));
    }

    #[test]
    fn verify_rejects_tampered_block() {
        // The C-1 attack: prover keeps the CID but swaps the bytes (e.g. a forged
        // allowedIssuers list). The digest no longer matches, so it is not honored.
        let cid = dagcbor_cid(b"the real definition");
        assert!(!verify_dagcbor_cid(&cid, b"a forged definition"));
    }

    #[test]
    fn verify_rejects_wrong_codec_and_garbage() {
        // A raw-codec (0x55) CID over the same bytes must not validate as a dag-cbor
        // definition, and non-CID garbage fails closed.
        let block = b"some bytes";
        let raw_cid = cid_v1_raw(&sha256(block));
        assert!(!verify_dagcbor_cid(&raw_cid, block));
        assert!(!verify_dagcbor_cid("not-a-cid", block));
        assert!(!verify_dagcbor_cid("", block));
    }

    #[test]
    fn cid_has_expected_prefix() {
        // CIDv1 raw sha2-256 always starts with "bafkrei".
        let digest = sha256(b"hello world");
        let cid = cid_v1_raw(&digest);
        assert!(cid.starts_with("bafkrei"), "cid was {cid}");
    }

    #[test]
    fn cid_length_is_stable() {
        // CIDv1 raw sha2-256 is multibase 'b' + base32(36 bytes) = 1 + 58 = 59 chars.
        let digest = sha256(b"hello world");
        let cid = cid_v1_raw(&digest);
        assert_eq!(cid.len(), 59, "cid was {cid}");
        let _ = Address::from_str("0x0000000000000000000000000000000000000000").unwrap();
    }
}
