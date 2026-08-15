//! Usage: `cargo run --manifest-path zk/prover/Cargo.toml --release --example erc8004_completeness_bench -- ELF COUNT DATA_BYTES`

use alloy_primitives::{keccak256, Address, Bytes, B256};
use anyhow::{Context, Result};
use erc8004_completeness_research::{event_set_version, replay, CanonicalEvent};
use sp1_sdk::Elf;
use std::time::Instant;

fn main() -> Result<()> {
    let args = std::env::args().skip(1).collect::<Vec<_>>();
    let elf_path =
        args.first().context("usage: erc8004_completeness_bench ELF COUNT DATA_BYTES")?;
    let count = args.get(1).context("missing COUNT")?.parse::<usize>()?;
    let data_bytes = args.get(2).context("missing DATA_BYTES")?.parse::<usize>()?;
    anyhow::ensure!(count > 0 && count <= u32::MAX as usize);
    anyhow::ensure!(data_bytes <= 16_384);

    let registry = Address::from([0x80; 20]);
    let implementation_code_hash = keccak256(b"reviewed implementation");
    let version = event_set_version();
    let events = (0..count)
        .map(|index| {
            let mut data = vec![0x42; data_bytes];
            if data_bytes >= 8 {
                data[..8].copy_from_slice(&(index as u64).to_be_bytes());
            }
            let mut sequence_topic = [0u8; 32];
            sequence_topic[24..].copy_from_slice(&(index as u64).to_be_bytes());
            CanonicalEvent {
                chain_id: 10,
                registry,
                block_number: 160_000_000 + (index / 100) as u64,
                sequence: index as u64,
                implementation_code_hash,
                event_set_version: version,
                kind: 5,
                topics: vec![
                    keccak256(b"NewFeedback"),
                    B256::from(sequence_topic),
                    keccak256(b"client"),
                    keccak256(b"quality"),
                ],
                data: Bytes::from(data),
            }
        })
        .collect::<Vec<_>>();
    let witness_bytes = bincode::serialize(&events)?.len();
    let started = Instant::now();
    let (head, preimages) = replay(&events);
    let native_micros = started.elapsed().as_micros();
    let mut expected = Vec::with_capacity(64);
    expected.extend_from_slice(head.as_slice());
    expected.extend_from_slice(preimages.as_slice());
    let execution = trustgraph_prover::common::execute_values_untraced(
        Elf::from(std::fs::read(elf_path).context("read research ELF")?),
        &events,
        &expected,
    )?;
    println!(
        "events,data_bytes,witness_bytes,native_micros,guest_cycles\n{count},{data_bytes},{witness_bytes},{native_micros},{}",
        execution.cycles
    );
    Ok(())
}
