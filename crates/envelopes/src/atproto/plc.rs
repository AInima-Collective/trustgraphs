//! did:plc audit-log chain verification, in-guest (HYPERCERTS_ATPROTO_PLAN §5.3).
//!
//! PLC operations are SELF-CERTIFYING: the DID is the hash of the signed genesis op, every
//! op names its predecessor by CID, and every op is signed by a rotation key of the op it
//! builds on. What the directory (or our mirror) contributes is only ORDERING and TIMING
//! (`createdAt`, nullification flags) — exactly the trust split in the OFFCHAIN doc's §8
//! table. The guest verifies everything self-certifying and applies the nullification and
//! 72h-provisional rules over the directory-attested times the witness carries.
//!
//! Witness form: each op as its FULL signed dag-cbor bytes (the host converts the
//! directory's JSON to dag-cbor; it cannot cheat — the DID hash and every `prev` CID pin
//! the exact bytes), plus the directory-attested `createdAt` and nullification flag.

use super::commit::{parse_multikey, Curve, Multikey};
use ipld_core::ipld::Ipld;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;

/// The 72h recovery window (seconds): a fork op may nullify a branch this much younger,
/// and a binding younger than this is provisional (previous key also accepted).
pub const RECOVERY_WINDOW_SECS: u64 = 72 * 3600;

/// One audit-log entry as witnessed: the signed op's dag-cbor bytes + directory-attested
/// metadata (creation time, nullification).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct PlcOpWitness {
    #[serde(with = "zk_core::serde_hex")]
    pub op_bytes: Vec<u8>,
    /// Directory-attested creation time (unix seconds).
    pub created_at: u64,
    /// Directory-attested nullification flag.
    pub nullified: bool,
}

/// The chain-verified identity state the envelope needs.
#[derive(Clone, Debug)]
pub struct VerifiedIdentity {
    /// The `#atproto` signing key from the chain tip.
    pub atproto_key: Multikey,
    /// The previous tip's `#atproto` key, accepted alongside the current one while the tip
    /// is younger than the recovery window (the 72h-provisional rule).
    pub provisional_prev_key: Option<Multikey>,
    /// `createdAt` of the chain tip (drives the provisional rule against the epoch "now").
    pub tip_created_at: u64,
}

/// Decoded fields of one op.
struct Op {
    typ: String,
    prev: Option<String>,
    rotation_keys: Vec<String>,
    atproto_key: Option<String>,
    sig_b64: String,
    /// dag-cbor of the op with `sig` removed (the signed payload).
    unsigned_bytes: Vec<u8>,
    /// CIDv1(dag-cbor, sha2-256) string of the FULL signed op (what `prev` references).
    cid_str: String,
    /// sha256 of the full signed op bytes (for the genesis/DID check).
    full_hash: [u8; 32],
}

fn ipld_str(m: &BTreeMap<String, Ipld>, k: &str) -> Option<String> {
    match m.get(k) {
        Some(Ipld::String(s)) => Some(s.clone()),
        _ => None,
    }
}

fn decode_op(bytes: &[u8]) -> Result<Op, String> {
    let val: Ipld =
        serde_ipld_dagcbor::from_slice(bytes).map_err(|e| format!("plc op decode: {e}"))?;
    let map = match val {
        Ipld::Map(m) => m,
        _ => return Err("plc op not a map".into()),
    };
    let typ = ipld_str(&map, "type").ok_or("plc op missing type")?;
    let prev = match map.get("prev") {
        Some(Ipld::String(s)) => Some(s.clone()),
        Some(Ipld::Null) | None => None,
        _ => return Err("plc op prev not string/null".into()),
    };
    let sig_b64 = ipld_str(&map, "sig").ok_or("plc op missing sig")?;

    // rotationKeys: legacy "create" ops carry recoveryKey/signingKey instead.
    let rotation_keys: Vec<String> = match map.get("rotationKeys") {
        Some(Ipld::List(l)) => l
            .iter()
            .filter_map(|x| match x {
                Ipld::String(s) => Some(s.clone()),
                _ => None,
            })
            .collect(),
        _ if typ == "create" => {
            let mut v = Vec::new();
            if let Some(k) = ipld_str(&map, "recoveryKey") {
                v.push(k);
            }
            if let Some(k) = ipld_str(&map, "signingKey") {
                v.push(k);
            }
            v
        }
        _ if typ == "plc_tombstone" => Vec::new(),
        _ => return Err("plc op missing rotationKeys".into()),
    };

    // verificationMethods.atproto (legacy create: signingKey).
    let atproto_key = match map.get("verificationMethods") {
        Some(Ipld::Map(vm)) => ipld_str(vm, "atproto"),
        _ if typ == "create" => ipld_str(&map, "signingKey"),
        _ => None,
    };

    // Signed payload: the op WITHOUT sig, canonically re-encoded.
    let mut unsigned: BTreeMap<String, Ipld> = BTreeMap::new();
    for (k, v) in map.iter() {
        if k != "sig" {
            unsigned.insert(k.clone(), v.clone());
        }
    }
    let unsigned_bytes = serde_ipld_dagcbor::to_vec(&Ipld::Map(unsigned))
        .map_err(|e| format!("plc unsigned re-encode: {e}"))?;

    // Canonical form check: re-encoding the FULL map must reproduce the witnessed bytes
    // (otherwise the host could smuggle a non-canonical encoding whose hash differs from
    // what the directory serves).
    let full_reencoded = serde_ipld_dagcbor::to_vec(&Ipld::Map(map))
        .map_err(|e| format!("plc full re-encode: {e}"))?;
    if full_reencoded != bytes {
        return Err("plc op bytes are not canonical dag-cbor".into());
    }

    let full_hash: [u8; 32] = Sha256::digest(bytes).into();
    let cid = super::carset::cid_dagcbor(bytes);
    Ok(Op {
        typ,
        prev,
        rotation_keys,
        atproto_key,
        sig_b64,
        unsigned_bytes,
        cid_str: cid.to_string(),
        full_hash,
    })
}

/// base64url (no padding) decode — PLC op signatures.
fn b64url_decode(s: &str) -> Result<Vec<u8>, String> {
    const REV: fn(u8) -> Result<u32, String> = |c| match c {
        b'A'..=b'Z' => Ok((c - b'A') as u32),
        b'a'..=b'z' => Ok((c - b'a' + 26) as u32),
        b'0'..=b'9' => Ok((c - b'0' + 52) as u32),
        b'-' => Ok(62),
        b'_' => Ok(63),
        _ => Err(format!("bad base64url char {c}")),
    };
    let s = s.trim_end_matches('=');
    let mut out = Vec::with_capacity(s.len() * 3 / 4);
    let mut acc: u32 = 0;
    let mut bits = 0u32;
    for &c in s.as_bytes() {
        acc = (acc << 6) | REV(c)?;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
        }
    }
    Ok(out)
}

/// base32 lower, no padding (RFC 4648) — the DID suffix encoding.
fn base32_lower(data: &[u8]) -> String {
    const ALPHABET: &[u8; 32] = b"abcdefghijklmnopqrstuvwxyz234567";
    let mut out = String::new();
    let mut acc: u32 = 0;
    let mut bits: u32 = 0;
    for &b in data {
        acc = (acc << 8) | b as u32;
        bits += 8;
        while bits >= 5 {
            bits -= 5;
            out.push(ALPHABET[((acc >> bits) & 0x1f) as usize] as char);
        }
    }
    if bits > 0 {
        out.push(ALPHABET[((acc << (5 - bits)) & 0x1f) as usize] as char);
    }
    out
}

/// Verify a PLC op signature against one of `keys` (in priority order), returning the index
/// of the key that verified.
fn verify_op_sig(keys: &[String], unsigned: &[u8], sig_b64: &str) -> Result<usize, String> {
    let sig = b64url_decode(sig_b64)?;
    if sig.len() != 64 {
        return Err(format!("plc sig not 64 bytes (got {})", sig.len()));
    }
    let digest = Sha256::digest(unsigned);
    for (i, kstr) in keys.iter().enumerate() {
        let Ok(mk) = parse_multikey(kstr) else { continue };
        let ok = match mk.curve {
            Curve::K256 => {
                use k256::ecdsa::signature::hazmat::PrehashVerifier;
                use k256::ecdsa::{Signature, VerifyingKey};
                VerifyingKey::from_sec1_bytes(&mk.key)
                    .ok()
                    .zip(Signature::from_slice(&sig).ok())
                    .map(|(vk, s)| vk.verify_prehash(&digest, &s).is_ok())
                    .unwrap_or(false)
            }
            Curve::P256 => {
                use p256::ecdsa::signature::hazmat::PrehashVerifier;
                use p256::ecdsa::{Signature, VerifyingKey};
                VerifyingKey::from_sec1_bytes(&mk.key)
                    .ok()
                    .zip(Signature::from_slice(&sig).ok())
                    .map(|(vk, s)| vk.verify_prehash(&digest, &s).is_ok())
                    .unwrap_or(false)
            }
        };
        if ok {
            return Ok(i);
        }
    }
    Err("plc op signature matches no rotation key of its predecessor".into())
}

/// Verify a did:plc audit log and return the chain-tip identity.
///
/// Enforced (self-certifying): genesis hash == DID suffix; every op's `prev` names its
/// predecessor's exact CID; every op verifies against a rotation key of the op it builds
/// on (genesis: its own keys); nullified branches were nullified by a strictly
/// higher-priority key within the recovery window; a tombstone ends the chain.
/// Directory-attested (mirror-trusted, per the §8 trust table): log order, `createdAt`,
/// nullification flags.
pub fn verify_chain(did: &str, ops: &[PlcOpWitness]) -> Result<VerifiedIdentity, String> {
    if ops.is_empty() {
        return Err("empty plc audit log".into());
    }
    let suffix = did.strip_prefix("did:plc:").ok_or("not a did:plc")?;

    let decoded: Vec<Op> =
        ops.iter().map(|w| decode_op(&w.op_bytes)).collect::<Result<Vec<_>, _>>()?;

    // Genesis: hash-of-signed-op IS the DID; self-signed by its own rotation keys.
    let genesis = &decoded[0];
    if genesis.prev.is_some() {
        return Err("genesis op has prev".into());
    }
    let did_hash = base32_lower(&genesis.full_hash);
    if &did_hash[..24] != suffix {
        return Err(format!("genesis hash {} != did suffix {}", &did_hash[..24], suffix));
    }
    verify_op_sig(&genesis.rotation_keys, &genesis.unsigned_bytes, &genesis.sig_b64)
        .map_err(|e| format!("genesis: {e}"))?;

    // Walk the log in directory order, maintaining the active tip.
    let mut cid_to_idx: BTreeMap<&str, usize> = BTreeMap::new();
    cid_to_idx.insert(genesis.cid_str.as_str(), 0);
    let mut tip: usize = 0;
    let mut prev_tip: Option<usize> = None;

    for (i, op) in decoded.iter().enumerate().skip(1) {
        let prev_cid = op.prev.as_deref().ok_or("non-genesis op missing prev")?;
        let pred_idx = *cid_to_idx
            .get(prev_cid)
            .ok_or_else(|| format!("op {i} prev {prev_cid} not found in log"))?;
        let pred = &decoded[pred_idx];

        // Signature authority comes from the PREDECESSOR's rotation keys.
        let signer_priority = verify_op_sig(&pred.rotation_keys, &op.unsigned_bytes, &op.sig_b64)
            .map_err(|e| format!("op {i}: {e}"))?;

        if ops[i].nullified {
            // A nullified op sits on an abandoned branch; nothing else to do — its
            // legitimacy to have existed was checked above.
            cid_to_idx.insert(op.cid_str.as_str(), i);
            continue;
        }

        if pred_idx != tip {
            // Fork: this op abandons everything after pred_idx. Every abandoned op must be
            // flagged nullified, the fork signer must outrank the abandoned branch's first
            // signer, and the fork must land within the recovery window.
            let mut branch_first: Option<usize> = None;
            let mut cursor = tip;
            loop {
                if cursor == pred_idx {
                    break;
                }
                if !ops[cursor].nullified && cursor != 0 {
                    return Err(format!(
                        "op {i} forks past non-nullified op {cursor} — invalid nullification"
                    ));
                }
                branch_first = Some(cursor);
                let c_prev = decoded[cursor].prev.as_deref().ok_or("branch reached genesis")?;
                cursor = *cid_to_idx.get(c_prev).ok_or("branch prev missing")?;
            }
            if let Some(bf) = branch_first {
                let branch_sig_priority = verify_op_sig(
                    &pred.rotation_keys,
                    &decoded[bf].unsigned_bytes,
                    &decoded[bf].sig_b64,
                )
                .unwrap_or(usize::MAX);
                if signer_priority >= branch_sig_priority {
                    return Err(format!(
                        "op {i} nullifies a branch signed by an equal/higher-priority key"
                    ));
                }
                if ops[i].created_at.saturating_sub(ops[bf].created_at) > RECOVERY_WINDOW_SECS {
                    return Err(format!("op {i} nullifies outside the 72h recovery window"));
                }
            }
            prev_tip = Some(pred_idx);
        } else {
            prev_tip = Some(tip);
        }
        tip = i;
        cid_to_idx.insert(op.cid_str.as_str(), i);
    }

    let tip_op = &decoded[tip];
    if tip_op.typ == "plc_tombstone" {
        return Err("did is tombstoned".into());
    }
    let atproto_key = tip_op
        .atproto_key
        .as_deref()
        .ok_or("chain tip has no atproto verification method")
        .and_then(|k| parse_multikey(k).map_err(|_| "chain tip atproto key unparseable"))
        .map_err(|e| e.to_string())?;

    // 72h-provisional: expose the previous tip's key; the caller accepts it while the tip
    // is younger than the window relative to the epoch's deterministic "now".
    let provisional_prev_key = prev_tip
        .and_then(|p| decoded[p].atproto_key.as_deref().map(parse_multikey))
        .and_then(|r| r.ok());

    Ok(VerifiedIdentity { atproto_key, provisional_prev_key, tip_created_at: ops[tip].created_at })
}
