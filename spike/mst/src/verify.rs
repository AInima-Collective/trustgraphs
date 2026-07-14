//! Commit signature verification: multikey parse + k256/p256 ECDSA, low-S enforced,
//! 64-byte compact r||s over SHA-256 of the DRISL-encoded unsigned commit.

use ipld_core::ipld::Ipld;
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Curve {
    K256,
    P256,
}

pub struct Multikey {
    pub curve: Curve,
    /// 33-byte compressed SEC1 point
    pub key: Vec<u8>,
}

/// Parse a `did:key:z...` multikey into (curve, compressed pubkey).
pub fn parse_multikey(did_key: &str) -> Result<Multikey, String> {
    let s = did_key.strip_prefix("did:key:").unwrap_or(did_key);
    let s = s.strip_prefix('z').ok_or("multikey not base58btc (no 'z')")?;
    let raw = bs58::decode(s)
        .into_vec()
        .map_err(|e| format!("base58 decode: {e}"))?;
    // multicodec varint prefix
    let (curve, klen) = match raw.as_slice() {
        [0xe7, 0x01, ..] => (Curve::K256, 2),   // secp256k1-pub
        [0x80, 0x24, ..] => (Curve::P256, 2),   // p256-pub
        _ => return Err(format!("unknown multicodec prefix {:02x?}", &raw[..2.min(raw.len())])),
    };
    let key = raw[klen..].to_vec();
    if key.len() != 33 {
        return Err(format!("expected 33-byte compressed point, got {}", key.len()));
    }
    Ok(Multikey { curve, key })
}

pub struct CommitFields {
    pub did: String,
    pub version: i64,
    pub data: ipld_core::cid::Cid,
    pub rev: String,
    pub sig: Vec<u8>,
    /// DRISL bytes of the commit WITHOUT the `sig` field (the signed payload)
    pub unsigned_bytes: Vec<u8>,
}

/// Decode a commit block, extract fields, and produce the canonical unsigned payload.
pub fn decode_commit(block: &[u8]) -> Result<CommitFields, String> {
    let val: Ipld = serde_ipld_dagcbor::from_slice(block)
        .map_err(|e| format!("commit decode: {e}"))?;
    let map = match val {
        Ipld::Map(m) => m,
        _ => return Err("commit not a map".into()),
    };
    let did = match map.get("did") {
        Some(Ipld::String(s)) => s.clone(),
        _ => return Err("commit missing did".into()),
    };
    let version = match map.get("version") {
        Some(Ipld::Integer(i)) => *i as i64,
        _ => return Err("commit missing version".into()),
    };
    let data = match map.get("data") {
        Some(Ipld::Link(c)) => *c,
        _ => return Err("commit missing data".into()),
    };
    let rev = match map.get("rev") {
        Some(Ipld::String(s)) => s.clone(),
        _ => return Err("commit missing rev".into()),
    };
    let sig = match map.get("sig") {
        Some(Ipld::Bytes(b)) => b.clone(),
        _ => return Err("commit missing sig".into()),
    };

    // rebuild unsigned commit (drop sig), canonical DRISL encode
    let mut unsigned: BTreeMap<String, Ipld> = BTreeMap::new();
    for (k, v) in map.iter() {
        if k != "sig" {
            unsigned.insert(k.clone(), v.clone());
        }
    }
    let unsigned_bytes = serde_ipld_dagcbor::to_vec(&Ipld::Map(unsigned))
        .map_err(|e| format!("re-encode unsigned commit: {e}"))?;

    Ok(CommitFields { did, version, data, rev, sig, unsigned_bytes })
}

/// Verify a commit signature. `unsigned` is the DRISL of the commit sans sig.
pub fn verify_commit_sig(mk: &Multikey, unsigned: &[u8], sig: &[u8]) -> Result<(), String> {
    if sig.len() != 64 {
        return Err(format!("sig not 64-byte compact (got {})", sig.len()));
    }
    let digest = Sha256::digest(unsigned);
    match mk.curve {
        Curve::K256 => {
            use k256::ecdsa::signature::hazmat::PrehashVerifier;
            use k256::ecdsa::{Signature, VerifyingKey};
            let vk = VerifyingKey::from_sec1_bytes(&mk.key)
                .map_err(|e| format!("k256 key: {e}"))?;
            let s = Signature::from_slice(sig).map_err(|e| format!("k256 sig: {e}"))?;
            if s.normalize_s().is_some() {
                return Err("k256 signature is high-S (malleable) — rejected".into());
            }
            vk.verify_prehash(&digest, &s)
                .map_err(|e| format!("k256 verify: {e}"))
        }
        Curve::P256 => {
            use p256::ecdsa::signature::hazmat::PrehashVerifier;
            use p256::ecdsa::{Signature, VerifyingKey};
            let vk = VerifyingKey::from_sec1_bytes(&mk.key)
                .map_err(|e| format!("p256 key: {e}"))?;
            let s = Signature::from_slice(sig).map_err(|e| format!("p256 sig: {e}"))?;
            if s.normalize_s().is_some() {
                return Err("p256 signature is high-S (malleable) — rejected".into());
            }
            vk.verify_prehash(&digest, &s)
                .map_err(|e| format!("p256 verify: {e}"))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // Exercise the p256 code path with a self-generated deterministic vector,
    // since all live fixtures are k256.
    #[test]
    fn p256_vector() {
        use p256::ecdsa::signature::hazmat::PrehashSigner;
        use p256::ecdsa::{Signature, SigningKey};
        use p256::elliptic_curve::sec1::ToEncodedPoint;

        let sk_bytes = [7u8; 32];
        let sk = SigningKey::from_slice(&sk_bytes).unwrap();
        let payload = b"atproto p256 spike vector";
        let digest = Sha256::digest(payload);
        let mut sig: Signature = sk.sign_prehash(&digest).unwrap();
        if let Some(n) = sig.normalize_s() {
            sig = n; // enforce low-S like a compliant signer
        }
        let compressed = sk
            .verifying_key()
            .to_encoded_point(true)
            .as_bytes()
            .to_vec();
        let mk = Multikey { curve: Curve::P256, key: compressed };
        verify_commit_sig(&mk, payload, &sig.to_bytes()).expect("p256 verify");

        // tamper -> must fail
        let mut bad = sig.to_bytes();
        bad[0] ^= 0x01;
        assert!(verify_commit_sig(&mk, payload, &bad).is_err());
    }

    #[test]
    fn multikey_curves() {
        // k256 example (atproto.com #atproto key)
        let mk = parse_multikey("did:key:zQ3shunBKsXixLxKtC5qeSG9E4J5RkGN57im31pcTzbNQnm5w").unwrap();
        assert_eq!(mk.curve, Curve::K256);
        assert_eq!(mk.key.len(), 33);
    }
}
