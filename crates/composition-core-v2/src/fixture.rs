//! Deterministic V2 fixtures used by tests, the prover CLI, and benchmarks.
//! The mixed fixture reproduces the frozen `trust-compose-v2` golden vector.

use alloy_primitives::{keccak256, Address, B256, U256};

use crate::{
    codec, identity_domain, output_domain, output_kind, program_id, source_compatibility_class_v1,
    trust_graph_output_domain, trust_graph_program_id, weighted_trust_graph_output_domain,
    weighted_trust_graph_program_id, Binding, CapturedManifest, CapturedSource, GuestInput, Params,
    SourcePreimage, MAX_AGGREGATE_BLOB_BYTES, MAX_AGGREGATE_ENTRIES, MAX_ENTRIES_PER_SOURCE,
    MAX_SOURCES, MAX_SOURCE_AGE_BLOCKS, MAX_UNION_ACCOUNTS, PARAMS_VERSION, WEIGHT_SCALE,
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
    source_output_domain: B256,
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
            source_output_domain,
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

fn standard_source_a(weight: u64) -> (CapturedSource, SourcePreimage) {
    make_source(
        word(0xAA),
        address(0xA1),
        word(0xF1),
        trust_graph_program_id(),
        trust_graph_output_domain(),
        7,
        999_900,
        weight,
        1_000,
        vec![
            (address(0x01), 900_000_000_000_000_000_000_000),
            (address(0x02), 100_000_000_000_000_000_000_000),
        ],
    )
}

fn weighted_source_b(weight: u64) -> (CapturedSource, SourcePreimage) {
    make_source(
        word(0xBB),
        address(0xB1),
        word(0xF2),
        weighted_trust_graph_program_id(),
        weighted_trust_graph_output_domain(),
        12,
        999_500,
        weight,
        1_000,
        vec![
            (address(0x02), 166_666_666_666_666_667),
            (address(0x03), 333_333_333_333_333_333),
            (address(0x04), 500_000_000_000_000_000),
        ],
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
        source_compatibility_class: source_compatibility_class_v1(),
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
        accumulator: address(0xC0),
        chain_id,
    };
    GuestInput {
        params,
        capture_commitment: codec::manifest_digest(&manifest),
        capture_count: manifest_struct.sources.len() as u64,
        manifest,
        source_preimages,
        binding: Binding { recipient: address(0xD1), instance_domain: word(0xD2) },
    }
}

/// The frozen mixed fixture: 40% standard `trust-graph` source A (1e24 pool)
/// plus 60% `trust-graph-weighted` source B (1e18 pool) over a 1,000-point
/// composite pool.
pub fn mixed_input() -> GuestInput {
    input_from(
        10,
        1_000_000,
        vec![
            standard_source_a(400_000_000_000_000_000),
            weighted_source_b(600_000_000_000_000_000),
        ],
        1_000,
    )
}

/// Same semantic capture assembled from reverse source enumeration, proving
/// builder canonicality.
pub fn reversed_mixed_input() -> GuestInput {
    input_from(
        10,
        1_000_000,
        vec![
            weighted_source_b(600_000_000_000_000_000),
            standard_source_a(400_000_000_000_000_000),
        ],
        1_000,
    )
}

/// A valid policy rotation of the mixed fixture: same class and sources with
/// equal weights.
pub fn rotated_mixed_input() -> GuestInput {
    input_from(
        10,
        1_000_000,
        vec![
            standard_source_a(500_000_000_000_000_000),
            weighted_source_b(500_000_000_000_000_000),
        ],
        1_000,
    )
}

/// A/B reweighted to 35%/55% plus a structurally valid 10% third source whose
/// program/output pair is outside the class. The third preimage is deliberately
/// unusable: admission must reject the pair before any blob is decoded.
pub fn incompatible_third_program_input(
    program_id: B256,
    source_output_domain: B256,
) -> GuestInput {
    let (source_c, _) = make_source(
        word(0xCC),
        address(0xC1),
        word(0xF3),
        program_id,
        source_output_domain,
        13,
        999_800,
        100_000_000_000_000_000,
        1_000,
        vec![(address(0x05), 1)],
    );
    input_from(
        10,
        1_000_000,
        vec![
            standard_source_a(350_000_000_000_000_000),
            weighted_source_b(550_000_000_000_000_000),
            (source_c, SourcePreimage { cid: String::new(), blob: Vec::new() }),
        ],
        1_000,
    )
}

pub fn contributions_program_id() -> B256 {
    keccak256(b"contributions")
}

pub fn contributions_output_domain() -> B256 {
    keccak256(b"trustgraphs.output.contributions-recipient.v1")
}

/// Deterministic bounded shape with disjoint accounts, an exact aggregate entry
/// count, and alternating standard/weighted source programs so maximum-shape
/// measurements exercise mixed admission.
pub fn benchmark_input(source_count: usize, aggregate_entries: usize) -> GuestInput {
    assert!((2..=MAX_SOURCES).contains(&source_count));
    assert!(aggregate_entries >= source_count && aggregate_entries <= MAX_AGGREGATE_ENTRIES);
    assert!(aggregate_entries.div_ceil(source_count) <= MAX_ENTRIES_PER_SOURCE);
    let base_entries = aggregate_entries / source_count;
    let extra_entries = aggregate_entries % source_count;
    let base_weight = WEIGHT_SCALE / source_count as u64;
    let extra_weight = WEIGHT_SCALE % source_count as u64;
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
        let (program, domain) = if index % 2 == 0 {
            (trust_graph_program_id(), trust_graph_output_domain())
        } else {
            (weighted_trust_graph_program_id(), weighted_trust_graph_output_domain())
        };
        sources.push(make_source(
            word(index as u8 + 1),
            address(0x80 + index as u8),
            word(0x40 + index as u8),
            program,
            domain,
            index as u64 + 1,
            2_000_000 - index as u64,
            base_weight + u64::from((index as u64) < extra_weight),
            1_000,
            entries,
        ));
    }
    input_from(10, 2_000_000, sources, WEIGHT_SCALE as u128)
}
