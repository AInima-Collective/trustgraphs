//! Envelope-1 CONFORMANCE suite (GOAL.md M3 exit).
//!
//! Two halves:
//!
//!   1. Canonical interop vectors — pinned against the upstream atproto test-vector repos,
//!      vendored under `test/fixtures/atproto/interop/`:
//!        * `mst/key_heights.json`      (bluesky-social/atproto-interop-tests @ 056e574) →
//!          `mst::key_layer` == atproto `HeightForKey`.
//!        * `mst/common_prefix.json`    (same repo)                                       →
//!          `mst::lcp` == atproto `CountPrefixLen`.
//!        * `crypto/signature-fixtures.json` (same repo)                                  →
//!          `commit::{parse_multikey, verify_commit_sig}`: k256+p256, low-S required,
//!          DER-encoded rejected.
//!        * `firehose/commit-proof-fixtures.json` → canonical MST trees whose ROOT CIDs
//!          were reproduced byte-for-byte by indigo's `atproto/repo/mst` (@ dfe5578) when
//!          the fixtures' CARs under `car/` were generated; here we assert our Walker
//!          ACCEPTS those canonical trees and recovers exactly the expected key set.
//!
//!   2. Crafted adversarial vectors — the ATTACK bytes are constructed here (hand-built MST
//!      nodes / synthetic PLC+commit CARs), never random: boundary fencing, illegal
//!      layer-skip, non-canonical prefix compression, reordered/duplicated entries, provable
//!      absence, an equivocation pair, and an end-to-end p256 repo.
//!
//! See `test/fixtures/atproto/interop/README.md` for provenance + the Go generator.

use envelopes::atproto::carset::{cid_dagcbor, Car};
use envelopes::atproto::commit::{self, Curve, Multikey};
use envelopes::atproto::mst::{self, Walker};
use envelopes::atproto::{self, plc::PlcOpWitness, AtprotoWitness};
use ipld_core::cid::Cid;
use ipld_core::ipld::Ipld;
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::path::PathBuf;

fn fixture(rel: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..").join(rel)
}
fn read_json(rel: &str) -> serde_json::Value {
    serde_json::from_str(&std::fs::read_to_string(fixture(rel)).expect(rel)).expect("json")
}

// ============================================================================
// Small codecs / builders shared by the crafted-vector tests.
// ============================================================================

/// Unsigned LEB128 varint (CAR framing).
fn uvarint(mut v: u64) -> Vec<u8> {
    let mut o = Vec::new();
    loop {
        let b = (v & 0x7f) as u8;
        v >>= 7;
        if v != 0 {
            o.push(b | 0x80);
        } else {
            o.push(b);
            break;
        }
    }
    o
}

/// base64 decode accepting BOTH standard (+/) and url (-_) alphabets, padding optional.
fn b64_decode(s: &str) -> Vec<u8> {
    let rev = |c: u8| -> Option<u32> {
        Some(match c {
            b'A'..=b'Z' => (c - b'A') as u32,
            b'a'..=b'z' => (c - b'a' + 26) as u32,
            b'0'..=b'9' => (c - b'0' + 52) as u32,
            b'+' | b'-' => 62,
            b'/' | b'_' => 63,
            _ => return None,
        })
    };
    let mut out = Vec::new();
    let (mut acc, mut bits) = (0u32, 0u32);
    for &c in s.as_bytes() {
        if c == b'=' {
            break;
        }
        let Some(v) = rev(c) else { continue };
        acc = (acc << 6) | v;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
        }
    }
    out
}

/// base64url, no padding (PLC op signatures).
fn b64url_encode(data: &[u8]) -> String {
    const A: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let mut out = String::new();
    let (mut acc, mut bits) = (0u32, 0u32);
    for &b in data {
        acc = (acc << 8) | b as u32;
        bits += 8;
        while bits >= 6 {
            bits -= 6;
            out.push(A[((acc >> bits) & 0x3f) as usize] as char);
        }
    }
    if bits > 0 {
        out.push(A[((acc << (6 - bits)) & 0x3f) as usize] as char);
    }
    out
}

/// base32 lower, no padding (RFC 4648) — the did:plc suffix encoding (mirror of plc.rs).
fn base32_lower(data: &[u8]) -> String {
    const A: &[u8; 32] = b"abcdefghijklmnopqrstuvwxyz234567";
    let mut out = String::new();
    let (mut acc, mut bits) = (0u32, 0u32);
    for &b in data {
        acc = (acc << 8) | b as u32;
        bits += 8;
        while bits >= 5 {
            bits -= 5;
            out.push(A[((acc >> bits) & 0x1f) as usize] as char);
        }
    }
    if bits > 0 {
        out.push(A[((acc << (5 - bits)) & 0x1f) as usize] as char);
    }
    out
}

/// A signing keypair for either curve, plus its did:key string.
struct SynthKey {
    curve: Curve,
    did_key: String,
    sign: Box<dyn Fn(&[u8]) -> Vec<u8>>, // signs the SHA-256 prehash of the input, low-S, 64-byte r||s
}

fn multibase_did_key(curve: Curve, compressed: &[u8]) -> String {
    let prefix: &[u8] = match curve {
        Curve::K256 => &[0xe7, 0x01],
        Curve::P256 => &[0x80, 0x24],
    };
    let mut raw = prefix.to_vec();
    raw.extend_from_slice(compressed);
    format!("did:key:z{}", bs58::encode(raw).into_string())
}

fn gen_k256(seed: [u8; 32]) -> SynthKey {
    use k256::ecdsa::signature::hazmat::PrehashSigner;
    use k256::ecdsa::{Signature, SigningKey};
    let sk = SigningKey::from_slice(&seed).unwrap();
    let compressed = sk.verifying_key().to_encoded_point(true).as_bytes().to_vec();
    let did_key = multibase_did_key(Curve::K256, &compressed);
    let signer = move |msg: &[u8]| -> Vec<u8> {
        let digest = Sha256::digest(msg);
        let mut sig: Signature = sk.sign_prehash(&digest).unwrap();
        if let Some(n) = sig.normalize_s() {
            sig = n;
        }
        sig.to_bytes().to_vec()
    };
    SynthKey { curve: Curve::K256, did_key, sign: Box::new(signer) }
}

fn gen_p256(seed: [u8; 32]) -> SynthKey {
    use p256::ecdsa::signature::hazmat::PrehashSigner;
    use p256::ecdsa::{Signature, SigningKey};
    let sk = SigningKey::from_slice(&seed).unwrap();
    let compressed = sk.verifying_key().to_encoded_point(true).as_bytes().to_vec();
    let did_key = multibase_did_key(Curve::P256, &compressed);
    let signer = move |msg: &[u8]| -> Vec<u8> {
        let digest = Sha256::digest(msg);
        let mut sig: Signature = sk.sign_prehash(&digest).unwrap();
        if let Some(n) = sig.normalize_s() {
            sig = n;
        }
        sig.to_bytes().to_vec()
    };
    SynthKey { curve: Curve::P256, did_key, sign: Box::new(signer) }
}

fn dag_cbor(v: &Ipld) -> (Cid, Vec<u8>) {
    let bytes = serde_ipld_dagcbor::to_vec(v).expect("dag-cbor encode");
    (cid_dagcbor(&bytes), bytes)
}

/// One MST entry as it appears on the wire: (prefix-len, key-suffix, value CID, right child).
struct RawEnt {
    p: usize,
    k: Vec<u8>,
    v: Cid,
    t: Option<Cid>,
}

/// Encode an MST node exactly as our `RawNode` decoder reads it: map{ "e": [..], "l"? }.
fn encode_node(left: Option<Cid>, entries: &[RawEnt]) -> (Cid, Vec<u8>) {
    let e = Ipld::List(
        entries
            .iter()
            .map(|en| {
                let mut m: BTreeMap<String, Ipld> = BTreeMap::new();
                m.insert("p".into(), Ipld::Integer(en.p as i128));
                m.insert("k".into(), Ipld::Bytes(en.k.clone()));
                m.insert("v".into(), Ipld::Link(en.v));
                m.insert("t".into(), en.t.map(Ipld::Link).unwrap_or(Ipld::Null));
                Ipld::Map(m)
            })
            .collect(),
    );
    let mut node: BTreeMap<String, Ipld> = BTreeMap::new();
    node.insert("e".into(), e);
    node.insert("l".into(), left.map(Ipld::Link).unwrap_or(Ipld::Null));
    dag_cbor(&Ipld::Map(node))
}

/// Canonical single MST node over already-sorted (key, value) pairs (prefix-compressed).
fn canonical_single_node(kv: &[(Vec<u8>, Cid)]) -> (Cid, Vec<u8>) {
    let mut ents = Vec::new();
    let mut prev: Vec<u8> = Vec::new();
    for (k, v) in kv {
        let p = mst::lcp(&prev, k);
        ents.push(RawEnt { p, k: k[p..].to_vec(), v: *v, t: None });
        prev = k.clone();
    }
    encode_node(None, &ents)
}

/// A dummy value CID (a raw record block never fetched by structure-only Walker tests).
fn dummy_value(tag: &str) -> Cid {
    cid_dagcbor(tag.as_bytes())
}

/// Find a key `prefix{n}` whose `key_layer` equals `want`.
fn find_key_at_layer(prefix: &str, want: u32) -> Vec<u8> {
    for n in 0u64.. {
        let k = format!("{prefix}{n}").into_bytes();
        if mst::key_layer(&k) == want {
            return k;
        }
    }
    unreachable!()
}

/// CARv1 bytes with `root` as the sole root and `blocks` as the body.
fn car_bytes(root: Cid, blocks: &[(Cid, Vec<u8>)]) -> Vec<u8> {
    let mut header: BTreeMap<String, Ipld> = BTreeMap::new();
    header.insert("roots".into(), Ipld::List(vec![Ipld::Link(root)]));
    header.insert("version".into(), Ipld::Integer(1));
    let hbytes = serde_ipld_dagcbor::to_vec(&Ipld::Map(header)).unwrap();
    let mut out = uvarint(hbytes.len() as u64);
    out.extend_from_slice(&hbytes);
    for (cid, data) in blocks {
        let mut framed = cid.to_bytes();
        framed.extend_from_slice(data);
        out.extend_from_slice(&uvarint(framed.len() as u64));
        out.extend_from_slice(&framed);
    }
    out
}

/// Build a self-certifying did:plc genesis op (modern `plc_operation`) whose tip #atproto key
/// is `atproto_key`, self-signed by `rotation_key`. We choose the genesis, so we control the
/// DID (its suffix is the base32 of the signed op's SHA-256).
fn build_plc_genesis(rotation_key: &SynthKey, atproto_key: &SynthKey) -> (String, PlcOpWitness) {
    let mut vm: BTreeMap<String, Ipld> = BTreeMap::new();
    vm.insert("atproto".into(), Ipld::String(atproto_key.did_key.clone()));

    let mut base: BTreeMap<String, Ipld> = BTreeMap::new();
    base.insert("type".into(), Ipld::String("plc_operation".into()));
    base.insert("prev".into(), Ipld::Null);
    base.insert(
        "rotationKeys".into(),
        Ipld::List(vec![Ipld::String(rotation_key.did_key.clone())]),
    );
    base.insert("verificationMethods".into(), Ipld::Map(vm));
    base.insert("alsoKnownAs".into(), Ipld::List(vec![]));
    base.insert("services".into(), Ipld::Map(BTreeMap::new()));

    // sign the op sans-sig, canonically encoded
    let unsigned = serde_ipld_dagcbor::to_vec(&Ipld::Map(base.clone())).unwrap();
    let sig = (rotation_key.sign)(&unsigned);
    let mut full = base;
    full.insert("sig".into(), Ipld::String(b64url_encode(&sig)));
    let op_bytes = serde_ipld_dagcbor::to_vec(&Ipld::Map(full)).unwrap();

    let did = format!("did:plc:{}", &base32_lower(&Sha256::digest(&op_bytes))[..24]);
    let witness = PlcOpWitness { op_bytes, created_at: 1_600_000_000, nullified: false };
    (did, witness)
}

/// Build a full signed atproto repo CAR (single MST node over `records`) + its anchored head.
/// `records`: (full MST key, record dag-cbor bytes).
fn build_repo(
    did: &str,
    atproto_key: &SynthKey,
    rev: &str,
    records: &[(Vec<u8>, Vec<u8>)],
) -> (alloy_primitives::B256, Vec<u8>) {
    let mut blocks: Vec<(Cid, Vec<u8>)> = Vec::new();
    let mut kv: Vec<(Vec<u8>, Cid)> = Vec::new();
    for (key, rec) in records {
        let (rc, rb) = (cid_dagcbor(rec), rec.clone());
        blocks.push((rc, rb));
        kv.push((key.clone(), rc));
    }
    kv.sort();
    let (node_cid, node_bytes) = canonical_single_node(&kv);
    blocks.push((node_cid, node_bytes));

    // unsigned commit (canonical), sign, then full commit
    let mut c: BTreeMap<String, Ipld> = BTreeMap::new();
    c.insert("did".into(), Ipld::String(did.into()));
    c.insert("version".into(), Ipld::Integer(3));
    c.insert("data".into(), Ipld::Link(node_cid));
    c.insert("rev".into(), Ipld::String(rev.into()));
    c.insert("prev".into(), Ipld::Null);
    let unsigned = serde_ipld_dagcbor::to_vec(&Ipld::Map(c.clone())).unwrap();
    let sig = (atproto_key.sign)(&unsigned);
    c.insert("sig".into(), Ipld::Bytes(sig));
    let (commit_cid, commit_bytes) = dag_cbor(&Ipld::Map(c));
    let head = alloy_primitives::B256::from(<[u8; 32]>::from(Sha256::digest(&commit_bytes)));
    blocks.insert(0, (commit_cid, commit_bytes));

    (head, car_bytes(commit_cid, &blocks))
}

/// A trivial dag-cbor record blob.
fn record(ty: &str, rkey_seed: &str) -> Vec<u8> {
    let mut m: BTreeMap<String, Ipld> = BTreeMap::new();
    m.insert("$type".into(), Ipld::String(ty.into()));
    m.insert("seed".into(), Ipld::String(rkey_seed.into()));
    serde_ipld_dagcbor::to_vec(&Ipld::Map(m)).unwrap()
}

// ============================================================================
// PART 1 — canonical interop vectors
// ============================================================================

/// `mst::key_layer` == atproto `HeightForKey`, pinned against `mst/key_heights.json`.
#[test]
fn conformance_key_heights() {
    let v = read_json("test/fixtures/atproto/interop/key_heights.json");
    let mut n = 0;
    for e in v.as_array().unwrap() {
        let key = e["key"].as_str().unwrap();
        let want = e["height"].as_u64().unwrap() as u32;
        assert_eq!(mst::key_layer(key.as_bytes()), want, "key_layer mismatch for {key:?}");
        n += 1;
    }
    assert_eq!(n, 9);
}

/// `mst::lcp` == atproto `CountPrefixLen`, pinned against `mst/common_prefix.json`.
#[test]
fn conformance_common_prefix() {
    let v = read_json("test/fixtures/atproto/interop/common_prefix.json");
    let mut n = 0;
    for e in v.as_array().unwrap() {
        let l = e["left"].as_str().unwrap().as_bytes();
        let r = e["right"].as_str().unwrap().as_bytes();
        let want = e["len"].as_u64().unwrap() as usize;
        assert_eq!(mst::lcp(l, r), want, "lcp mismatch {l:?} {r:?}");
        assert_eq!(mst::lcp(r, l), want, "lcp asymmetry {l:?} {r:?}");
        n += 1;
    }
    assert_eq!(n, 13);
}

/// `commit::{parse_multikey, verify_commit_sig}` against the canonical crypto interop vectors:
/// valid low-S k256+p256 verify; high-S and DER-encoded signatures are rejected.
#[test]
fn conformance_signature_fixtures() {
    let v = read_json("test/fixtures/atproto/interop/signature-fixtures.json");
    let mut seen_low_s = 0;
    let mut seen_high_s = 0;
    let mut seen_der = 0;
    for e in v.as_array().unwrap() {
        let msg = b64_decode(e["messageBase64"].as_str().unwrap());
        let sig = b64_decode(e["signatureBase64"].as_str().unwrap());
        let mk: Multikey = commit::parse_multikey(e["publicKeyDid"].as_str().unwrap()).unwrap();
        // sanity: multicodec curve matches the algorithm tag.
        match e["algorithm"].as_str().unwrap() {
            "ES256" => assert_eq!(mk.curve, Curve::P256),
            "ES256K" => assert_eq!(mk.curve, Curve::K256),
            other => panic!("unknown alg {other}"),
        }
        let ok = commit::verify_commit_sig(&mk, &msg, &sig).is_ok();
        let want = e["validSignature"].as_bool().unwrap();
        assert_eq!(ok, want, "{}", e["comment"].as_str().unwrap());
        let tags = e["tags"].as_array().unwrap();
        if tags.is_empty() {
            seen_low_s += 1;
        } else if tags.iter().any(|t| t == "high-s") {
            seen_high_s += 1;
        } else if tags.iter().any(|t| t == "der-encoded") {
            seen_der += 1;
        }
    }
    // both curves are covered in every class.
    assert_eq!((seen_low_s, seen_high_s, seen_der), (2, 2, 2));
}

/// Canonical atproto MST trees (root CIDs reproduced by indigo `atproto/repo/mst`; see the
/// commit-proof interop vectors) are ACCEPTED by our Walker and yield exactly the committed
/// key set — the "valid vectors verify" side of conformance.
#[test]
fn conformance_canonical_trees_walk_exact() {
    for (car_file, want) in [
        (
            "two_deep_split.car",
            vec!["A0/374913", "B1/986427", "C0/451630", "E0/670489", "F1/085263", "G0/765327"],
        ),
        ("neighbor_two_layers_down.car", vec!["A0/374913", "B2/827649", "C0/451630"]),
    ] {
        let bytes =
            std::fs::read(fixture(&format!("test/fixtures/atproto/interop/car/{car_file}"))).unwrap();
        let car = Car::parse(&bytes).expect("canonical CAR parses (content-addressed)");
        let walk = Walker::full(&car).run(&car.roots[0]).expect("canonical tree accepted");
        let got: Vec<String> =
            walk.entries.iter().map(|(k, _)| String::from_utf8_lossy(k).into()).collect();
        assert_eq!(got, want, "{car_file}");
    }
}

// ============================================================================
// PART 2 — crafted adversarial vectors
// ============================================================================

/// 2a. Boundary fencing: for a battery of ranges whose edges sit immediately adjacent to real
/// keys (in different subtrees of the canonical `two_deep_split` tree), the range walk equals
/// the full walk filtered by `[lo, hi)` — it neither over- nor under-collects, and the pruning
/// of whole subtrees does not drop an in-range key nor keep an out-of-range one.
#[test]
fn adversarial_boundary_fencing() {
    let bytes =
        std::fs::read(fixture("test/fixtures/atproto/interop/car/two_deep_split.car")).unwrap();
    let car = Car::parse(&bytes).unwrap();
    let root = car.roots[0];
    let full = Walker::full(&car).run(&root).unwrap().entries;

    let bump = |k: &str, up: bool| -> Vec<u8> {
        // A key immediately adjacent to `k`: append 0x00 (just above) or drop last byte (just below).
        let mut v = k.as_bytes().to_vec();
        if up {
            v.push(0x00);
        } else {
            v.pop();
        }
        v
    };

    // Edges placed exactly ON keys and immediately adjacent to them (±1 byte).
    let cases: Vec<(Vec<u8>, Vec<u8>)> = vec![
        (b"C0/451630".to_vec(), b"F1/085263".to_vec()), // lo inclusive-on-key, hi exclusive-on-key
        (bump("C0/451630", false), b"E0/670489".to_vec()), // lo just below C0, hi on E0
        (b"E0/670489".to_vec(), b"G0/765327".to_vec()),
        (bump("E0/670489", true), b"G0/765327".to_vec()), // lo just above E0 => excludes E0
        (b"A0/374913".to_vec(), bump("G0/765327", true)), // whole tree
        (b"D".to_vec(), b"F".to_vec()),                   // spans a subtree boundary
    ];
    for (lo, hi) in cases {
        let expect: Vec<Vec<u8>> = full
            .iter()
            .filter(|(k, _)| k.as_slice() >= lo.as_slice() && k.as_slice() < hi.as_slice())
            .map(|(k, _)| k.clone())
            .collect();
        let got: Vec<Vec<u8>> = Walker::range(&car, lo.clone(), hi.clone())
            .run(&root)
            .unwrap()
            .entries
            .into_iter()
            .map(|(k, _)| k)
            .collect();
        assert_eq!(
            got,
            expect,
            "range walk != full-filter for [{}, {})",
            String::from_utf8_lossy(&lo),
            String::from_utf8_lossy(&hi)
        );
    }

    // Explicit adjacency assertion: hi exactly on a key excludes it; hi one byte past keeps it.
    let excl: Vec<_> =
        Walker::range(&car, b"A".to_vec(), b"E0/670489".to_vec()).run(&root).unwrap().entries;
    assert!(excl.iter().all(|(k, _)| k != b"E0/670489"), "hi-on-key must exclude the key");
    let incl: Vec<_> =
        Walker::range(&car, b"A".to_vec(), bump("E0/670489", true)).run(&root).unwrap().entries;
    assert!(incl.iter().any(|(k, _)| k == b"E0/670489"), "hi past-key must include the key");
}

/// 2b. Illegal layer skip: a parent at layer L holds a value key at L, and its left child
/// pointer goes DIRECTLY to a value node at L-2 (the canonical L-1 pass-through node is
/// omitted). indigo's `verifyStructure` rejects this (child height must be exactly parent-1);
/// our Walker must too. (This is the vector that forced the mst.rs tightening — the old
/// `child_layer < parent_layer` check accepted it.)
#[test]
fn adversarial_layer_skip_rejected() {
    let k_hi = find_key_at_layer("skip.hi/", 2); // value at layer 2
    let k_lo = {
        // a layer-0 key that sorts BEFORE k_hi (so it belongs under the left child)
        let mut n = 0u64;
        loop {
            let k = format!("aaa.lo/{n}").into_bytes();
            if mst::key_layer(&k) == 0 && k < k_hi {
                break k;
            }
            n += 1;
        }
    };
    let (child_cid, child_bytes) =
        encode_node(None, &[RawEnt { p: 0, k: k_lo.clone(), v: dummy_value("lo"), t: None }]);
    let (root_cid, root_bytes) = encode_node(
        Some(child_cid), // left child skips from layer 2 straight to layer 0
        &[RawEnt { p: 0, k: k_hi.clone(), v: dummy_value("hi"), t: None }],
    );
    let car = Car::from_blocks(
        vec![root_cid],
        [(child_cid, child_bytes), (root_cid, root_bytes)].into_iter().collect(),
    );
    let err = Walker::full(&car).run(&root_cid).err().expect("expected fail-closed rejection");
    assert!(err.contains("illegal layer skip"), "expected layer-skip rejection, got: {err}");
}

/// 2c. Non-canonical prefix compression: an entry declares `p` SMALLER than the true common
/// prefix with the previous key (still reconstructs the same key). Must be rejected.
#[test]
fn adversarial_noncanonical_prefix_rejected() {
    // two layer-0 keys sharing a long common prefix
    let base = "app.bsky.feed.post/aaaaaaaaaaaa";
    let k0 = find_key_at_layer(&format!("{base}A"), 0);
    let k1 = {
        let mut n = 0u64;
        loop {
            let k = format!("{base}B{n}").into_bytes();
            if mst::key_layer(&k) == 0 && k > k0 {
                break k;
            }
            n += 1;
        }
    };
    let true_lcp = mst::lcp(&k0, &k1);
    assert!(true_lcp >= 20, "need a substantial shared prefix, got {true_lcp}");
    let bad_p = true_lcp - 5; // understated
    let (root_cid, root_bytes) = encode_node(
        None,
        &[
            RawEnt { p: 0, k: k0.clone(), v: dummy_value("a"), t: None },
            // key still reconstructs to k1 (k = k1[bad_p..]), but p != actual lcp
            RawEnt { p: bad_p, k: k1[bad_p..].to_vec(), v: dummy_value("b"), t: None },
        ],
    );
    let car = Car::from_blocks(vec![root_cid], [(root_cid, root_bytes)].into_iter().collect());
    let err = Walker::full(&car).run(&root_cid).err().expect("expected fail-closed rejection");
    assert!(err.contains("non-canonical prefix"), "expected prefix rejection, got: {err}");
}

/// 2d. Reordered entries (keys not strictly ascending within a node) — rejected.
#[test]
fn adversarial_reordered_entries_rejected() {
    let a = b"aaa/1".to_vec();
    let b = b"bbb/1".to_vec();
    // put b before a (descending) — full keys, p=0
    let (root_cid, root_bytes) = encode_node(
        None,
        &[
            RawEnt { p: 0, k: b.clone(), v: dummy_value("b"), t: None },
            RawEnt { p: 0, k: a.clone(), v: dummy_value("a"), t: None },
        ],
    );
    let car = Car::from_blocks(vec![root_cid], [(root_cid, root_bytes)].into_iter().collect());
    let err = Walker::full(&car).run(&root_cid).err().expect("expected fail-closed rejection");
    assert!(err.contains("ascending"), "expected order rejection, got: {err}");
}

/// 2d. Duplicated entries (same key twice) — rejected.
#[test]
fn adversarial_duplicate_entries_rejected() {
    let k = b"dup/key1".to_vec();
    let (root_cid, root_bytes) = encode_node(
        None,
        &[
            RawEnt { p: 0, k: k.clone(), v: dummy_value("1"), t: None },
            // second entry: p = full len, empty suffix => reconstructs to the same key
            RawEnt { p: k.len(), k: vec![], v: dummy_value("2"), t: None },
        ],
    );
    let car = Car::from_blocks(vec![root_cid], [(root_cid, root_bytes)].into_iter().collect());
    let err = Walker::full(&car).run(&root_cid).err().expect("expected fail-closed rejection");
    assert!(err.contains("ascending"), "expected dup rejection, got: {err}");
}

/// 2e. Absence semantics: a complete, fail-closed range walk of a real repo PROVES that a
/// given key does not exist. We walk the full collection (all 21 follows) and a tight range
/// bracketing an absent key; the bracket returns nothing, while a present key is recovered —
/// so non-existence is authenticated, not merely "not seen".
#[test]
fn absence_semantics_provable_nonexistence() {
    let car_bytes = std::fs::read(fixture("test/fixtures/atproto/repos/atproto.car")).unwrap();
    let car = Car::parse(&car_bytes).unwrap();
    // decode the commit to get the data root
    let root = car.roots[0];
    let commit = commit::decode_commit(car.get(&root).unwrap()).unwrap();

    let lo = b"app.bsky.graph.follow/".to_vec();
    let hi = b"app.bsky.graph.follow0".to_vec();
    let all: Vec<Vec<u8>> = Walker::range(&car, lo.clone(), hi.clone())
        .run(&commit.data)
        .expect("complete follow-range walk")
        .entries
        .into_iter()
        .map(|(k, _)| k)
        .collect();
    assert_eq!(all.len(), 21, "ground truth: 21 follows");

    // A key guaranteed absent (rkeys are 13-char TIDs; "zzzz…" sorts above them all).
    let absent = b"app.bsky.graph.follow/zzzzzzzzzzzzz".to_vec();
    assert!(!all.contains(&absent), "absent key must not be among walked keys");

    // Prove it via a tight authenticated bracket around the absent key: [absent, absent+\x00).
    let mut just_above = absent.clone();
    just_above.push(0x00);
    let bracket = Walker::range(&car, absent.clone(), just_above)
        .run(&commit.data)
        .expect("bracket walk is complete / fail-closed");
    assert!(bracket.entries.is_empty(), "authenticated bracket proves the key is absent");

    // Positive control: a real key IS recovered by an equally tight bracket.
    let present = all[0].clone();
    let mut p_above = present.clone();
    p_above.push(0x00);
    let hit = Walker::range(&car, present.clone(), p_above).run(&commit.data).unwrap();
    assert_eq!(hit.entries.len(), 1, "present key is recovered by its bracket");
    assert_eq!(hit.entries[0].0, present);
}

/// 2f. Equivocation pair: ONE DID / key signs TWO different repo states (different data roots)
/// at the SAME rev. Each verifies INDIVIDUALLY at the envelope layer — detecting that the same
/// (did, rev) anchors two heads is the anchor-log/firehose's job, NOT the envelope's. This test
/// documents that boundary: we build both, assert both verify, and assert the heads differ.
#[test]
fn equivocation_pair_each_verifies_individually() {
    let rotation = gen_k256([11u8; 32]);
    let atproto = gen_k256([22u8; 32]);
    let (did, plc) = build_plc_genesis(&rotation, &atproto);
    let node_id = atproto::did_node_id(&did);

    // Two conflicting repos at the same rev, signed by the same key.
    let key = b"app.certified.graph.follow/aaaaaaaaaaaaa".to_vec();
    let (head_a, car_a) =
        build_repo(&did, &atproto, "3laaaaaaaaa2a", &[(key.clone(), record("follow", "A"))]);
    let (head_b, car_b) = build_repo(
        &did,
        &atproto,
        "3laaaaaaaaa2a",
        &[(key.clone(), record("follow", "B-conflict"))],
    );
    assert_ne!(head_a, head_b, "the two commits must anchor different heads");

    let w_a = AtprotoWitness { did: did.clone(), car: car_a, plc_ops: vec![plc.clone()] };
    let w_b = AtprotoWitness { did: did.clone(), car: car_b, plc_ops: vec![plc] };
    let cols = ["app.certified.graph.follow"];

    let ra = atproto::verify(node_id, head_a, 2_000_000_000, &cols, &w_a)
        .expect("branch A verifies on its own");
    let rb = atproto::verify(node_id, head_b, 2_000_000_000, &cols, &w_b)
        .expect("branch B verifies on its own — envelope does NOT flag equivocation");
    assert_eq!(ra.len(), 1);
    assert_eq!(rb.len(), 1);
    assert_ne!(ra[0].cid, rb[0].cid, "the conflicting records differ in content");
}

/// 2g. End-to-end p256 repo: a synthetic DID whose PLC tip #atproto key is p256, a commit
/// signed with p256, verified all the way through `atproto::verify`.
#[test]
fn p256_commit_end_to_end() {
    let rotation = gen_k256([33u8; 32]); // rotation key curve is independent of signing curve
    let atproto = gen_p256([44u8; 32]); // TIP #atproto key is p256
    assert_eq!(atproto.curve, Curve::P256);
    let (did, plc) = build_plc_genesis(&rotation, &atproto);
    let node_id = atproto::did_node_id(&did);

    // Two records in one repo => one MST node, so both keys must sit on the same layer
    // (else the node would legitimately split — our single-node builder keeps it flat).
    let records = vec![
        (find_key_at_layer("app.certified.graph.follow/p", 0), record("follow", "p1")),
        (find_key_at_layer("app.certified.badge.award/p", 0), record("award", "p2")),
    ];
    let (head, car) = build_repo(&did, &atproto, "3lp256commit1", &records);
    let w = AtprotoWitness { did: did.clone(), car, plc_ops: vec![plc] };

    let out = atproto::verify(
        node_id,
        head,
        2_000_000_000,
        &["app.certified.graph.follow", "app.certified.badge.award"],
        &w,
    )
    .expect("p256 end-to-end envelope verifies");
    assert_eq!(out.len(), 2, "both p256-signed records recovered");

    // Negative: sign the commit with a DIFFERENT p256 key (not the PLC tip #atproto key) =>
    // must fail closed (exercises the p256 verify path on the reject side).
    let wrong = gen_p256([99u8; 32]);
    let (bad_head, bad_car) = build_repo(&did, &wrong, "3lp256commit1", &records);
    let w_bad = AtprotoWitness { did, car: bad_car, plc_ops: w.plc_ops.clone() };
    let r =
        atproto::verify(node_id, bad_head, 2_000_000_000, &["app.certified.graph.follow"], &w_bad);
    assert!(r.is_err(), "commit signed by a non-tip p256 key must be rejected");
}
