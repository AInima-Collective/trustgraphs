//! Release rejection gate for every weighted-prior manifest/binding invariant in issue #52.

use alloy_primitives::B256;
use anyhow::{ensure, Result};
use weighted_prior_core::{compute::compute, GuestInput, MANIFEST_MAGIC};

fn main() -> Result<()> {
    let valid = trustgraph_prover::programs::weighted::parity_inputs().remove(0).1;
    let mut cases = Vec::<(&str, GuestInput)>::new();

    let mut input = valid.clone();
    input.params.version = 2;
    cases.push(("params-version", input));

    let mut input = valid.clone();
    input.manifest[5] = 2;
    cases.push(("manifest-version", input));

    let mut input = valid.clone();
    input.params.chain_id = 11;
    cases.push(("chain", input));

    let mut input = valid.clone();
    input.params.prior_count = 1;
    cases.push(("count", input));

    let mut input = valid.clone();
    let first = input.manifest[18..46].to_vec();
    let second = input.manifest[46..74].to_vec();
    input.manifest[18..46].copy_from_slice(&second);
    input.manifest[46..74].copy_from_slice(&first);
    cases.push(("order", input));

    let mut input = valid.clone();
    let first_account = input.manifest[18..38].to_vec();
    input.manifest[46..66].copy_from_slice(&first_account);
    cases.push(("duplicate", input));

    let mut input = valid.clone();
    input.manifest[18..38].fill(0);
    cases.push(("zero-address", input));

    let mut input = valid.clone();
    input.manifest[38..46].fill(0);
    cases.push(("zero-weight", input));

    let mut input = valid.clone();
    let last = input.manifest.len() - 1;
    input.manifest[last] ^= 1;
    cases.push(("sum", input));

    let mut input = valid.clone();
    input.params.prior_root = B256::from([0xFF; 32]);
    cases.push(("root", input));

    let mut input = valid.clone();
    input.params.manifest_sha256 = B256::from([0xFF; 32]);
    cases.push(("digest", input));

    let mut input = valid;
    let mut oversized = Vec::from(MANIFEST_MAGIC.as_slice());
    oversized.extend_from_slice(&1u16.to_be_bytes());
    oversized.extend_from_slice(&10u64.to_be_bytes());
    oversized.extend_from_slice(&2_049u32.to_be_bytes());
    input.params.prior_count = 2_049;
    input.manifest = oversized;
    cases.push(("over-2048", input));

    println!("rejection,native_rejected,guest_rejected,guest_cycles");
    for (name, input) in cases {
        ensure!(compute(&input).is_err(), "native accepted {name}");
        let cycles = trustgraph_prover::common::execute_values_untraced_rejected(
            trustgraph_prover::programs::weighted::elf(),
            &input,
        )?;
        println!("{name},true,true,{cycles}");
    }
    Ok(())
}
