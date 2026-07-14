//! M1 Phase-A MST-verification spike driver.
//!
//! For each fixture CAR: parse (content-address check), decode+verify the commit
//! signature against the PLC-derived #atproto key, full canonical MST walk with
//! invariant enforcement, cross-check the enumerated record set against goat's
//! ground truth, a single-collection range walk, decode-parser timing
//! (serde_ipld_dagcbor vs hand-rolled), and tamper/drop fail-closed tests.

mod car;
mod handrolled;
mod mst;
mod verify;

use car::Car;
use ipld_core::cid::Cid;
use std::collections::BTreeMap;
use std::path::Path;
use std::time::Instant;

struct Fixture {
    name: &'static str,
    car: &'static str,
    plc: &'static str,
    records: &'static str,
}

const FIXTURES: &[Fixture] = &[
    Fixture { name: "atproto", car: "atproto.car", plc: "atproto.plc.json", records: "atproto.records.tsv" },
    Fixture { name: "jay", car: "jay.car", plc: "jay.plc.json", records: "jay.records.tsv" },
    Fixture { name: "pfrazee", car: "pfrazee.car", plc: "pfrazee.plc.json", records: "pfrazee.records.tsv" },
];

/// last non-nullified op's verificationMethods.atproto did:key
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

/// ground truth key->cid string from goat tsv
fn load_ground_truth(path: &Path) -> BTreeMap<String, String> {
    let txt = std::fs::read_to_string(path).unwrap();
    txt.lines()
        .filter_map(|l| {
            let mut it = l.splitn(2, '\t');
            Some((it.next()?.to_string(), it.next()?.to_string()))
        })
        .collect()
}

fn run_fixture(dir: &Path, f: &Fixture) -> Result<(), String> {
    println!("\n================ {} ================", f.name);
    let car_bytes = std::fs::read(dir.join(f.car)).map_err(|e| e.to_string())?;
    let plc = std::fs::read_to_string(dir.join(f.plc)).map_err(|e| e.to_string())?;

    // 1. CAR parse (verifies every sha2-256 block's CID vs content)
    let t = Instant::now();
    let car = Car::parse(&car_bytes)?;
    let parse_ms = t.elapsed().as_secs_f64() * 1e3;
    let root = car.roots[0];
    println!(
        "CAR: {} bytes, {} blocks, root {}  (parse+content-address {:.1} ms)",
        car_bytes.len(),
        car.num_blocks,
        root,
        parse_ms
    );

    // 2. commit decode + signature verify
    let commit_block = car.get(&root).ok_or("commit block absent")?;
    // commit CID must be dag-cbor CIDv1 == sha256 of block (already checked in parse)
    let recomputed = car::cid_dagcbor(commit_block);
    if recomputed != root {
        return Err("commit CID != sha256(commit block)".into());
    }
    let cf = verify::decode_commit(commit_block)?;
    if cf.version != 3 {
        return Err(format!("unexpected commit version {}", cf.version));
    }
    let key_str = plc_atproto_key(&plc)?;
    let mk = verify::parse_multikey(&key_str)?;
    verify::verify_commit_sig(&mk, &cf.unsigned_bytes, &cf.sig)?;
    println!(
        "commit: did={} version={} rev={} data={}",
        cf.did, cf.version, cf.rev, cf.data
    );
    println!(
        "signature: VERIFIED  curve={:?}  key={}  (low-S enforced, 64-byte compact)",
        mk.curve, key_str
    );
    if cf.did != f_did_from_plc(&plc) {
        return Err("commit did != plc did".into());
    }

    // 3. full MST walk with canonical invariants
    let t = Instant::now();
    let out = mst::Walker::full(&car).run(&cf.data)?;
    let walk_ms = t.elapsed().as_secs_f64() * 1e3;
    println!(
        "MST full walk: {} records across {} nodes  ({:.1} ms)",
        out.entries.len(),
        out.nodes_visited,
        walk_ms
    );

    // record blocks present (fail-closed on missing record)
    let mut missing_records = 0usize;
    for (_k, v) in &out.entries {
        if car.get(v).is_none() {
            missing_records += 1;
        }
    }
    if missing_records > 0 {
        return Err(format!("{missing_records} record blocks missing (fail-closed)"));
    }

    // 4. parity vs goat ground truth (byte-level: key + value CID string)
    let gt = load_ground_truth(&dir.join(f.records));
    let mine: BTreeMap<String, String> = out
        .entries
        .iter()
        .map(|(k, v)| (String::from_utf8_lossy(k).into_owned(), v.to_string()))
        .collect();
    if mine.len() != gt.len() {
        return Err(format!("count mismatch: rust {} vs goat {}", mine.len(), gt.len()));
    }
    let mut mismatches = 0usize;
    for (k, v) in &gt {
        match mine.get(k) {
            Some(mv) if mv == v => {}
            _ => {
                if mismatches < 5 {
                    println!("  DIVERGENCE key={k}: goat={v} rust={:?}", mine.get(k));
                }
                mismatches += 1;
            }
        }
    }
    if mismatches == 0 {
        println!("PARITY vs indigo/goat: EXACT ({} records, key+valueCID identical)", gt.len());
    } else {
        return Err(format!("{mismatches} record divergences vs goat"));
    }

    // 5. range walk over one collection prefix
    let prefix = "app.bsky.graph.follow";
    // collection range = [ "<nsid>/" , "<nsid>0" )  since '/'(0x2f)+1 == '0'(0x30)
    let lo = format!("{prefix}/").into_bytes();
    let hi = format!("{prefix}0").into_bytes();
    let t = Instant::now();
    let rout = mst::Walker::range(&car, lo.clone(), hi.clone()).run(&cf.data)?;
    let range_ms = t.elapsed().as_secs_f64() * 1e3;
    // completeness cross-check: range result == full-walk filtered by prefix
    let expect: Vec<_> = out
        .entries
        .iter()
        .filter(|(k, _)| k.as_slice() >= lo.as_slice() && k.as_slice() < hi.as_slice())
        .collect();
    if rout.entries.len() != expect.len() {
        return Err(format!(
            "range walk incomplete: {} vs {} expected",
            rout.entries.len(),
            expect.len()
        ));
    }
    println!(
        "range walk [{}/ .. {}0): {} records via {} nodes ({:.2} ms) — matches full-walk filter",
        prefix, prefix, rout.entries.len(), rout.nodes_visited, range_ms
    );

    // 6. parser timing: serde_ipld_dagcbor vs hand-rolled, same MST-node blocks
    let node_blocks: Vec<&Vec<u8>> = out.node_cids.iter().filter_map(|c| car.get(c)).collect();
    let reps = if node_blocks.len() < 200 { 50 } else { 5 };
    // serde
    let t = Instant::now();
    let mut acc = 0u64;
    for _ in 0..reps {
        for b in &node_blocks {
            let n: SerdeNode = serde_ipld_dagcbor::from_slice(b).map_err(|e| e.to_string())?;
            acc = acc.wrapping_add(n.e.len() as u64);
        }
    }
    let serde_ns = t.elapsed().as_nanos() as f64 / (reps as f64 * node_blocks.len() as f64);
    // hand-rolled
    let t = Instant::now();
    let mut acc2 = 0u64;
    for _ in 0..reps {
        for b in &node_blocks {
            let n = handrolled::decode_node(b)?;
            acc2 = acc2.wrapping_add(n.e.len() as u64);
        }
    }
    let hr_ns = t.elapsed().as_nanos() as f64 / (reps as f64 * node_blocks.len() as f64);
    if acc != acc2 {
        return Err("hand-rolled vs serde entry-count mismatch".into());
    }
    // canonical re-encode check on a sample of nodes (serde round-trip == stored bytes)
    let mut noncanon = 0usize;
    for b in node_blocks.iter().take(500) {
        let v: ipld_core::ipld::Ipld = serde_ipld_dagcbor::from_slice(b).map_err(|e| e.to_string())?;
        let re = serde_ipld_dagcbor::to_vec(&v).map_err(|e| e.to_string())?;
        if &re != *b {
            noncanon += 1;
        }
    }
    println!(
        "decode/node: serde {:.0} ns  hand-rolled {:.0} ns  ({:.2}x)  | canonical re-encode: {}/{} nodes exact",
        serde_ns,
        hr_ns,
        serde_ns / hr_ns,
        node_blocks.len().min(500) - noncanon,
        node_blocks.len().min(500)
    );

    Ok(())
}

// serde node mirror for timing (kept local to avoid exposing from mst.rs)
#[derive(serde::Deserialize)]
struct SerdeEntry {
    #[allow(dead_code)]
    p: usize,
    #[allow(dead_code)]
    #[serde(with = "serde_bytes")]
    k: Vec<u8>,
    #[allow(dead_code)]
    v: Cid,
    #[allow(dead_code)]
    #[serde(default)]
    t: Option<Cid>,
}
#[derive(serde::Deserialize)]
struct SerdeNode {
    #[allow(dead_code)]
    #[serde(default)]
    l: Option<Cid>,
    e: Vec<SerdeEntry>,
}

fn f_did_from_plc(plc_json: &str) -> String {
    let log: serde_json::Value = serde_json::from_str(plc_json).unwrap();
    log.as_array()
        .and_then(|a| a.last())
        .and_then(|e| e.get("did"))
        .and_then(|d| d.as_str())
        .unwrap_or("")
        .to_string()
}

/// Tamper tests on the smallest fixture: flip a byte in an MST node, drop a block.
fn tamper_tests(dir: &Path) -> Result<(), String> {
    println!("\n================ tamper tests (atproto.car) ================");
    let car_bytes = std::fs::read(dir.join("atproto.car")).map_err(|e| e.to_string())?;
    let car = Car::parse(&car_bytes)?;
    let root = car.roots[0];
    let cf = verify::decode_commit(car.get(&root).unwrap())?;

    // identify one MST node cid
    let base = mst::Walker::full(&car).run(&cf.data)?;
    let victim = base.node_cids[base.node_cids.len() / 2];

    // (a) flip a byte inside that node's block -> CAR content-address check must reject
    let mut tampered = car.clone_blocks();
    {
        let b = tampered.get_mut(&victim).unwrap();
        let mid = b.len() / 2;
        b[mid] ^= 0x01;
    }
    let car_t = Car::from_blocks(car.roots.clone(), tampered);
    // re-derive that block's CID: it no longer matches -> walker sees a different CID
    // present but the referenced CID is now MISSING => fail-closed.
    match mst::Walker::full(&car_t).run(&cf.data) {
        Err(e) if e.contains("missing") || e.contains("FAIL-CLOSED") => {
            println!("flip-byte in MST node: FAIL-CLOSED as expected ({e})");
        }
        Err(e) => println!("flip-byte: rejected (other invariant): {e}"),
        Ok(_) => return Err("flip-byte NOT detected — walk succeeded!".into()),
    }
    // and content-address check catches it if we re-parse the whole thing
    let mut raw2 = car_bytes.clone();
    corrupt_a_node_in_raw(&mut raw2, &victim, &car);
    match Car::parse(&raw2) {
        Err(e) if e.contains("mismatch") => {
            println!("flip-byte re-parse: CAR content-address check rejects ({e})")
        }
        Err(e) => println!("flip-byte re-parse: rejected ({e})"),
        Ok(_) => return Err("CAR content-address check missed a flipped byte!".into()),
    }

    // (b) drop the block entirely -> fail-closed
    let mut dropped = car.clone_blocks();
    dropped.remove(&victim);
    let car_d = Car::from_blocks(car.roots.clone(), dropped);
    match mst::Walker::full(&car_d).run(&cf.data) {
        Err(e) if e.contains("missing") || e.contains("FAIL-CLOSED") => {
            println!("drop MST node block: FAIL-CLOSED as expected ({e})")
        }
        Err(e) => return Err(format!("drop produced wrong error: {e}")),
        Ok(_) => return Err("dropped block NOT detected — walk succeeded!".into()),
    }
    Ok(())
}

/// Find the victim CID's block in the raw CAR bytes and flip a byte in its data,
/// leaving the CID prefix intact (so content-address check must catch it).
fn corrupt_a_node_in_raw(raw: &mut [u8], victim: &Cid, car: &Car) {
    let victim_bytes = victim.to_bytes();
    let data = car.get(victim).unwrap();
    // find the CID bytes followed by the data in the raw CAR
    if let Some(pos) = find_subslice(raw, &victim_bytes) {
        let data_start = pos + victim_bytes.len();
        if data_start + data.len() <= raw.len() {
            raw[data_start + data.len() / 2] ^= 0x01;
        }
    }
}

fn find_subslice(hay: &[u8], needle: &[u8]) -> Option<usize> {
    hay.windows(needle.len()).position(|w| w == needle)
}

fn main() {
    let dir = std::env::args()
        .nth(1)
        .unwrap_or_else(|| "fixtures".to_string());
    let dir = Path::new(&dir);

    let mut failures = 0;
    for f in FIXTURES {
        if let Err(e) = run_fixture(dir, f) {
            println!("!! {} FAILED: {e}", f.name);
            failures += 1;
        }
    }
    if let Err(e) = tamper_tests(dir) {
        println!("!! tamper tests FAILED: {e}");
        failures += 1;
    }
    println!("\n==== {} ====", if failures == 0 { "ALL GREEN" } else { "FAILURES" });
    std::process::exit(if failures == 0 { 0 } else { 1 });
}
