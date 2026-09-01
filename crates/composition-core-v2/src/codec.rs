//! Frozen `TGCP`/`TGCM` V2, params, and journal encodings.
//!
//! V2 widens each record by one 32-byte `sourceOutputDomain` field after
//! `programId`. V1 parsers reject manifest version 2 and this parser rejects
//! version 1; neither guesses from byte length.

use alloy_primitives::{keccak256, Address, B256, U256};

use crate::{
    CapturedManifest, CapturedSource, CompositionError, Journal, Params, CAPTURE_MAGIC,
    MANIFEST_VERSION, POLICY_MAGIC,
};

pub const CAPTURE_HEADER_LENGTH: usize = 23;
pub const CAPTURE_RECORD_LENGTH: usize = 293;
pub const POLICY_HEADER_LENGTH: usize = 15;
pub const POLICY_RECORD_LENGTH: usize = 165;

fn read_u16(bytes: &[u8], offset: usize) -> u16 {
    u16::from_be_bytes(bytes[offset..offset + 2].try_into().expect("checked manifest length"))
}

fn read_u64(bytes: &[u8], offset: usize) -> u64 {
    u64::from_be_bytes(bytes[offset..offset + 8].try_into().expect("checked manifest length"))
}

fn read_u128(bytes: &[u8], offset: usize) -> u128 {
    u128::from_be_bytes(bytes[offset..offset + 16].try_into().expect("checked manifest length"))
}

fn read_b256(bytes: &[u8], offset: usize) -> B256 {
    B256::from_slice(&bytes[offset..offset + 32])
}

fn read_address(bytes: &[u8], offset: usize) -> Address {
    Address::from_slice(&bytes[offset..offset + 20])
}

pub fn parse_capture_manifest(
    bytes: &[u8],
    expected_chain: u64,
) -> Result<CapturedManifest, CompositionError> {
    if bytes.len() < CAPTURE_HEADER_LENGTH {
        return Err(CompositionError::CaptureManifestTooShort(bytes.len()));
    }
    if &bytes[..4] != CAPTURE_MAGIC {
        return Err(CompositionError::InvalidCaptureMagic);
    }
    let version = read_u16(bytes, 4);
    if version != MANIFEST_VERSION {
        return Err(CompositionError::UnsupportedCaptureVersion(version));
    }
    let chain_id = read_u64(bytes, 6);
    if chain_id != expected_chain {
        return Err(CompositionError::WrongCaptureChain {
            expected: expected_chain,
            actual: chain_id,
        });
    }
    let capture_block = read_u64(bytes, 14);
    let count = bytes[22] as usize;
    let expected = CAPTURE_HEADER_LENGTH + count * CAPTURE_RECORD_LENGTH;
    if bytes.len() != expected {
        return Err(CompositionError::InvalidCaptureManifestLength {
            expected,
            actual: bytes.len(),
        });
    }
    let mut sources = Vec::with_capacity(count);
    for index in 0..count {
        let base = CAPTURE_HEADER_LENGTH + index * CAPTURE_RECORD_LENGTH;
        sources.push(CapturedSource {
            source_id: read_b256(bytes, base),
            snapshot: read_address(bytes, base + 32),
            family_id: read_b256(bytes, base + 52),
            program_id: read_b256(bytes, base + 84),
            source_output_domain: read_b256(bytes, base + 116),
            state_index: read_u64(bytes, base + 148),
            freeze_block: read_u64(bytes, base + 156),
            output_root: read_b256(bytes, base + 164),
            blob_sha256: read_b256(bytes, base + 196),
            cid_digest: read_b256(bytes, base + 228),
            total_value: read_u128(bytes, base + 260),
            weight: read_u64(bytes, base + 276),
            max_age_blocks: read_u64(bytes, base + 284),
            required: bytes[base + 292] == 1,
        });
        if bytes[base + 292] > 1 {
            return Err(CompositionError::OptionalSourceUnsupported);
        }
    }
    Ok(CapturedManifest { chain_id, capture_block, sources })
}

pub fn capture_manifest_encoded(manifest: &CapturedManifest) -> Vec<u8> {
    let mut sources = manifest.sources.clone();
    sources.sort_by_key(|source| source.source_id);
    let mut out = Vec::with_capacity(CAPTURE_HEADER_LENGTH + sources.len() * CAPTURE_RECORD_LENGTH);
    out.extend_from_slice(CAPTURE_MAGIC);
    out.extend_from_slice(&MANIFEST_VERSION.to_be_bytes());
    out.extend_from_slice(&manifest.chain_id.to_be_bytes());
    out.extend_from_slice(&manifest.capture_block.to_be_bytes());
    out.push(sources.len() as u8);
    for source in sources {
        out.extend_from_slice(source.source_id.as_slice());
        out.extend_from_slice(source.snapshot.as_slice());
        out.extend_from_slice(source.family_id.as_slice());
        out.extend_from_slice(source.program_id.as_slice());
        out.extend_from_slice(source.source_output_domain.as_slice());
        out.extend_from_slice(&source.state_index.to_be_bytes());
        out.extend_from_slice(&source.freeze_block.to_be_bytes());
        out.extend_from_slice(source.output_root.as_slice());
        out.extend_from_slice(source.blob_sha256.as_slice());
        out.extend_from_slice(source.cid_digest.as_slice());
        out.extend_from_slice(&source.total_value.to_be_bytes());
        out.extend_from_slice(&source.weight.to_be_bytes());
        out.extend_from_slice(&source.max_age_blocks.to_be_bytes());
        out.push(u8::from(source.required));
    }
    out
}

pub fn manifest_digest(bytes: &[u8]) -> B256 {
    B256::from(zk_core::cid::sha256(bytes))
}

/// `keccak256(abi.encode(sourceId, snapshot, familyId, programId,
/// sourceOutputDomain, weight, maxAge, required))`.
pub fn source_policy_leaf(source: &CapturedSource) -> B256 {
    let mut encoded = Vec::with_capacity(32 * 8);
    encoded.extend_from_slice(source.source_id.as_slice());
    encoded.extend_from_slice(&zk_core::words::word_addr(source.snapshot));
    encoded.extend_from_slice(source.family_id.as_slice());
    encoded.extend_from_slice(source.program_id.as_slice());
    encoded.extend_from_slice(source.source_output_domain.as_slice());
    encoded.extend_from_slice(&zk_core::words::word_u64(source.weight));
    encoded.extend_from_slice(&zk_core::words::word_u64(source.max_age_blocks));
    encoded.extend_from_slice(&zk_core::words::word_u8(u8::from(source.required)));
    keccak256(encoded)
}

/// Source-id-order leaves, sorted-pair parents, and odd-node promotion.
pub fn source_policy_root(sources: &[CapturedSource]) -> B256 {
    if sources.is_empty() {
        return B256::ZERO;
    }
    let mut sources = sources.to_vec();
    sources.sort_by_key(|source| source.source_id);
    let mut level = sources.iter().map(source_policy_leaf).collect::<Vec<_>>();
    while level.len() > 1 {
        let mut next = Vec::with_capacity(level.len().div_ceil(2));
        for pair in level.chunks(2) {
            if pair.len() == 1 {
                next.push(pair[0]);
            } else {
                let (left, right) =
                    if pair[0] <= pair[1] { (pair[0], pair[1]) } else { (pair[1], pair[0]) };
                let mut bytes = [0u8; 64];
                bytes[..32].copy_from_slice(left.as_slice());
                bytes[32..].copy_from_slice(right.as_slice());
                next.push(keccak256(bytes));
            }
        }
        level = next;
    }
    level[0]
}

pub fn policy_manifest_encoded(chain_id: u64, sources: &[CapturedSource]) -> Vec<u8> {
    let mut sources = sources.to_vec();
    sources.sort_by_key(|source| source.source_id);
    let mut out = Vec::with_capacity(POLICY_HEADER_LENGTH + sources.len() * POLICY_RECORD_LENGTH);
    out.extend_from_slice(POLICY_MAGIC);
    out.extend_from_slice(&MANIFEST_VERSION.to_be_bytes());
    out.extend_from_slice(&chain_id.to_be_bytes());
    out.push(sources.len() as u8);
    for source in sources {
        out.extend_from_slice(source.source_id.as_slice());
        out.extend_from_slice(source.snapshot.as_slice());
        out.extend_from_slice(source.family_id.as_slice());
        out.extend_from_slice(source.program_id.as_slice());
        out.extend_from_slice(source.source_output_domain.as_slice());
        out.extend_from_slice(&source.weight.to_be_bytes());
        out.extend_from_slice(&source.max_age_blocks.to_be_bytes());
        out.push(u8::from(source.required));
    }
    out
}

/// Frozen 20-word `trust-compose` V2 parameter tuple. Word 6 is the source
/// compatibility class; it must never be exposed under the V1 field name after
/// version dispatch.
pub fn params_encoded(params: &Params) -> Vec<u8> {
    let mut out = Vec::with_capacity(32 * 20);
    out.extend_from_slice(&zk_core::words::word_u32(params.version));
    out.extend_from_slice(params.program_id.as_slice());
    out.extend_from_slice(params.scope_hash.as_slice());
    out.extend_from_slice(params.identity_domain.as_slice());
    out.extend_from_slice(params.output_kind.as_slice());
    out.extend_from_slice(params.output_domain.as_slice());
    out.extend_from_slice(params.source_compatibility_class.as_slice());
    out.extend_from_slice(&zk_core::words::word_u64(params.weight_scale));
    out.extend_from_slice(&zk_core::words::word_u256(U256::from(params.output_pool)));
    out.extend_from_slice(params.source_policy_root.as_slice());
    out.extend_from_slice(&zk_core::words::word_u8(params.source_count));
    out.extend_from_slice(params.policy_manifest_sha256.as_slice());
    out.extend_from_slice(&zk_core::words::word_u8(params.max_sources));
    out.extend_from_slice(&zk_core::words::word_u32(params.max_entries_per_source));
    out.extend_from_slice(&zk_core::words::word_u32(params.max_aggregate_entries));
    out.extend_from_slice(&zk_core::words::word_u32(params.max_union_accounts));
    out.extend_from_slice(&zk_core::words::word_u32(params.max_aggregate_blob_bytes));
    out.extend_from_slice(&zk_core::words::word_u64(params.max_source_age_blocks));
    out.extend_from_slice(&zk_core::words::word_addr(params.accumulator));
    out.extend_from_slice(&zk_core::words::word_u64(params.chain_id));
    out
}

pub fn params_hash(params: &Params) -> B256 {
    keccak256(params_encoded(params))
}

pub fn journal_encoded(journal: &Journal) -> Vec<u8> {
    let mut out = Vec::with_capacity(32 * 12);
    out.extend_from_slice(journal.acc.as_slice());
    out.extend_from_slice(&zk_core::words::word_u64(journal.leaf_count));
    out.extend_from_slice(journal.anchor_acc.as_slice());
    out.extend_from_slice(&zk_core::words::word_u64(journal.anchor_count));
    out.extend_from_slice(journal.params_hash.as_slice());
    out.extend_from_slice(journal.output_root.as_slice());
    out.extend_from_slice(journal.ipfs_hash.as_slice());
    out.extend_from_slice(journal.cid_digest.as_slice());
    out.extend_from_slice(&zk_core::words::word_u256(journal.total_value));
    out.extend_from_slice(journal.skipped_digest.as_slice());
    out.extend_from_slice(&zk_core::words::word_addr(journal.recipient));
    out.extend_from_slice(journal.instance_domain.as_slice());
    out
}

pub fn journal_digest(journal: &Journal) -> B256 {
    keccak256(journal_encoded(journal))
}
