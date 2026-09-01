//! Top-level V2 composition shared byte-for-byte by native hosts and the SP1
//! guest. The blend arithmetic is identical to V1; only source admission (the
//! closed program/output-domain class) and the widened commitments differ.

use std::collections::{BTreeMap, BTreeSet};

use alloy_primitives::{keccak256, Address, B256, U256};

use crate::{
    admitted_source_output_domain, blob, codec, hamilton::apportion, AllocationEntry,
    CompositionError, ComputeResult, GuestInput, Journal, SourceAllocation, SourcePreimage,
    WEIGHT_SCALE,
};

struct ValidatedSource {
    source_id: B256,
    total_value: u128,
    weight: u64,
    entries: Vec<(Address, u128)>,
}

fn validate_source_blob(
    source: &crate::CapturedSource,
    preimage: &SourcePreimage,
    max_entries: usize,
) -> Result<ValidatedSource, CompositionError> {
    if keccak256(preimage.cid.as_bytes()) != source.cid_digest {
        return Err(CompositionError::CidDigestMismatch(source.source_id));
    }
    let blob_sha256 = B256::from(zk_core::cid::sha256(&preimage.blob));
    if blob_sha256 != source.blob_sha256 {
        return Err(CompositionError::BlobSha256Mismatch(source.source_id));
    }
    if zk_core::cid::cid_v1_raw(&blob_sha256.0) != preimage.cid {
        return Err(CompositionError::CidMismatch(source.source_id));
    }
    let entries = blob::decode_canonical_score_blob(&preimage.blob)?;
    if entries.len() > max_entries {
        return Err(CompositionError::TooManyEntries {
            source_id: source.source_id,
            count: entries.len(),
        });
    }
    let total = entries.iter().try_fold(0u128, |sum, (_, value)| {
        sum.checked_add(*value).ok_or(CompositionError::ArithmeticOverflow)
    })?;
    if total != source.total_value {
        return Err(CompositionError::SourceTotalMismatch(source.source_id));
    }
    if blob::output_root(&entries) != source.output_root {
        return Err(CompositionError::SourceRootMismatch(source.source_id));
    }
    Ok(ValidatedSource {
        source_id: source.source_id,
        total_value: source.total_value,
        weight: source.weight,
        entries,
    })
}

pub fn compute(input: &GuestInput) -> Result<ComputeResult, CompositionError> {
    input.params.validate()?;
    let actual_capture = codec::manifest_digest(&input.manifest);
    if actual_capture != input.capture_commitment {
        return Err(CompositionError::CaptureCommitmentMismatch {
            expected: input.capture_commitment,
            actual: actual_capture,
        });
    }
    let manifest = codec::parse_capture_manifest(&input.manifest, input.params.chain_id)?;
    let count = manifest.sources.len();
    if input.capture_count as usize != count {
        return Err(CompositionError::CaptureCountMismatch {
            expected: input.capture_count as usize,
            actual: count,
        });
    }
    if input.params.source_count as usize != count {
        return Err(CompositionError::CaptureCountMismatch {
            expected: input.params.source_count as usize,
            actual: count,
        });
    }
    if input.source_preimages.len() != count {
        return Err(CompositionError::SourcePreimageCountMismatch {
            expected: count,
            actual: input.source_preimages.len(),
        });
    }

    // Every static policy check, including program/output-domain admission,
    // runs before any source blob preimage is touched.
    let mut previous_id = None;
    let mut snapshots = BTreeSet::new();
    let mut weight_sum = 0u128;
    for source in &manifest.sources {
        if source.source_id == B256::ZERO {
            return Err(CompositionError::ZeroSourceId);
        }
        if previous_id.is_some_and(|previous| previous >= source.source_id) {
            return Err(CompositionError::SourceIdsNotStrictlySorted);
        }
        previous_id = Some(source.source_id);
        if source.snapshot == Address::ZERO {
            return Err(CompositionError::ZeroSnapshot);
        }
        if !snapshots.insert(source.snapshot) {
            return Err(CompositionError::DuplicateSnapshot(source.snapshot));
        }
        if source.family_id == B256::ZERO {
            return Err(CompositionError::ZeroFamilyId);
        }
        if source.program_id == crate::program_id() {
            return Err(CompositionError::CompositeSourceForbidden);
        }
        let Some(admitted_domain) = admitted_source_output_domain(source.program_id) else {
            return Err(CompositionError::UnadmittedSourceProgram(source.program_id));
        };
        if source.source_output_domain != admitted_domain {
            return Err(CompositionError::WrongSourceOutputDomain {
                program_id: source.program_id,
                domain: source.source_output_domain,
            });
        }
        if !source.required {
            return Err(CompositionError::OptionalSourceUnsupported);
        }
        if source.weight == 0 {
            return Err(CompositionError::InvalidSourceWeight(source.source_id));
        }
        weight_sum = weight_sum
            .checked_add(source.weight as u128)
            .ok_or(CompositionError::ArithmeticOverflow)?;
        if source.max_age_blocks == 0 || source.max_age_blocks > input.params.max_source_age_blocks
        {
            return Err(CompositionError::InvalidSourceAge {
                source_id: source.source_id,
                max_age: source.max_age_blocks,
            });
        }
        if source.freeze_block > manifest.capture_block
            || manifest.capture_block - source.freeze_block > source.max_age_blocks
        {
            return Err(CompositionError::StaleSource(source.source_id));
        }
        if source.total_value == 0 {
            return Err(CompositionError::InvalidSourceTotal(source.source_id));
        }
    }
    if weight_sum != WEIGHT_SCALE as u128 {
        return Err(CompositionError::InvalidSourceWeightSum(weight_sum));
    }
    let policy_manifest = codec::policy_manifest_encoded(input.params.chain_id, &manifest.sources);
    let actual_policy_sha = codec::manifest_digest(&policy_manifest);
    if actual_policy_sha != input.params.policy_manifest_sha256 {
        return Err(CompositionError::PolicyManifestMismatch {
            expected: input.params.policy_manifest_sha256,
            actual: actual_policy_sha,
        });
    }
    let actual_policy_root = codec::source_policy_root(&manifest.sources);
    if actual_policy_root != input.params.source_policy_root {
        return Err(CompositionError::SourcePolicyRootMismatch {
            expected: input.params.source_policy_root,
            actual: actual_policy_root,
        });
    }

    let aggregate_blob_bytes = input.source_preimages.iter().try_fold(0usize, |sum, source| {
        sum.checked_add(source.blob.len()).ok_or(CompositionError::ArithmeticOverflow)
    })?;
    if aggregate_blob_bytes > input.params.max_aggregate_blob_bytes as usize {
        return Err(CompositionError::AggregateBlobByteLimit(aggregate_blob_bytes));
    }
    let validated = manifest
        .sources
        .iter()
        .zip(&input.source_preimages)
        .map(|(source, preimage)| {
            validate_source_blob(source, preimage, input.params.max_entries_per_source as usize)
        })
        .collect::<Result<Vec<_>, CompositionError>>()?;
    let aggregate_entries = validated.iter().try_fold(0usize, |sum, source| {
        sum.checked_add(source.entries.len()).ok_or(CompositionError::ArithmeticOverflow)
    })?;
    if aggregate_entries > input.params.max_aggregate_entries as usize {
        return Err(CompositionError::AggregateEntryLimit(aggregate_entries));
    }
    let union = validated
        .iter()
        .flat_map(|source| source.entries.iter().map(|(account, _)| *account))
        .collect::<BTreeSet<_>>();
    if union.len() > input.params.max_union_accounts as usize {
        return Err(CompositionError::UnionAccountLimit(union.len()));
    }

    let quotas = apportion(
        input.params.output_pool,
        input.params.weight_scale as u128,
        &validated
            .iter()
            .map(|source| (source.source_id, source.weight as u128))
            .collect::<Vec<_>>(),
    )?;
    let mut source_allocations = Vec::with_capacity(validated.len());
    let mut combined = BTreeMap::<Address, u128>::new();
    for quota in quotas {
        if quota.allocation == 0 {
            return Err(CompositionError::RequiredSourceReceivedZero(quota.key));
        }
        let source = validated
            .iter()
            .find(|source| source.source_id == quota.key)
            .expect("quota source came from validated sources");
        let allocations = apportion(quota.allocation, source.total_value, &source.entries)?
            .into_iter()
            .filter(|entry| entry.allocation > 0)
            .map(|entry| AllocationEntry { account: entry.key, value: entry.allocation })
            .collect::<Vec<_>>();
        for entry in &allocations {
            let value = combined.entry(entry.account).or_default();
            *value = value.checked_add(entry.value).ok_or(CompositionError::ArithmeticOverflow)?;
        }
        source_allocations.push(SourceAllocation {
            source_id: quota.key,
            quota: quota.allocation,
            allocations,
        });
    }
    let output_total = combined.values().try_fold(0u128, |sum, value| {
        sum.checked_add(*value).ok_or(CompositionError::ArithmeticOverflow)
    })?;
    if output_total != input.params.output_pool {
        return Err(CompositionError::OutputPoolMismatch);
    }
    let scores = combined
        .into_iter()
        .filter(|(_, value)| *value > 0)
        .map(|(account, value)| (account, U256::from(value)))
        .collect::<Vec<_>>();
    let output_root = zk_core::merkle::merkle_root(
        scores
            .iter()
            .map(|(account, value)| zk_core::merkle::output_leaf(*account, *value))
            .collect(),
    );
    let blob = zk_core::cid::canonical_blob(&scores);
    let sha256 = zk_core::cid::sha256(&blob);
    let cid = zk_core::cid::cid_v1_raw(&sha256);
    let journal = Journal {
        acc: input.capture_commitment,
        leaf_count: input.capture_count,
        anchor_acc: B256::ZERO,
        anchor_count: 0,
        params_hash: codec::params_hash(&input.params),
        output_root,
        ipfs_hash: B256::from(sha256),
        cid_digest: keccak256(cid.as_bytes()),
        total_value: U256::from(output_total),
        skipped_digest: B256::ZERO,
        recipient: input.binding.recipient,
        instance_domain: input.binding.instance_domain,
    };
    Ok(ComputeResult { journal, source_allocations, scores, blob, cid, manifest })
}
