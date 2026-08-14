//! Usage: `cargo run --manifest-path zk/prover/Cargo.toml --release --example weighted_prior_production_bench -- 2048 16 40 [CYCLE_LIMIT]`

use anyhow::{Context, Result};
use std::time::Instant;
use weighted_prior_core::{compute::compute, encode};

fn main() -> Result<()> {
    let args = std::env::args().skip(1).collect::<Vec<_>>();
    let count = args
        .first()
        .context("usage: weighted_prior_production_bench COUNT DEGREE ITERATIONS")?
        .parse::<usize>()?;
    let degree = args.get(1).context("missing DEGREE")?.parse::<usize>()?;
    let iterations = args.get(2).context("missing ITERATIONS")?.parse::<u32>()?;
    let cycle_limit =
        args.get(3).map(|value| value.parse::<u64>()).transpose()?.unwrap_or(1_000_000_000);
    anyhow::ensure!(count > 0 && count <= 2_048 && degree < count && iterations <= 40);
    let input = trustgraph_prover::programs::weighted::benchmark_input(count, degree, iterations);
    let witness_bytes = serde_json::to_vec(&input)?.len();
    let started = Instant::now();
    let native = compute(&input)?;
    let native_micros = started.elapsed().as_micros();
    let expected = encode::journal_encoded(&native.journal);
    let execution = trustgraph_prover::common::execute_values_untraced(
        trustgraph_prover::programs::weighted::elf(),
        &input,
        &expected,
    )?;
    anyhow::ensure!(
        execution.cycles < cycle_limit,
        "guest used {} cycles, limit is {cycle_limit}",
        execution.cycles
    );
    println!(
        "count,degree,iterations,witness_bytes,native_micros,guest_cycles\n{count},{degree},{iterations},{witness_bytes},{native_micros},{}",
        execution.cycles
    );
    Ok(())
}
