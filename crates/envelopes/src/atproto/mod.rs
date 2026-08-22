//! Envelope 1 — the atproto repo commit (OFFCHAIN_ATTESTATIONS_ZK §4.2, HYPERCERTS plan §5).
//!
//! The anchored head is the sha2-256 digest of the signed commit block (the commit CID's
//! multihash digest). Given the head + witness (the repo CAR at that commit, the DID's PLC
//! audit log, and the collection ranges to walk), this module either yields the COMPLETE
//! record set of those collections — content-addressed, signature-bound to the DID's
//! chain-verified key, canonical-structure-checked, fail-closed on any missing block — or
//! fails, tripping rule Φ for the node.
//!
//! Record SEMANTICS (which records become edges, with what weights) are per-program and
//! live in the program crates (hypercerts-core at M4); this module's contract stops at
//! "authenticated complete records per collection".

pub mod carset;
pub mod commit;
pub mod mst;
pub mod plc;

use alloy_primitives::{keccak256, B256};
use serde::{Deserialize, Serialize};

use crate::EnvelopeError;

/// One authenticated record from a walked collection range.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AtprotoRecord {
    /// The full MST key, `<collection>/<rkey>`.
    pub key: Vec<u8>,
    /// The record block's CID (content-verified against the CAR).
    pub cid: ipld_core::cid::Cid,
    /// The record's raw dag-cbor bytes.
    pub record_bytes: Vec<u8>,
}

/// The witness behind one anchored atproto head.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct AtprotoWitness {
    /// The repo owner's DID (`nodeId = keccak256(did bytes)`).
    pub did: String,
    /// The full repo CAR at the anchored commit (commit + MST nodes + records).
    #[serde(with = "serde_bytes_hex")]
    pub car: Vec<u8>,
    /// The DID's PLC audit log (self-certifying ops + directory-attested metadata).
    pub plc_ops: Vec<plc::PlcOpWitness>,
}

/// The canonical node id of a DID node: `keccak256(did string bytes)`.
pub fn did_node_id(did: &str) -> B256 {
    keccak256(did.as_bytes())
}

/// Verify one anchored atproto head and walk the given collection NSIDs.
///
/// `now` is the epoch's deterministic timestamp (max witnessed anchor time) — it drives the
/// 72h-provisional key rule. Returns records grouped in one vec, MST-ordered.
pub fn verify(
    node_id: B256,
    head: B256,
    now: u64,
    collections: &[&str],
    witness: &AtprotoWitness,
) -> Result<Vec<AtprotoRecord>, EnvelopeError> {
    // 1. Identity binding: the witnessed DID is the anchored node.
    if did_node_id(&witness.did) != node_id {
        return Err(EnvelopeError::Malformed);
    }

    // 2. Parse the CAR (content-addressing enforced per block).
    let car = carset::Car::parse(&witness.car).map_err(|_| EnvelopeError::Malformed)?;
    let root = *car.roots.first().ok_or(EnvelopeError::Malformed)?;

    // 3. The anchored head is the commit block's sha2-256 digest.
    let commit_bytes = car.get(&root).ok_or(EnvelopeError::HeadMismatch)?;
    let commit_digest: [u8; 32] = {
        use sha2::{Digest, Sha256};
        Sha256::digest(commit_bytes).into()
    };
    if B256::from(commit_digest) != head {
        return Err(EnvelopeError::HeadMismatch);
    }

    // 4. Decode the commit; it must speak for the witnessed DID.
    let cf = commit::decode_commit(commit_bytes).map_err(|_| EnvelopeError::Malformed)?;
    if cf.did != witness.did || cf.version != 3 {
        return Err(EnvelopeError::Malformed);
    }

    // 5. PLC chain → signing key; verify the commit signature (72h-provisional: the
    //    previous key is also accepted while the tip binding is young).
    let ident = plc::verify_chain(&witness.did, &witness.plc_ops)
        .map_err(|_| EnvelopeError::BadHeadSignature)?;
    let mut sig_ok =
        commit::verify_commit_sig(&ident.atproto_key, &cf.unsigned_bytes, &cf.sig).is_ok();
    if !sig_ok {
        if let Some(prev) = &ident.provisional_prev_key {
            let provisional = now.saturating_sub(ident.tip_created_at) < plc::RECOVERY_WINDOW_SECS;
            if provisional && commit::verify_commit_sig(prev, &cf.unsigned_bytes, &cf.sig).is_ok() {
                sig_ok = true;
            }
        }
    }
    if !sig_ok {
        return Err(EnvelopeError::BadHeadSignature);
    }

    // 6. MST multi-range walk: one contiguous range per collection, canonical invariants
    //    enforced, fail-closed on any referenced-but-missing block. Range = [nsid + "/",
    //    nsid + "0") — '/'+1 == '0'.
    let mut out: Vec<AtprotoRecord> = Vec::new();
    for nsid in collections {
        let lo = format!("{nsid}/").into_bytes();
        let hi = format!("{nsid}0").into_bytes();
        let walk = mst::Walker::range(&car, lo, hi)
            .run(&cf.data)
            .map_err(|_| EnvelopeError::HeadMismatch)?; // missing block / bad structure ⇒ fail closed
        for (key, cid) in walk.entries {
            let record_bytes = car.get(&cid).ok_or(EnvelopeError::HeadMismatch)?.clone();
            out.push(AtprotoRecord { key, cid, record_bytes });
        }
    }
    Ok(out)
}

/// Minimal `serde` helper so byte fields round-trip as `0x`-hex in fixtures.
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
