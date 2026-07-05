//! Canonical IPFS blob + CIDv1 (raw codec, sha2-256), reproducible in-circuit (PLAN.md §1.5).
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
