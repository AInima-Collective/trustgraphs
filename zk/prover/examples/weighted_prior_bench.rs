//! Usage: `cargo run --manifest-path zk/prover/Cargo.toml --example weighted_prior_bench -- ELF 512 4 10`

use alloy_primitives::Address;
use anyhow::{Context, Result};
use sp1_sdk::Elf;
use std::time::Instant;
use weighted_prior_research::{
    rank_digest, sparse_rank, BenchInput, PriorEntry, SparseEdge, SCALE,
};

fn main() -> Result<()> {
    let args = std::env::args().skip(1).collect::<Vec<_>>();
    let elf_path =
        args.first().context("usage: weighted_prior_bench ELF COUNT DEGREE ITERATIONS")?;
    let count = args.get(1).context("missing COUNT")?.parse::<usize>()?;
    let degree = args.get(2).context("missing DEGREE")?.parse::<usize>()?;
    let iterations = args.get(3).context("missing ITERATIONS")?.parse::<u16>()?;
    anyhow::ensure!(count > 0 && count <= u32::MAX as usize && degree < count);

    let base = SCALE / count as u64;
    let remainder = SCALE % count as u64;
    let prior = (0..count)
        .map(|index| {
            let mut bytes = [0u8; 20];
            bytes[12..].copy_from_slice(&((index + 1) as u64).to_be_bytes());
            PriorEntry {
                account: Address::from(bytes),
                weight: base + u64::from((index as u64) < remainder),
            }
        })
        .collect::<Vec<_>>();
    let mut edges = Vec::with_capacity(count * degree);
    for from in 0..count {
        for offset in 1..=degree {
            edges.push(SparseEdge { from: from as u32, to: ((from + offset) % count) as u32 });
        }
    }
    let input = BenchInput { prior, edges, damping_bps: 8500, iterations };
    let witness_bytes = serde_json::to_vec(&input)?.len();
    let started = Instant::now();
    let native = sparse_rank(&input);
    let native_micros = started.elapsed().as_micros();
    let expected = rank_digest(&native);
    let execution = trustgraph_prover::common::execute_values(
        Elf::from(std::fs::read(elf_path).context("read research ELF")?),
        &input,
        expected.as_slice(),
    )?;
    println!(
        "count,degree,iterations,witness_bytes,native_micros,guest_cycles\n{count},{degree},{iterations},{witness_bytes},{native_micros},{}",
        execution.cycles
    );
    Ok(())
}
