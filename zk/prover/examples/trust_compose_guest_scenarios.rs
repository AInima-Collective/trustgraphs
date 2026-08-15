//! Execute every deterministic composition parity shape inside SP1 and byte-assert native output.

use anyhow::{ensure, Result};
use composition_core::{codec, compute::compute};

fn main() -> Result<()> {
    println!("scenario,guest_cycles,output_accounts,output_total");
    for (name, input) in trustgraph_prover::programs::composition::parity_inputs() {
        let native = compute(&input)?;
        let expected = codec::journal_encoded(&native.journal);
        let execution = trustgraph_prover::common::execute_values_untraced(
            trustgraph_prover::programs::composition::elf(),
            &input,
            &expected,
        )?;
        ensure!(execution.cycles < 1_000_000_000, "{name} exceeded the V1 cycle ceiling");
        println!(
            "{name},{},{},{}",
            execution.cycles,
            native.scores.len(),
            native.journal.total_value
        );
    }
    Ok(())
}
