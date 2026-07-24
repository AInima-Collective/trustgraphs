//! Dev aid: dump the REAL decoded shapes of every fixture record (the DEVIATIONS #2
//! corrections in executable form). Run: cargo test -p hypercerts-core --test shape_dump -- --nocapture
use envelopes::atproto::carset::Car;
use ipld_core::ipld::Ipld;

#[test]
fn dump_fixture_record_shapes() {
    let root = concat!(env!("CARGO_MANIFEST_DIR"), "/../..");
    let car =
        std::fs::read(format!("{root}/test/fixtures/atproto/hypercerts/fixtures/hypercerts.car")).unwrap();
    let parsed = Car::parse(&car).unwrap();
    let tsv = std::fs::read_to_string(format!(
        "{root}/test/fixtures/atproto/hypercerts/fixtures/hypercerts.records.tsv"
    ))
    .unwrap();
    for line in tsv.lines() {
        let (key, cid_s) = line.split_once('\t').unwrap();
        let cid: ipld_core::cid::Cid = cid_s.parse().unwrap();
        let bytes = parsed.get(&cid).unwrap();
        let v: Ipld = serde_ipld_dagcbor::from_slice(bytes).unwrap();
        println!("=== {key}\n{v:?}\n");
    }
}
