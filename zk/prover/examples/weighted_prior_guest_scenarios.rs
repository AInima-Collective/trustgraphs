//! Release parity gate for the empty, sparse, dangling, concentrated-prior, and Hamilton-tie
//! fixtures. The max-size fixture is the `weighted_prior_bench` example because it additionally
//! enforces the one-billion-cycle ceiling.

use anyhow::Result;
use weighted_prior_core::{compute::compute, encode};

fn main() -> Result<()> {
    println!("scenario,public_values_bytes,guest_cycles");
    for (name, input) in trustgraph_prover::programs::weighted::parity_inputs() {
        let native = compute(&input)?;
        let expected = encode::journal_encoded(&native.journal);
        let execution = trustgraph_prover::common::execute_values_untraced(
            trustgraph_prover::programs::weighted::elf(),
            &input,
            &expected,
        )?;
        println!("{name},{},{}", execution.public_values.len(), execution.cycles);
    }
    Ok(())
}
