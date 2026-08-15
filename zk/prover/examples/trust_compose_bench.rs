//! Usage: `cargo run --release --example trust_compose_bench -- SOURCES ENTRIES [CYCLE_LIMIT] [--prove]`

use anyhow::{Context, Result};
use composition_core::{codec, compute::compute};
use std::time::Instant;

fn peak_rss_kib() -> Option<u64> {
    std::fs::read_to_string("/proc/self/status")
        .ok()?
        .lines()
        .find(|line| line.starts_with("VmHWM:"))?
        .split_whitespace()
        .nth(1)?
        .parse()
        .ok()
}

fn main() -> Result<()> {
    let args = std::env::args().skip(1).collect::<Vec<_>>();
    let source_count = args
        .first()
        .context("usage: trust_compose_bench SOURCES ENTRIES [CYCLE_LIMIT] [--prove]")?
        .parse::<usize>()?;
    let entries = args.get(1).context("missing ENTRIES")?.parse::<usize>()?;
    let cycle_limit = args
        .get(2)
        .filter(|value| value.as_str() != "--prove")
        .map(|value| value.parse::<u64>())
        .transpose()?
        .unwrap_or(1_000_000_000);
    let prove = args.iter().any(|value| value == "--prove");
    let input = trustgraph_prover::programs::composition::benchmark_input(source_count, entries);
    let witness_bytes = bincode::serialize(&input)?.len();
    let rss_before = peak_rss_kib().unwrap_or_default();
    let started = Instant::now();
    let native = compute(&input)?;
    let native_micros = started.elapsed().as_micros();
    let native_peak_rss_kib = peak_rss_kib().unwrap_or_default();
    let expected = codec::journal_encoded(&native.journal);
    let execution = trustgraph_prover::common::execute_values_untraced(
        trustgraph_prover::programs::composition::elf(),
        &input,
        &expected,
    )?;
    anyhow::ensure!(execution.cycles < cycle_limit, "guest exceeded cycle limit");
    let mut proof_bytes = 0usize;
    if prove {
        let proof = trustgraph_prover::common::prove_values(
            trustgraph_prover::programs::composition::elf(),
            &input,
            true,
        )?;
        anyhow::ensure!(proof.public_values == expected, "mock proof journal mismatch");
        proof_bytes = proof.blob().len();
    }
    println!(
        "sources,aggregate_entries,witness_bytes,native_micros,native_peak_rss_kib,native_rss_delta_kib,guest_cycles,proof_verified,proof_bytes\n{source_count},{entries},{witness_bytes},{native_micros},{native_peak_rss_kib},{},{},{prove},{proof_bytes}",
        native_peak_rss_kib.saturating_sub(rss_before),
        execution.cycles,
    );
    Ok(())
}
