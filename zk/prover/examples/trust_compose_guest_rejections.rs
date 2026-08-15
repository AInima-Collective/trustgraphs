//! Guest rejection gate for the composition capture, source, policy, and cap invariants.

use alloy_primitives::B256;
use anyhow::{ensure, Result};
use composition_core::{codec, compute::compute, CompositionError, GuestInput};

fn rebind(input: &mut GuestInput) {
    input.capture_commitment = codec::manifest_digest(&input.manifest);
}

fn main() -> Result<()> {
    let valid = trustgraph_prover::programs::composition::sample_input();
    let mut cases = Vec::<(&str, GuestInput)>::new();

    let mut input = valid.clone();
    input.capture_commitment = B256::from([0xFF; 32]);
    cases.push(("capture-commitment", input));

    let mut input = valid.clone();
    input.source_preimages[0].blob[10] ^= 1;
    cases.push(("source-bytes", input));

    let mut input = valid.clone();
    let freeze = codec::CAPTURE_HEADER_LENGTH + 124;
    input.manifest[freeze..freeze + 8].copy_from_slice(&1u64.to_be_bytes());
    rebind(&mut input);
    cases.push(("stale-source", input));

    let mut input = valid.clone();
    let program = codec::CAPTURE_HEADER_LENGTH + 84;
    input.manifest[program..program + 32].fill(0x77);
    rebind(&mut input);
    cases.push(("unadmitted-program", input));

    let mut input = valid.clone();
    input.params.output_pool = 2;
    cases.push(("zero-required-quota", input));

    let mut input = valid;
    input.params.max_sources = 9;
    cases.push(("raised-source-cap", input));

    println!("rejection,native_rejected,guest_rejected,guest_cycles");
    for (name, input) in cases {
        let error = compute(&input).expect_err("native accepted invalid composition witness");
        ensure!(
            !matches!(error, CompositionError::OutputPoolMismatch),
            "unexpected late rejection for {name}"
        );
        let cycles = trustgraph_prover::common::execute_values_untraced_rejected(
            trustgraph_prover::programs::composition::elf(),
            &input,
        )?;
        println!("{name},true,true,{cycles}");
    }
    Ok(())
}
