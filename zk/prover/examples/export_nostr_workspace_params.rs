//! Refresh the Rust-serde params fixture consumed by the Nostr witness runbook/tests.

use std::path::Path;

fn main() -> anyhow::Result<()> {
    let output =
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../../test/fixtures/nostr/params.json");
    let params = trustgraph_prover::programs::nostr_workspace::sample_input().params;
    let mut bytes = serde_json::to_vec_pretty(&params)?;
    bytes.push(b'\n');
    std::fs::write(&output, bytes)?;
    println!("{}", output.display());
    Ok(())
}
