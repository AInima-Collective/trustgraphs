use alloy_primitives::{Address, B256};
use weighted_prior_core::{
    compute::compute,
    manifest::{canonical_manifest, manifest_digest, prior_root},
    Binding, GuestInput, Params, PriorEntry, WeightedError, MANIFEST_MAGIC, PARAMS_VERSION, SCALE,
};

fn account(index: u64) -> Address {
    let mut bytes = [0u8; 20];
    bytes[12..].copy_from_slice(&index.to_be_bytes());
    Address::from(bytes)
}

fn entries(count: usize) -> Vec<PriorEntry> {
    let base = SCALE / count as u64;
    let extra = SCALE % count as u64;
    (0..count)
        .map(|index| PriorEntry {
            account: account(index as u64 + 1),
            weight: base + u64::from((index as u64) < extra),
        })
        .collect()
}

fn input(count: usize) -> GuestInput {
    let entries = entries(count);
    let manifest = canonical_manifest(10, &entries).unwrap();
    let params = Params {
        version: PARAMS_VERSION,
        damping_fp: 850_000_000_000_000_000,
        tolerance_fp: 1_000_000_000_000,
        max_iterations: 40,
        min_weight: 0,
        max_weight: 100,
        prior_root: prior_root(&entries).unwrap(),
        prior_count: entries.len() as u32,
        manifest_sha256: manifest_digest(&manifest),
        schema_uid: B256::from([0xAB; 32]),
        weight_field_index: 1,
        accumulator: account(0xAC),
        chain_id: 10,
    };
    GuestInput { edges: vec![], params, manifest, binding: Binding::default() }
}

fn expect_error(input: &GuestInput, expected: fn(&WeightedError) -> bool) {
    let error = compute(input).unwrap_err();
    assert!(expected(&error), "unexpected error: {error}");
}

#[test]
fn guest_pipeline_rejects_every_manifest_binding_failure() {
    let valid = input(3);

    let mut wrong_params_version = valid.clone();
    wrong_params_version.params.version = 2;
    expect_error(&wrong_params_version, |e| {
        matches!(e, WeightedError::UnsupportedParamsVersion(2))
    });

    let mut wrong_manifest_version = valid.clone();
    wrong_manifest_version.manifest[5] = 2;
    expect_error(&wrong_manifest_version, |e| {
        matches!(e, WeightedError::UnsupportedManifestVersion(2))
    });

    let mut wrong_chain = valid.clone();
    wrong_chain.params.chain_id = 11;
    expect_error(&wrong_chain, |e| matches!(e, WeightedError::WrongManifestChain { .. }));

    let mut wrong_count = valid.clone();
    wrong_count.params.prior_count = 2;
    expect_error(&wrong_count, |e| matches!(e, WeightedError::ManifestCountMismatch { .. }));

    let mut wrong_order = valid.clone();
    let first = wrong_order.manifest[18..46].to_vec();
    let second = wrong_order.manifest[46..74].to_vec();
    wrong_order.manifest[18..46].copy_from_slice(&second);
    wrong_order.manifest[46..74].copy_from_slice(&first);
    expect_error(&wrong_order, |e| matches!(e, WeightedError::AccountsNotStrictlySorted(_)));

    let mut duplicate = valid.clone();
    let first_account = duplicate.manifest[18..38].to_vec();
    duplicate.manifest[46..66].copy_from_slice(&first_account);
    expect_error(&duplicate, |e| matches!(e, WeightedError::DuplicateAccount(_)));

    let mut zero_account = valid.clone();
    zero_account.manifest[18..38].fill(0);
    expect_error(&zero_account, |e| matches!(e, WeightedError::ZeroAddress));

    let mut zero_weight = valid.clone();
    zero_weight.manifest[38..46].fill(0);
    expect_error(&zero_weight, |e| matches!(e, WeightedError::ZeroWeight(_)));

    let mut wrong_sum = valid.clone();
    let last = wrong_sum.manifest.len() - 1;
    wrong_sum.manifest[last] ^= 1;
    expect_error(&wrong_sum, |e| matches!(e, WeightedError::InvalidNormalizedSum(_)));

    let mut wrong_root = valid.clone();
    wrong_root.params.prior_root = B256::from([0xFF; 32]);
    expect_error(&wrong_root, |e| matches!(e, WeightedError::PriorRootMismatch { .. }));

    let mut wrong_digest = valid.clone();
    wrong_digest.params.manifest_sha256 = B256::from([0xFF; 32]);
    expect_error(&wrong_digest, |e| matches!(e, WeightedError::ManifestDigestMismatch { .. }));
}

#[test]
fn constitutional_max_is_accepted_and_one_more_is_rejected_before_allocation() {
    let maximum = input(2_048);
    let result = compute(&maximum).unwrap();
    assert_eq!(result.scores.len(), 2_048);
    assert_eq!(result.scores.iter().map(|(_, value)| value.to::<u64>()).sum::<u64>(), SCALE);

    let mut oversized = Vec::from(MANIFEST_MAGIC.as_slice());
    oversized.extend_from_slice(&1u16.to_be_bytes());
    oversized.extend_from_slice(&10u64.to_be_bytes());
    oversized.extend_from_slice(&2_049u32.to_be_bytes());
    let mut witness = input(1);
    witness.params.prior_count = 2_049;
    witness.manifest = oversized;
    expect_error(&witness, |e| matches!(e, WeightedError::TooManyPriorEntries(2_049)));
}
