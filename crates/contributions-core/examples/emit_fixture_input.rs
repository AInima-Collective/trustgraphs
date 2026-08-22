//! Emit the 6-persona worked-example fixture (`testutil::fixture()`) as a serialized
//! `contributions_core::compute::GuestInput` — the `input.json` the prover consumes:
//!
//!   cargo run -p contributions-core --example emit_fixture_input [--] [out.json]
//!   trustgraph-prover contributions execute contributions_input.json
//!
//! This is the SAME input the golden vectors' `compute` family was generated from
//! (`tests/golden/contributions.json`), so the guest's committed public values must equal
//! `.compute.journal.encoded` byte-for-byte (the M2 parity leg).

fn main() {
    let input = contributions_core::testutil::fixture();
    let out = std::env::args().nth(1).unwrap_or_else(|| "contributions_input.json".to_string());
    std::fs::write(&out, serde_json::to_string(&input).unwrap()).unwrap();
    eprintln!(
        "wrote {out}: {} trust edges, {} contribution records",
        input.trust_edges.len(),
        input.records.len()
    );
}
