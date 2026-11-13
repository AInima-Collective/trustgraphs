//! Canonical raw-weight normalization and compact `TGMR` V1 manifest commitments.

use std::collections::BTreeSet;

use alloy_primitives::{keccak256, Address, B256, U256};

use crate::{
    MutualError, Params, PriorEntry, RawPriorEntry, MANIFEST_MAGIC, MANIFEST_VERSION,
    MAX_PRIOR_ENTRIES, SCALE,
};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ParsedManifest {
    pub chain_id: u64,
    pub entries: Vec<PriorEntry>,
    pub root: B256,
    pub sha256: B256,
}

/// Normalize canonical positive decimals with largest-remainder/Hamilton apportionment. Equal
/// remainders are resolved by ascending address.
pub fn normalize(raw: &[RawPriorEntry]) -> Result<Vec<PriorEntry>, MutualError> {
    if raw.is_empty() {
        return Err(MutualError::EmptyPrior);
    }
    if raw.len() > MAX_PRIOR_ENTRIES {
        return Err(MutualError::TooManyPriorEntries(raw.len()));
    }

    let mut parsed = raw
        .iter()
        .map(|entry| {
            if entry.account == Address::ZERO {
                return Err(MutualError::ZeroAddress);
            }
            Ok((entry.account, parse_decimal(&entry.weight)?))
        })
        .collect::<Result<Vec<_>, MutualError>>()?;
    parsed.sort_by_key(|(account, _)| *account);

    let mut seen = BTreeSet::new();
    for (account, _) in &parsed {
        if !seen.insert(*account) {
            return Err(MutualError::DuplicateAccount(*account));
        }
    }

    let total = parsed.iter().try_fold(U256::ZERO, |sum, (_, value)| {
        sum.checked_add(*value).ok_or(MutualError::ArithmeticOverflow)
    })?;
    let mut apportioned = parsed
        .iter()
        .map(|(account, value)| {
            let numerator =
                value.checked_mul(U256::from(SCALE)).ok_or(MutualError::ArithmeticOverflow)?;
            Ok((*account, (numerator / total).to::<u64>(), numerator % total))
        })
        .collect::<Result<Vec<_>, MutualError>>()?;
    let floor_sum = apportioned.iter().try_fold(0u64, |sum, (_, weight, _)| {
        sum.checked_add(*weight).ok_or(MutualError::ArithmeticOverflow)
    })?;
    let missing = SCALE.checked_sub(floor_sum).ok_or(MutualError::InvalidApportionment)?;
    if missing as usize > apportioned.len() {
        return Err(MutualError::InvalidApportionment);
    }

    let mut order = (0..apportioned.len()).collect::<Vec<_>>();
    order.sort_by(|left, right| {
        apportioned[*right]
            .2
            .cmp(&apportioned[*left].2)
            .then_with(|| apportioned[*left].0.cmp(&apportioned[*right].0))
    });
    for index in order.into_iter().take(missing as usize) {
        apportioned[index].1 += 1;
    }

    let entries = apportioned
        .into_iter()
        .map(|(account, weight, _)| {
            if weight == 0 {
                Err(MutualError::ZeroAfterNormalization(account))
            } else {
                Ok(PriorEntry { account, weight })
            }
        })
        .collect::<Result<Vec<_>, MutualError>>()?;
    validate_normalized(&entries)?;
    Ok(entries)
}

/// Consensus leaf: `keccak256(abi.encode(address account, uint256 normalizedWeight))`.
pub fn prior_leaf(entry: &PriorEntry) -> B256 {
    let mut encoded = [0u8; 64];
    encoded[12..32].copy_from_slice(entry.account.as_slice());
    encoded[56..64].copy_from_slice(&entry.weight.to_be_bytes());
    keccak256(encoded)
}

/// Address-order leaves, sorted-pair parents, and odd-node promotion, exactly as the ADR defines.
pub fn prior_root(entries: &[PriorEntry]) -> Result<B256, MutualError> {
    validate_normalized(entries)?;
    let mut level = entries.iter().map(prior_leaf).collect::<Vec<_>>();
    while level.len() > 1 {
        let mut next = Vec::with_capacity(level.len().div_ceil(2));
        for pair in level.chunks(2) {
            if pair.len() == 1 {
                next.push(pair[0]);
                continue;
            }
            let (left, right) =
                if pair[0] <= pair[1] { (pair[0], pair[1]) } else { (pair[1], pair[0]) };
            let mut preimage = [0u8; 64];
            preimage[..32].copy_from_slice(left.as_slice());
            preimage[32..].copy_from_slice(right.as_slice());
            next.push(keccak256(preimage));
        }
        level = next;
    }
    Ok(level[0])
}

pub fn canonical_manifest(chain_id: u64, entries: &[PriorEntry]) -> Result<Vec<u8>, MutualError> {
    validate_normalized(entries)?;
    let mut out = Vec::with_capacity(18 + entries.len() * 28);
    out.extend_from_slice(MANIFEST_MAGIC);
    out.extend_from_slice(&MANIFEST_VERSION.to_be_bytes());
    out.extend_from_slice(&chain_id.to_be_bytes());
    out.extend_from_slice(&(entries.len() as u32).to_be_bytes());
    for entry in entries {
        out.extend_from_slice(entry.account.as_slice());
        out.extend_from_slice(&entry.weight.to_be_bytes());
    }
    Ok(out)
}

pub fn manifest_digest(bytes: &[u8]) -> B256 {
    B256::from(zk_core::cid::sha256(bytes))
}

pub fn parse_manifest(bytes: &[u8]) -> Result<ParsedManifest, MutualError> {
    if bytes.len() < 18 {
        return Err(MutualError::ManifestTooShort(bytes.len()));
    }
    if &bytes[..4] != MANIFEST_MAGIC {
        return Err(MutualError::InvalidManifestMagic);
    }
    let version = u16::from_be_bytes(bytes[4..6].try_into().expect("fixed manifest slice"));
    if version != MANIFEST_VERSION {
        return Err(MutualError::UnsupportedManifestVersion(version));
    }
    let chain_id = u64::from_be_bytes(bytes[6..14].try_into().expect("fixed manifest slice"));
    let count = u32::from_be_bytes(bytes[14..18].try_into().expect("fixed manifest slice"));
    if count == 0 {
        return Err(MutualError::EmptyPrior);
    }
    if count as usize > MAX_PRIOR_ENTRIES {
        return Err(MutualError::TooManyPriorEntries(count as usize));
    }
    let expected = 18usize
        .checked_add((count as usize).checked_mul(28).ok_or(MutualError::ArithmeticOverflow)?)
        .ok_or(MutualError::ArithmeticOverflow)?;
    if bytes.len() != expected {
        return Err(MutualError::InvalidManifestLength { expected, actual: bytes.len() });
    }

    let mut entries = Vec::with_capacity(count as usize);
    for chunk in bytes[18..].chunks_exact(28) {
        let account = Address::from_slice(&chunk[..20]);
        let weight = u64::from_be_bytes(chunk[20..28].try_into().expect("fixed entry slice"));
        entries.push(PriorEntry { account, weight });
    }
    validate_normalized(&entries)?;
    let root = prior_root(&entries)?;
    Ok(ParsedManifest { chain_id, entries, root, sha256: manifest_digest(bytes) })
}

pub fn validate_manifest(bytes: &[u8], params: &Params) -> Result<ParsedManifest, MutualError> {
    params.validate()?;
    let parsed = parse_manifest(bytes)?;
    if parsed.chain_id != params.chain_id {
        return Err(MutualError::WrongManifestChain {
            expected: params.chain_id,
            actual: parsed.chain_id,
        });
    }
    if parsed.entries.len() as u32 != params.prior_count {
        return Err(MutualError::ManifestCountMismatch {
            expected: params.prior_count,
            actual: parsed.entries.len() as u32,
        });
    }
    if parsed.root != params.prior_root {
        return Err(MutualError::PriorRootMismatch {
            expected: params.prior_root,
            actual: parsed.root,
        });
    }
    if parsed.sha256 != params.manifest_sha256 {
        return Err(MutualError::ManifestDigestMismatch {
            expected: params.manifest_sha256,
            actual: parsed.sha256,
        });
    }
    Ok(parsed)
}

pub fn validate_normalized(entries: &[PriorEntry]) -> Result<(), MutualError> {
    if entries.is_empty() {
        return Err(MutualError::EmptyPrior);
    }
    if entries.len() > MAX_PRIOR_ENTRIES {
        return Err(MutualError::TooManyPriorEntries(entries.len()));
    }
    let mut sum = 0u64;
    for (index, entry) in entries.iter().enumerate() {
        if entry.account == Address::ZERO {
            return Err(MutualError::ZeroAddress);
        }
        if entry.weight == 0 {
            return Err(MutualError::ZeroWeight(entry.account));
        }
        if index > 0 {
            let previous = entries[index - 1].account;
            if previous == entry.account {
                return Err(MutualError::DuplicateAccount(entry.account));
            }
            if previous > entry.account {
                return Err(MutualError::AccountsNotStrictlySorted(entry.account));
            }
        }
        sum = sum.checked_add(entry.weight).ok_or(MutualError::ArithmeticOverflow)?;
    }
    if sum != SCALE {
        return Err(MutualError::InvalidNormalizedSum(sum));
    }
    Ok(())
}

fn parse_decimal(value: &str) -> Result<U256, MutualError> {
    if value.is_empty()
        || value.starts_with('+')
        || value.starts_with('-')
        || value.contains('e')
        || value.contains('E')
        || value.ends_with('.')
    {
        return Err(MutualError::NonCanonicalDecimal(value.to_string()));
    }
    let (whole, fractional) = value.split_once('.').map_or((value, ""), |parts| parts);
    if whole.is_empty()
        || (whole.len() > 1 && whole.starts_with('0'))
        || whole.len() > 20
        || !whole.bytes().all(|byte| byte.is_ascii_digit())
        || fractional.len() > 18
        || (!fractional.is_empty()
            && (!fractional.bytes().all(|byte| byte.is_ascii_digit()) || fractional.ends_with('0')))
    {
        return Err(MutualError::NonCanonicalDecimal(value.to_string()));
    }
    let whole =
        whole.parse::<U256>().map_err(|_| MutualError::NonCanonicalDecimal(value.to_string()))?;
    let fraction = if fractional.is_empty() {
        U256::ZERO
    } else {
        fractional
            .parse::<U256>()
            .map_err(|_| MutualError::NonCanonicalDecimal(value.to_string()))?
            * U256::from(10).pow(U256::from(18 - fractional.len()))
    };
    let parsed = whole
        .checked_mul(U256::from(SCALE))
        .and_then(|scaled| scaled.checked_add(fraction))
        .ok_or(MutualError::ArithmeticOverflow)?;
    if parsed.is_zero() {
        return Err(MutualError::NonCanonicalDecimal(value.to_string()));
    }
    Ok(parsed)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn account(byte: u8) -> Address {
        Address::from([byte; 20])
    }

    #[test]
    fn research_fixture_normalizes_and_commits_identically() {
        let raw = vec![
            RawPriorEntry { account: account(0x11), weight: "10".into() },
            RawPriorEntry { account: account(0x22), weight: "2.5".into() },
            RawPriorEntry { account: account(0x33), weight: "1".into() },
        ];
        let entries = normalize(&raw).unwrap();
        assert_eq!(entries[0].weight, 740_740_740_740_740_741);
        assert_eq!(entries[1].weight, 185_185_185_185_185_185);
        assert_eq!(entries[2].weight, 74_074_074_074_074_074);
        let manifest = canonical_manifest(10, &entries).unwrap();
        assert_eq!(
            format!("{:#x}", prior_root(&entries).unwrap()),
            "0x3bfa55c8c22dc55892da0439ba84748c4072b323d2ae036cb4088a60f46095cd"
        );
        assert_eq!(
            format!("{:#x}", manifest_digest(&manifest)),
            "0x1af4115457f13c76a13c8fab4df1975ac6525c882d130bbddb547bc78c541af5"
        );
    }

    #[test]
    fn equal_remainders_use_address_order() {
        let raw = vec![
            RawPriorEntry { account: account(3), weight: "1".into() },
            RawPriorEntry { account: account(1), weight: "1".into() },
            RawPriorEntry { account: account(2), weight: "1".into() },
        ];
        let entries = normalize(&raw).unwrap();
        assert_eq!(entries.iter().map(|entry| entry.weight).sum::<u64>(), SCALE);
        assert_eq!(entries[0].weight, 333_333_333_333_333_334);
        assert_eq!(entries[1].weight, 333_333_333_333_333_333);
        assert_eq!(entries[2].weight, 333_333_333_333_333_333);
    }
}
