//! Hypercerts fixture walker (GOAL.md M1, last fixture).
//!
//! Runs the EXISTING spike/mst walker (car/mst/verify modules included verbatim
//! by path) over the locally-generated Hypercerts repo CAR:
//!   1. CAR parse + content-address check
//!   2. commit decode + signature verify vs PLC #atproto key
//!   3. full canonical MST walk, parity vs the PDS's own {key -> valueCID} table
//!   4. range walks over each of the seven §2 collection prefixes
//!   5. dag-cbor decode each hypercerts record, print load-bearing §2 fields
//!   6. host-side EIP-712 recovery of the app.certified.link.evm proof (k256
//!      ecrecover over the keccak digest) -> must equal the record's address.

// Reuse the already-validated spike/mst modules unchanged.
#[path = "../../../mst/src/car.rs"]
mod car;
#[path = "../../../mst/src/mst.rs"]
mod mst;
#[path = "../../../mst/src/verify.rs"]
mod verify;

use car::Car;
use ipld_core::cid::Cid;
use ipld_core::ipld::Ipld;
use sha3::{Digest as _, Keccak256};
use std::collections::BTreeMap;
use std::path::Path;

const COLLECTIONS: &[&str] = &[
    "app.certified.graph.follow",
    "app.certified.badge.award",
    "app.certified.badge.response",
    "org.hypercerts.context.evaluation",
    "org.hypercerts.claim.activity",
    "org.hypercerts.context.acknowledgement",
    "app.certified.link.evm",
];

fn plc_atproto_key(plc_json: &str) -> Result<String, String> {
    let log: serde_json::Value = serde_json::from_str(plc_json).map_err(|e| e.to_string())?;
    let arr = log.as_array().ok_or("plc log not array")?;
    for entry in arr.iter().rev() {
        if entry.get("nullified").and_then(|v| v.as_bool()) == Some(true) {
            continue;
        }
        if let Some(k) = entry
            .get("operation")
            .and_then(|o| o.get("verificationMethods"))
            .and_then(|v| v.get("atproto"))
            .and_then(|v| v.as_str())
        {
            return Ok(k.to_string());
        }
    }
    Err("no atproto key in plc log".into())
}

fn load_ground_truth(path: &Path) -> BTreeMap<String, String> {
    let txt = std::fs::read_to_string(path).unwrap();
    txt.lines()
        .filter_map(|l| {
            let mut it = l.splitn(2, '\t');
            Some((it.next()?.to_string(), it.next()?.to_string()))
        })
        .collect()
}

// ---- tiny Ipld accessors ----
fn as_map(v: &Ipld) -> Option<&BTreeMap<String, Ipld>> {
    match v {
        Ipld::Map(m) => Some(m),
        _ => None,
    }
}
fn field<'a>(v: &'a Ipld, k: &str) -> Option<&'a Ipld> {
    as_map(v).and_then(|m| m.get(k))
}
fn as_str(v: &Ipld) -> Option<&str> {
    match v {
        Ipld::String(s) => Some(s),
        _ => None,
    }
}
fn as_bool(v: &Ipld) -> Option<bool> {
    match v {
        Ipld::Bool(b) => Some(*b),
        _ => None,
    }
}
/// strongRef {uri, cid(Link)} -> "cid" string
fn strongref_cid(v: &Ipld) -> Option<String> {
    match field(v, "cid")? {
        Ipld::Link(c) => Some(c.to_string()),
        Ipld::String(s) => Some(s.clone()),
        _ => None,
    }
}

fn decode_record(car: &Car, cid: &Cid) -> Result<Ipld, String> {
    let bytes = car.get(cid).ok_or_else(|| format!("record {cid} missing"))?;
    serde_ipld_dagcbor::from_slice(bytes).map_err(|e| format!("decode {cid}: {e}"))
}

// ---- EIP-712 ----
fn keccak(bytes: &[u8]) -> [u8; 32] {
    let mut h = Keccak256::new();
    h.update(bytes);
    h.finalize().into()
}
/// decimal string -> 32-byte big-endian (uint256)
fn dec_to_u256(s: &str) -> Result<[u8; 32], String> {
    let mut out = [0u8; 32];
    for ch in s.bytes() {
        if !ch.is_ascii_digit() {
            return Err(format!("non-decimal digit in {s:?}"));
        }
        let d = (ch - b'0') as u16;
        // out = out*10 + d
        let mut carry = d;
        for byte in out.iter_mut().rev() {
            let v = (*byte as u16) * 10 + carry;
            *byte = (v & 0xff) as u8;
            carry = v >> 8;
        }
        if carry != 0 {
            return Err("uint256 overflow".into());
        }
    }
    Ok(out)
}
/// 0x-hex address -> 32-byte left-padded
fn addr_to_word(addr: &str) -> Result<[u8; 32], String> {
    let a = addr.strip_prefix("0x").unwrap_or(addr);
    let raw = hex::decode(a).map_err(|e| format!("addr hex: {e}"))?;
    if raw.len() != 20 {
        return Err(format!("addr not 20 bytes: {}", raw.len()));
    }
    let mut out = [0u8; 32];
    out[12..].copy_from_slice(&raw);
    Ok(out)
}

/// Recompute the EIP-712 digest for app.certified.link.evm#eip712Message and
/// ecrecover the signer address. Returns (digest, recovered_address_0x).
fn eip712_recover(
    did: &str,
    evm_address: &str,
    chain_id: &str,
    timestamp: &str,
    nonce: &str,
    sig_hex: &str,
) -> Result<([u8; 32], [u8; 32], String), String> {
    // --- domain: EIP712Domain(string name,string version,uint256 chainId) ---
    let domain_type = "EIP712Domain(string name,string version,uint256 chainId)";
    let mut dom = Vec::new();
    dom.extend_from_slice(&keccak(domain_type.as_bytes()));
    dom.extend_from_slice(&keccak(b"IdentityLink")); // name
    dom.extend_from_slice(&keccak(b"1")); // version
    dom.extend_from_slice(&dec_to_u256(chain_id)?); // chainId
    let domain_separator = keccak(&dom);

    // --- struct: LinkAttestation(string did,address evmAddress,uint256 chainId,uint256 timestamp,uint256 nonce) ---
    let struct_type =
        "LinkAttestation(string did,address evmAddress,uint256 chainId,uint256 timestamp,uint256 nonce)";
    let mut st = Vec::new();
    st.extend_from_slice(&keccak(struct_type.as_bytes()));
    st.extend_from_slice(&keccak(did.as_bytes())); // string did
    st.extend_from_slice(&addr_to_word(evm_address)?); // address evmAddress
    st.extend_from_slice(&dec_to_u256(chain_id)?); // uint256 chainId
    st.extend_from_slice(&dec_to_u256(timestamp)?); // uint256 timestamp
    st.extend_from_slice(&dec_to_u256(nonce)?); // uint256 nonce
    let struct_hash = keccak(&st);

    // --- digest = keccak(0x1901 || domainSeparator || structHash) ---
    let mut pre = Vec::with_capacity(66);
    pre.extend_from_slice(&[0x19, 0x01]);
    pre.extend_from_slice(&domain_separator);
    pre.extend_from_slice(&struct_hash);
    let digest = keccak(&pre);

    // --- ecrecover (k256) ---
    let sig_raw = hex::decode(sig_hex.strip_prefix("0x").unwrap_or(sig_hex))
        .map_err(|e| format!("sig hex: {e}"))?;
    if sig_raw.len() != 65 {
        return Err(format!("expected 65-byte sig, got {}", sig_raw.len()));
    }
    use k256::ecdsa::{RecoveryId, Signature, VerifyingKey};
    let sig = Signature::from_slice(&sig_raw[..64]).map_err(|e| format!("sig parse: {e}"))?;
    let v = sig_raw[64];
    let rec_byte = if v >= 27 { v - 27 } else { v };
    let recid = RecoveryId::from_byte(rec_byte).ok_or("bad recovery id")?;
    let vk = VerifyingKey::recover_from_prehash(&digest, &sig, recid)
        .map_err(|e| format!("recover: {e}"))?;
    // address = keccak(uncompressed pubkey[1..65])[12..]
    let ep = vk.to_encoded_point(false);
    let pubkey = ep.as_bytes(); // 65 bytes, 0x04 || X || Y
    let ah = keccak(&pubkey[1..]);
    let addr = format!("0x{}", hex::encode(&ah[12..]));
    Ok((digest, domain_separator, addr))
}

fn run(dir: &Path) -> Result<(), String> {
    let car_bytes = std::fs::read(dir.join("hypercerts.car")).map_err(|e| e.to_string())?;
    let plc = std::fs::read_to_string(dir.join("hypercerts.plc.json")).map_err(|e| e.to_string())?;

    // 1. CAR parse + content addressing
    let car = Car::parse(&car_bytes)?;
    let root = car.roots[0];
    println!(
        "CAR: {} bytes, {} blocks, root {}",
        car_bytes.len(),
        car.num_blocks,
        root
    );

    // 2. commit decode + signature verify
    let commit_block = car.get(&root).ok_or("commit block absent")?;
    if car::cid_dagcbor(commit_block) != root {
        return Err("commit CID != sha256(commit block)".into());
    }
    let cf = verify::decode_commit(commit_block)?;
    let key_str = plc_atproto_key(&plc)?;
    let mk = verify::parse_multikey(&key_str)?;
    verify::verify_commit_sig(&mk, &cf.unsigned_bytes, &cf.sig)?;
    println!(
        "commit: did={} version={} rev={} data={}",
        cf.did, cf.version, cf.rev, cf.data
    );
    println!(
        "signature: VERIFIED curve={:?} key={} (low-S, 64-byte compact)",
        mk.curve, key_str
    );

    // 3. full MST walk + parity vs the PDS's own key->cid table
    let out = mst::Walker::full(&car).run(&cf.data)?;
    println!(
        "MST full walk: {} records across {} nodes",
        out.entries.len(),
        out.nodes_visited
    );
    let mut missing = 0usize;
    for (_k, v) in &out.entries {
        if car.get(v).is_none() {
            missing += 1;
        }
    }
    if missing > 0 {
        return Err(format!("{missing} record blocks missing (fail-closed)"));
    }
    let gt = load_ground_truth(&dir.join("hypercerts.records.tsv"));
    let mine: BTreeMap<String, String> = out
        .entries
        .iter()
        .map(|(k, v)| (String::from_utf8_lossy(k).into_owned(), v.to_string()))
        .collect();
    if mine.len() != gt.len() {
        return Err(format!("count mismatch: rust {} vs pds {}", mine.len(), gt.len()));
    }
    for (k, v) in &gt {
        match mine.get(k) {
            Some(mv) if mv == v => {}
            _ => return Err(format!("DIVERGENCE key={k}: pds={v} rust={:?}", mine.get(k))),
        }
    }
    println!(
        "PARITY vs PDS applyWrites/listRecords table: EXACT ({} records, key+valueCID identical)",
        gt.len()
    );

    // 4. range walk over each of the seven §2 collection prefixes
    println!("\n-- range walks (one contiguous [nsid/ .. nsid0) range per §2 collection) --");
    for col in COLLECTIONS {
        let lo = format!("{col}/").into_bytes();
        let hi = format!("{col}0").into_bytes();
        let rout = mst::Walker::range(&car, lo.clone(), hi.clone()).run(&cf.data)?;
        let expect = out
            .entries
            .iter()
            .filter(|(k, _)| k.as_slice() >= lo.as_slice() && k.as_slice() < hi.as_slice())
            .count();
        if rout.entries.len() != expect {
            return Err(format!(
                "range {col}: {} vs {} expected",
                rout.entries.len(),
                expect
            ));
        }
        println!(
            "  {col}: {} record(s) via {} node(s) — matches full-walk filter",
            rout.entries.len(),
            rout.nodes_visited
        );
    }

    // 5. dag-cbor decode each record; print load-bearing §2 fields
    println!("\n-- decoded load-bearing fields (proves records round-trip the real MST) --");
    let mut by_key: BTreeMap<String, Cid> = BTreeMap::new();
    for (k, v) in &out.entries {
        by_key.insert(String::from_utf8_lossy(k).into_owned(), *v);
    }
    for (k, cid) in &by_key {
        let rec = decode_record(&car, cid)?;
        let col = k.split('/').next().unwrap();
        print!("  [{k}] ");
        match col {
            "app.certified.graph.follow" => {
                println!(
                    "subject={} createdAt={}",
                    field(&rec, "subject").and_then(as_str).unwrap_or("?"),
                    field(&rec, "createdAt").and_then(as_str).unwrap_or("?")
                );
            }
            "app.certified.badge.award" => {
                let subj = field(&rec, "subject").unwrap();
                let subj_desc = match field(subj, "did").and_then(as_str) {
                    Some(d) => format!("did={d}"),
                    None => format!("strongRef.cid={}", strongref_cid(subj).unwrap_or_default()),
                };
                println!(
                    "badge.cid={} subject[{}] createdAt={}",
                    field(&rec, "badge").and_then(strongref_cid).unwrap_or_default(),
                    subj_desc,
                    field(&rec, "createdAt").and_then(as_str).unwrap_or("?")
                );
            }
            "app.certified.badge.response" => {
                println!(
                    "badgeAward.cid={} response={} weight={}",
                    field(&rec, "badgeAward").and_then(strongref_cid).unwrap_or_default(),
                    field(&rec, "response").and_then(as_str).unwrap_or("?"),
                    field(&rec, "weight").and_then(as_str).unwrap_or("(none)")
                );
            }
            "org.hypercerts.context.evaluation" => {
                let score = field(&rec, "score");
                let (mn, mx, val) = match score {
                    Some(s) => (
                        field(s, "min").and_then(as_str).unwrap_or("?").to_string(),
                        field(s, "max").and_then(as_str).unwrap_or("?").to_string(),
                        field(s, "value").and_then(as_str).unwrap_or("?").to_string(),
                    ),
                    None => ("(none)".into(), "".into(), "".into()),
                };
                let evals = field(&rec, "evaluators")
                    .and_then(|v| match v {
                        Ipld::List(l) => Some(
                            l.iter()
                                .filter_map(|e| field(e, "did").and_then(as_str))
                                .collect::<Vec<_>>()
                                .join(","),
                        ),
                        _ => None,
                    })
                    .unwrap_or_default();
                println!(
                    "subject.cid={} score{{min={mn} max={mx} value={val}}} evaluators=[{evals}]",
                    field(&rec, "subject").and_then(strongref_cid).unwrap_or_default(),
                );
            }
            "org.hypercerts.claim.activity" => {
                let contribs = field(&rec, "contributors")
                    .and_then(|v| match v {
                        Ipld::List(l) => Some(
                            l.iter()
                                .map(|c| {
                                    let id = field(c, "contributorIdentity")
                                        .and_then(|ci| field(ci, "identity"))
                                        .and_then(as_str)
                                        .unwrap_or("?");
                                    let w = field(c, "contributionWeight")
                                        .and_then(as_str)
                                        .unwrap_or("?");
                                    format!("{id}:{w}")
                                })
                                .collect::<Vec<_>>()
                                .join(", "),
                        ),
                        _ => None,
                    })
                    .unwrap_or_default();
                println!(
                    "title={:?} contributors=[{contribs}]",
                    field(&rec, "title").and_then(as_str).unwrap_or("?"),
                );
            }
            "org.hypercerts.context.acknowledgement" => {
                println!(
                    "subject.cid={} acknowledged={}",
                    field(&rec, "subject").and_then(strongref_cid).unwrap_or_default(),
                    field(&rec, "acknowledged").and_then(as_bool).unwrap_or(false)
                );
            }
            "app.certified.link.evm" => {
                let proof = field(&rec, "proof").ok_or("link.evm missing proof")?;
                let msg = field(proof, "message").ok_or("link.evm missing proof.message")?;
                let sig = field(proof, "signature").and_then(as_str).ok_or("no sig")?;
                let did = field(msg, "did").and_then(as_str).ok_or("no did")?;
                let evm = field(msg, "evmAddress").and_then(as_str).ok_or("no evm")?;
                let chain = field(msg, "chainId").and_then(as_str).ok_or("no chain")?;
                let ts = field(msg, "timestamp").and_then(as_str).ok_or("no ts")?;
                let nonce = field(msg, "nonce").and_then(as_str).ok_or("no nonce")?;
                let addr = field(&rec, "address").and_then(as_str).ok_or("no addr")?;
                println!(
                    "address={addr} msg{{did={did} evmAddress={evm} chainId={chain} timestamp={ts} nonce={nonce}}}"
                );
                // 6. host-side EIP-712 recovery
                let (digest, dom_sep, recovered) =
                    eip712_recover(did, evm, chain, ts, nonce, sig)?;
                let ok = recovered.eq_ignore_ascii_case(addr);
                println!(
                    "      EIP-712: domainSeparator=0x{}",
                    hex::encode(dom_sep)
                );
                println!("      EIP-712: digest=0x{}", hex::encode(digest));
                println!(
                    "      EIP-712: ecrecover -> {recovered}  vs record.address {addr}  => {}",
                    if ok { "MATCH ✓" } else { "MISMATCH ✗" }
                );
                if !ok {
                    return Err("EIP-712 recovered address != record address".into());
                }
                // in-record consistency: message.evmAddress must equal top-level address
                if !evm.eq_ignore_ascii_case(addr) {
                    return Err("message.evmAddress != record.address".into());
                }
                // and the bound DID must equal the repo owner (DID-side consent)
                if did != cf.did {
                    return Err("link.evm message.did != repo owner did".into());
                }
                println!("      binding consistency: message.evmAddress==address, message.did==repo owner ✓");
            }
            _ => println!("(unrecognized collection)"),
        }
    }

    Ok(())
}

fn main() {
    let dir = std::env::args()
        .nth(1)
        .unwrap_or_else(|| "../fixtures".to_string());
    let dir = Path::new(&dir);
    match run(dir) {
        Ok(()) => println!("\n==== ALL GREEN ===="),
        Err(e) => {
            println!("\n!! FAILED: {e}");
            std::process::exit(1);
        }
    }
}
