use alloy_primitives::{keccak256, Address, B256, U256};
use composition_core_v2::{
    codec,
    compute::compute,
    fixture::{
        benchmark_input, contributions_output_domain, contributions_program_id,
        incompatible_third_program_input, mixed_input,
    },
    program_id, trust_graph_output_domain, weighted_trust_graph_output_domain, CompositionError,
    GuestInput, MAX_AGGREGATE_ENTRIES,
};

const FIRST: usize = codec::CAPTURE_HEADER_LENGTH;
const SECOND: usize = codec::CAPTURE_HEADER_LENGTH + codec::CAPTURE_RECORD_LENGTH;

fn rebind_capture(input: &mut GuestInput) {
    input.capture_commitment = codec::manifest_digest(&input.manifest);
}

fn write_bytes(input: &mut GuestInput, offset: usize, bytes: &[u8]) {
    input.manifest[offset..offset + bytes.len()].copy_from_slice(bytes);
    rebind_capture(input);
}

fn expect(input: &GuestInput, predicate: impl FnOnce(&CompositionError) -> bool) {
    let error = compute(input).unwrap_err();
    assert!(predicate(&error), "unexpected error: {error}");
}

#[test]
fn malformed_capture_and_checkpoint_bindings_fail_closed() {
    let valid = mixed_input();

    let mut input = valid.clone();
    input.manifest[0] ^= 1;
    rebind_capture(&mut input);
    expect(&input, |error| matches!(error, CompositionError::InvalidCaptureMagic));

    // A V1 capture manifest replayed under V2 is a version error, not a guess.
    let mut input = valid.clone();
    input.manifest[5] = 1;
    rebind_capture(&mut input);
    expect(&input, |error| matches!(error, CompositionError::UnsupportedCaptureVersion(1)));

    let mut input = valid.clone();
    input.manifest.pop();
    rebind_capture(&mut input);
    expect(&input, |error| matches!(error, CompositionError::InvalidCaptureManifestLength { .. }));

    let mut input = valid.clone();
    input.capture_commitment = B256::from([0xFF; 32]);
    expect(&input, |error| matches!(error, CompositionError::CaptureCommitmentMismatch { .. }));

    let mut input = valid.clone();
    input.capture_count -= 1;
    expect(&input, |error| matches!(error, CompositionError::CaptureCountMismatch { .. }));

    let mut input = valid;
    input.source_preimages.pop();
    expect(&input, |error| matches!(error, CompositionError::SourcePreimageCountMismatch { .. }));
}

#[test]
fn source_identity_program_freshness_and_policy_fail_closed() {
    let valid = mixed_input();

    let mut input = valid.clone();
    let first_id = input.manifest[FIRST..FIRST + 32].to_vec();
    write_bytes(&mut input, SECOND, &first_id);
    expect(&input, |error| matches!(error, CompositionError::SourceIdsNotStrictlySorted));

    let mut input = valid.clone();
    let snapshot = input.manifest[FIRST + 32..FIRST + 52].to_vec();
    write_bytes(&mut input, SECOND + 32, &snapshot);
    expect(&input, |error| matches!(error, CompositionError::DuplicateSnapshot(_)));

    let mut input = valid.clone();
    write_bytes(&mut input, FIRST + 84, program_id().as_slice());
    expect(&input, |error| matches!(error, CompositionError::CompositeSourceForbidden));

    let mut input = valid.clone();
    write_bytes(&mut input, FIRST + 84, B256::from([0x77; 32]).as_slice());
    expect(&input, |error| matches!(error, CompositionError::UnadmittedSourceProgram(_)));

    let mut input = valid.clone();
    write_bytes(&mut input, FIRST + 156, &1u64.to_be_bytes());
    expect(&input, |error| matches!(error, CompositionError::StaleSource(_)));

    let mut input = valid.clone();
    input.params.source_policy_root = B256::from([0xAA; 32]);
    expect(&input, |error| matches!(error, CompositionError::SourcePolicyRootMismatch { .. }));
}

#[test]
fn program_output_domain_pairs_are_constitutional() {
    let valid = mixed_input();

    // The standard source cannot borrow the weighted domain.
    let mut input = valid.clone();
    write_bytes(&mut input, FIRST + 116, weighted_trust_graph_output_domain().as_slice());
    expect(&input, |error| matches!(error, CompositionError::WrongSourceOutputDomain { .. }));

    // The weighted source cannot borrow the standard domain.
    let mut input = valid.clone();
    write_bytes(&mut input, SECOND + 116, trust_graph_output_domain().as_slice());
    expect(&input, |error| matches!(error, CompositionError::WrongSourceOutputDomain { .. }));

    // An arbitrary domain under an admitted program is equally rejected.
    let mut input = valid;
    write_bytes(&mut input, FIRST + 116, B256::from([0x66; 32]).as_slice());
    expect(&input, |error| matches!(error, CompositionError::WrongSourceOutputDomain { .. }));
}

#[test]
fn unadmitted_third_program_is_rejected_before_its_blob_is_touched() {
    // Source C's preimage is empty bytes: any decode attempt would fail with a
    // blob error, so the pair rejection below proves admission runs first.
    let input =
        incompatible_third_program_input(contributions_program_id(), contributions_output_domain());
    expect(
        &input,
        |error| matches!(error, CompositionError::UnadmittedSourceProgram(id) if *id == contributions_program_id()),
    );

    // Copying an allowed domain value does not admit an unknown program.
    for domain in [trust_graph_output_domain(), weighted_trust_graph_output_domain()] {
        let input = incompatible_third_program_input(contributions_program_id(), domain);
        expect(&input, |error| matches!(error, CompositionError::UnadmittedSourceProgram(_)));
    }
}

#[test]
fn wrong_compatibility_class_fails_closed() {
    let mut input = mixed_input();
    input.params.source_compatibility_class = B256::from([0x11; 32]);
    expect(&input, |error| matches!(error, CompositionError::InvalidCompatibilityClass(_)));

    let mut input = mixed_input();
    input.params.source_compatibility_class = B256::ZERO;
    expect(&input, |error| matches!(error, CompositionError::InvalidCompatibilityClass(_)));
}

#[test]
fn complete_blob_digest_cid_total_and_root_fail_closed() {
    let valid = mixed_input();

    let mut input = valid.clone();
    input.source_preimages[0].blob[10] ^= 1;
    expect(&input, |error| matches!(error, CompositionError::BlobSha256Mismatch(_)));

    let mut input = valid.clone();
    input.source_preimages[0].cid = input.source_preimages[1].cid.clone();
    expect(&input, |error| matches!(error, CompositionError::CidDigestMismatch(_)));

    let mut input = valid.clone();
    write_bytes(&mut input, FIRST + 164, B256::ZERO.as_slice());
    expect(&input, |error| matches!(error, CompositionError::SourceRootMismatch(_)));

    let mut input = valid;
    write_bytes(&mut input, FIRST + 260, &1u128.to_be_bytes());
    expect(&input, |error| matches!(error, CompositionError::SourceTotalMismatch(_)));
}

#[test]
fn strict_blob_decoder_rejects_duplicates_whitespace_case_zero_and_overflow() {
    let account = "0x0101010101010101010101010101010101010101";
    for blob in [
        format!("{{ \"{account}\":\"1\"}}"),
        format!("{{\"{account}\":\"1\",\"{account}\":\"1\"}}"),
        format!("{{\"{}\":\"1\"}}", account.to_uppercase()),
        format!("{{\"{account}\":\"0\"}}"),
        format!("{{\"{account}\":\"01\"}}"),
        format!("{{\"{account}\":\"{}0\"}}", u128::MAX),
    ] {
        assert!(composition_core_v2::blob::decode_canonical_score_blob(blob.as_bytes()).is_err());
    }
}

#[test]
fn every_constitutional_cap_is_enforced_and_exact_maximum_is_accepted() {
    let maximum = benchmark_input(8, MAX_AGGREGATE_ENTRIES);
    let result = compute(&maximum).unwrap();
    assert_eq!(result.scores.len(), MAX_AGGREGATE_ENTRIES);
    assert_eq!(result.journal.total_value, U256::from(maximum.params.output_pool));

    let mut input = maximum.clone();
    input.params.max_aggregate_entries -= 1;
    input.params.max_union_accounts -= 1;
    expect(&input, |error| matches!(error, CompositionError::AggregateEntryLimit(_)));

    let mut input = maximum.clone();
    input.params.max_union_accounts -= 1;
    expect(&input, |error| matches!(error, CompositionError::UnionAccountLimit(_)));

    let mut input = maximum;
    let bytes: usize = input.source_preimages.iter().map(|source| source.blob.len()).sum();
    input.params.max_aggregate_blob_bytes = (bytes - 1) as u32;
    expect(&input, |error| matches!(error, CompositionError::AggregateBlobByteLimit(_)));
}

#[test]
fn required_zero_quota_u128_pool_and_arithmetic_overflow_behave_explicitly() {
    let mut input = mixed_input();
    input.params.output_pool = 1;
    expect(&input, |error| matches!(error, CompositionError::RequiredSourceReceivedZero(_)));

    let mut input = mixed_input();
    input.params.output_pool = u128::MAX;
    let result = compute(&input).unwrap();
    assert_eq!(result.journal.total_value, U256::from(u128::MAX));

    let mut input = mixed_input();
    let a = "0x0101010101010101010101010101010101010101";
    let b = "0x0202020202020202020202020202020202020202";
    let blob = format!("{{\"{a}\":\"{}\",\"{b}\":\"1\"}}", u128::MAX).into_bytes();
    let digest = zk_core::cid::sha256(&blob);
    let cid = zk_core::cid::cid_v1_raw(&digest);
    input.source_preimages[0].blob = blob;
    input.source_preimages[0].cid = cid.clone();
    write_bytes(&mut input, FIRST + 196, &digest);
    write_bytes(&mut input, FIRST + 228, keccak256(cid.as_bytes()).as_slice());
    expect(&input, |error| matches!(error, CompositionError::ArithmeticOverflow));
}

#[test]
fn params_domains_program_bounds_and_version_are_constitutional() {
    let valid = mixed_input();
    let mut input = valid.clone();
    input.params.version = 1;
    expect(&input, |error| matches!(error, CompositionError::UnsupportedParamsVersion(1)));

    let mut input = valid.clone();
    input.params.output_domain = B256::ZERO;
    expect(&input, |error| matches!(error, CompositionError::WrongOutputDomain));

    let mut input = valid;
    input.params.max_sources = 9;
    expect(&input, |error| matches!(error, CompositionError::InvalidBounds));
}

#[test]
fn guest_input_json_round_trip_preserves_exact_manifest_and_blobs() {
    let input = mixed_input();
    let json = serde_json::to_string(&input).unwrap();
    let decoded: GuestInput = serde_json::from_str(&json).unwrap();
    assert_eq!(decoded, input);
    assert_eq!(compute(&decoded).unwrap().journal, compute(&input).unwrap().journal);
    assert_ne!(decoded.params.accumulator, Address::ZERO);
}
