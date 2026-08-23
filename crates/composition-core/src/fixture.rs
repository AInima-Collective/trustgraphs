//! Deterministic production/research fixtures used by tests, the prover CLI, and benchmarks.

use alloy_primitives::{keccak256, Address, B256, U256};

use crate::{
    codec, identity_domain, output_domain, output_kind, program_id, Binding, CapturedManifest,
    CapturedSource, GuestInput, Params, SourcePreimage, MAX_AGGREGATE_BLOB_BYTES,
    MAX_AGGREGATE_ENTRIES, MAX_ENTRIES_PER_SOURCE, MAX_SOURCES, MAX_SOURCE_AGE_BLOCKS,
    MAX_UNION_ACCOUNTS, PARAMS_VERSION, WEIGHT_SCALE,
};

fn address(byte: u8) -> Address {
    Address::from([byte; 20])
}

fn word(byte: u8) -> B256 {
    B256::from([byte; 32])
}

fn account(index: u64) -> Address {
    let mut bytes = [0u8; 20];
    bytes[12..].copy_from_slice(&index.to_be_bytes());
    Address::from(bytes)
}

fn make_source(
    source_id: B256,
    snapshot: Address,
    family_id: B256,
    program_id: B256,
    state_index: u64,
    freeze_block: u64,
    weight: u64,
    max_age_blocks: u64,
    entries: Vec<(Address, u128)>,
) -> (CapturedSource, SourcePreimage) {
    let scores =
        entries.iter().map(|(account, value)| (*account, U256::from(*value))).collect::<Vec<_>>();
    let blob = zk_core::cid::canonical_blob(&scores);
    let digest = zk_core::cid::sha256(&blob);
    let cid = zk_core::cid::cid_v1_raw(&digest);
    let total_value = entries.iter().map(|(_, value)| *value).sum();
    let output_root = zk_core::merkle::merkle_root(
        scores
            .iter()
            .map(|(account, value)| zk_core::merkle::output_leaf(*account, *value))
            .collect(),
    );
    (
        CapturedSource {
            source_id,
            snapshot,
            family_id,
            program_id,
            state_index,
            freeze_block,
            output_root,
            blob_sha256: B256::from(digest),
            cid_digest: keccak256(cid.as_bytes()),
            total_value,
            weight,
            max_age_blocks,
            required: true,
        },
        SourcePreimage { cid, blob },
    )
}

fn input_from(
    chain_id: u64,
    capture_block: u64,
    mut sources: Vec<(CapturedSource, SourcePreimage)>,
    output_pool: u128,
) -> GuestInput {
    sources.sort_by_key(|(source, _)| source.source_id);
    let (source_refs, source_preimages): (Vec<_>, Vec<_>) = sources.into_iter().unzip();
    let admitted_program_id = source_refs[0].program_id;
    let manifest_struct = CapturedManifest { chain_id, capture_block, sources: source_refs };
    let manifest = codec::capture_manifest_encoded(&manifest_struct);
    let policy_manifest = codec::policy_manifest_encoded(chain_id, &manifest_struct.sources);
    let params = Params {
        version: PARAMS_VERSION,
        program_id: program_id(),
        scope_hash: keccak256(b"governance-voice-allocation-v1"),
        identity_domain: identity_domain(),
        output_kind: output_kind(),
        output_domain: output_domain(),
        admitted_program_id,
        weight_scale: WEIGHT_SCALE,
        output_pool,
        source_policy_root: codec::source_policy_root(&manifest_struct.sources),
        source_count: manifest_struct.sources.len() as u8,
        policy_manifest_sha256: codec::manifest_digest(&policy_manifest),
        max_sources: MAX_SOURCES as u8,
        max_entries_per_source: MAX_ENTRIES_PER_SOURCE as u32,
        max_aggregate_entries: MAX_AGGREGATE_ENTRIES as u32,
        max_union_accounts: MAX_UNION_ACCOUNTS as u32,
        max_aggregate_blob_bytes: MAX_AGGREGATE_BLOB_BYTES as u32,
        max_source_age_blocks: MAX_SOURCE_AGE_BLOCKS,
        accumulator: address(0xAC),
        chain_id,
    };
    GuestInput {
        params,
        capture_commitment: codec::manifest_digest(&manifest),
        capture_count: manifest_struct.sources.len() as u64,
        manifest,
        source_preimages,
        binding: Binding {
            recipient: address(0xBE),
            instance_domain: zk_core::journal::instance_domain(address(0x5A), chain_id),
        },
    }
}

pub fn sample_input() -> GuestInput {
    let admitted = keccak256(b"trustgraph-v1:eip155-address:allocation");
    input_from(
        10,
        1_000_000,
        vec![
            make_source(
                word(0xAA),
                address(0xA1),
                word(0xF1),
                admitted,
                7,
                999_900,
                333_000_000_000_000_000,
                1_000,
                vec![
                    (address(0x01), 369_963_739_927_479_854_959_709),
                    (address(0x02), 314_467_628_935_257_870_515_742),
                    (address(0x03), 315_568_631_137_262_274_524_549),
                ],
            ),
            make_source(
                word(0xBB),
                address(0xB1),
                word(0xF2),
                admitted,
                12,
                999_500,
                333_000_000_000_000_000,
                1_000,
                vec![(address(0x02), 50), (address(0x04), 30), (address(0x05), 20)],
            ),
            make_source(
                word(0xCC),
                address(0xC1),
                word(0xF3),
                admitted,
                3,
                999_999,
                334_000_000_000_000_000,
                1_000,
                vec![
                    (address(0x01), 1),
                    (address(0x05), 1),
                    (address(0x06), 2),
                    (address(0x07), 3),
                ],
            ),
        ],
        1_000_000,
    )
}

pub fn post_trigger_input() -> GuestInput {
    let mut current = sample_input();
    let admitted = current.params.admitted_program_id;
    let parsed = codec::parse_capture_manifest(&current.manifest, 10).expect("sample capture");
    let preimages = current.source_preimages;
    let sources = parsed
        .sources
        .into_iter()
        .zip(preimages)
        .map(|pair| {
            if pair.0.source_id == word(0xBB) {
                make_source(
                    word(0xBB),
                    address(0xB1),
                    word(0xF2),
                    admitted,
                    13,
                    1_000_010,
                    333_000_000_000_000_000,
                    1_000,
                    vec![(address(0x09), 100)],
                )
            } else {
                pair
            }
        })
        .collect();
    current = input_from(10, 1_000_010, sources, 1_000_000);
    current
}

/// Deterministic bounded shape with disjoint accounts and an exact aggregate entry count.
pub fn benchmark_input(source_count: usize, aggregate_entries: usize) -> GuestInput {
    assert!((2..=MAX_SOURCES).contains(&source_count));
    assert!(aggregate_entries >= source_count && aggregate_entries <= MAX_AGGREGATE_ENTRIES);
    assert!(aggregate_entries.div_ceil(source_count) <= MAX_ENTRIES_PER_SOURCE);
    let base_entries = aggregate_entries / source_count;
    let extra_entries = aggregate_entries % source_count;
    let base_weight = WEIGHT_SCALE / source_count as u64;
    let extra_weight = WEIGHT_SCALE % source_count as u64;
    let admitted = keccak256(b"trust-graph");
    let mut next_account = 1u64;
    let mut sources = Vec::with_capacity(source_count);
    for index in 0..source_count {
        let count = base_entries + usize::from(index < extra_entries);
        let entries = (0..count)
            .map(|_| {
                let entry = (account(next_account), (next_account % 97 + 1) as u128);
                next_account += 1;
                entry
            })
            .collect();
        sources.push(make_source(
            word(index as u8 + 1),
            address(0x80 + index as u8),
            word(0x40 + index as u8),
            admitted,
            index as u64 + 1,
            2_000_000 - index as u64,
            base_weight + u64::from((index as u64) < extra_weight),
            1_000,
            entries,
        ));
    }
    input_from(10, 2_000_000, sources, WEIGHT_SCALE as u128)
}

/// Same semantic capture assembled from reverse source enumeration, proving builder canonicality.
pub fn reversed_sample_input() -> GuestInput {
    let sample = sample_input();
    let manifest = codec::parse_capture_manifest(&sample.manifest, 10).expect("sample capture");
    let mut sources = manifest.sources.into_iter().zip(sample.source_preimages).collect::<Vec<_>>();
    sources.reverse();
    input_from(10, 1_000_000, sources, 1_000_000)
}

/// Every source quota equals that source's declared total, so the output reproduces the source
/// entries exactly (including their bytes after canonical union ordering).
pub fn reproduction_input() -> GuestInput {
    let admitted = keccak256(b"trust-graph");
    input_from(
        10,
        2_000_000,
        vec![
            make_source(
                word(0x11),
                address(0x91),
                word(0x31),
                admitted,
                1,
                2_000_000,
                600_000_000_000_000_000,
                100,
                vec![(address(0x01), 1), (address(0x02), 2)],
            ),
            make_source(
                word(0x22),
                address(0x92),
                word(0x32),
                admitted,
                2,
                1_999_999,
                400_000_000_000_000_000,
                100,
                vec![(address(0x03), 1), (address(0x04), 1)],
            ),
        ],
        5,
    )
}

/// Equal account remainders inside each positive source quota exercise address-ascending ties.
pub fn remainder_tie_input() -> GuestInput {
    let admitted = keccak256(b"trust-graph");
    input_from(
        10,
        2_000_000,
        vec![
            make_source(
                word(0x11),
                address(0x91),
                word(0x31),
                admitted,
                1,
                2_000_000,
                500_000_000_000_000_000,
                100,
                vec![(address(0x01), 1), (address(0x02), 1), (address(0x03), 1)],
            ),
            make_source(
                word(0x22),
                address(0x92),
                word(0x32),
                admitted,
                2,
                1_999_999,
                500_000_000_000_000_000,
                100,
                vec![(address(0x04), 1), (address(0x05), 1), (address(0x06), 1)],
            ),
        ],
        4,
    )
}
