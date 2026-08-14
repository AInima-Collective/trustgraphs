//! Experimental reference code for issue #34.
//!
//! This crate is deliberately not imported by the production trust-graph program. It pins the
//! proposed weighted-prior normalization/commitment and provides a sparse kernel whose measured
//! SP1 cost informs the design cap. Shipping the eventual program requires a separate issue.

use alloy_primitives::{keccak256, Address, B256, U256};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::BTreeSet;

pub const SCALE: u64 = 1_000_000_000_000_000_000;
pub const MANIFEST_MAGIC: &[u8; 4] = b"TGWP";
pub const MANIFEST_VERSION: u16 = 1;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct RawPriorEntry {
    pub account: Address,
    /// Canonical positive decimal: no sign/exponent, no leading/trailing zeroes, <=18 decimals.
    pub weight: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct PriorEntry {
    pub account: Address,
    /// Normalized teleport mass. Every entry is positive and all entries sum to [`SCALE`].
    pub weight: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct SparseEdge {
    pub from: u32,
    pub to: u32,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct BenchInput {
    pub prior: Vec<PriorEntry>,
    pub edges: Vec<SparseEdge>,
    pub damping_bps: u16,
    pub iterations: u16,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum PriorError {
    Empty,
    NonCanonicalDecimal(String),
    DuplicateAccount(Address),
    ZeroAfterNormalization(Address),
    NotStrictlySorted(Address),
    InvalidNormalizedSum(u64),
    TooManyEntries(usize),
}

impl core::fmt::Display for PriorError {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        match self {
            Self::Empty => write!(f, "weighted prior is empty"),
            Self::NonCanonicalDecimal(value) => {
                write!(f, "non-canonical positive decimal: {value}")
            }
            Self::DuplicateAccount(account) => write!(f, "duplicate account: {account:#x}"),
            Self::ZeroAfterNormalization(account) => {
                write!(f, "positive input rounds to zero normalized mass: {account:#x}")
            }
            Self::NotStrictlySorted(account) => {
                write!(f, "normalized accounts are not strictly ascending at: {account:#x}")
            }
            Self::InvalidNormalizedSum(sum) => {
                write!(f, "normalized weights sum to {sum}, expected {SCALE}")
            }
            Self::TooManyEntries(count) => write!(f, "entry count {count} exceeds uint32"),
        }
    }
}

impl std::error::Error for PriorError {}

/// Normalize relative decimal weights to exactly 1e18 with Hamilton/largest-remainder
/// apportionment. Equal remainders are resolved by ascending account bytes.
pub fn normalize(raw: &[RawPriorEntry]) -> Result<Vec<PriorEntry>, PriorError> {
    if raw.is_empty() {
        return Err(PriorError::Empty);
    }
    if raw.len() > u32::MAX as usize {
        return Err(PriorError::TooManyEntries(raw.len()));
    }

    let mut parsed = raw
        .iter()
        .map(|entry| Ok((entry.account, parse_decimal(&entry.weight)?)))
        .collect::<Result<Vec<_>, PriorError>>()?;
    parsed.sort_by_key(|(account, _)| *account);

    let mut seen = BTreeSet::new();
    for (account, _) in &parsed {
        if !seen.insert(*account) {
            return Err(PriorError::DuplicateAccount(*account));
        }
    }

    let total = parsed.iter().fold(U256::ZERO, |sum, (_, value)| sum + *value);
    let mut apportioned = parsed
        .iter()
        .map(|(account, value)| {
            let numerator = *value * U256::from(SCALE);
            (*account, (numerator / total).to::<u64>(), numerator % total)
        })
        .collect::<Vec<_>>();
    let floor_sum = apportioned.iter().map(|(_, weight, _)| *weight).sum::<u64>();
    let missing = (SCALE - floor_sum) as usize;

    let mut order = (0..apportioned.len()).collect::<Vec<_>>();
    order.sort_by(|left, right| {
        apportioned[*right]
            .2
            .cmp(&apportioned[*left].2)
            .then_with(|| apportioned[*left].0.cmp(&apportioned[*right].0))
    });
    for index in order.into_iter().take(missing) {
        apportioned[index].1 += 1;
    }

    apportioned
        .into_iter()
        .map(|(account, weight, _)| {
            if weight == 0 {
                Err(PriorError::ZeroAfterNormalization(account))
            } else {
                Ok(PriorEntry { account, weight })
            }
        })
        .collect()
}

/// Consensus leaf: `keccak256(abi.encode(address account, uint256 normalizedWeight))`.
pub fn prior_leaf(entry: &PriorEntry) -> B256 {
    let mut encoded = [0u8; 64];
    encoded[12..32].copy_from_slice(entry.account.as_slice());
    encoded[56..64].copy_from_slice(&entry.weight.to_be_bytes());
    keccak256(encoded)
}

/// Sorted-pair Merkle root. When a level is odd, its final node is promoted unchanged.
pub fn prior_root(entries: &[PriorEntry]) -> Result<B256, PriorError> {
    validate_normalized(entries)?;
    let mut level = entries.iter().map(prior_leaf).collect::<Vec<_>>();
    while level.len() > 1 {
        let mut next = Vec::with_capacity(level.len().div_ceil(2));
        for pair in level.chunks(2) {
            if pair.len() == 1 {
                next.push(pair[0]);
            } else {
                let (left, right) =
                    if pair[0] <= pair[1] { (pair[0], pair[1]) } else { (pair[1], pair[0]) };
                let mut preimage = [0u8; 64];
                preimage[..32].copy_from_slice(left.as_slice());
                preimage[32..].copy_from_slice(right.as_slice());
                next.push(keccak256(preimage));
            }
        }
        level = next;
    }
    Ok(level[0])
}

/// Compact canonical recovery blob: magic(4), version(u16), chainId(u64), count(u32), then
/// ascending `(address[20], normalizedWeight[u64])` entries. All integers are big-endian.
pub fn canonical_manifest(chain_id: u64, entries: &[PriorEntry]) -> Result<Vec<u8>, PriorError> {
    validate_normalized(entries)?;
    if entries.len() > u32::MAX as usize {
        return Err(PriorError::TooManyEntries(entries.len()));
    }
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

pub fn manifest_digest(bytes: &[u8]) -> [u8; 32] {
    Sha256::digest(bytes).into()
}

/// Validate the canonical normalized representation consumed by every commitment function.
pub fn validate_normalized(entries: &[PriorEntry]) -> Result<(), PriorError> {
    if entries.is_empty() {
        return Err(PriorError::Empty);
    }
    if entries.len() > u32::MAX as usize {
        return Err(PriorError::TooManyEntries(entries.len()));
    }
    let mut sum = 0u64;
    for (index, entry) in entries.iter().enumerate() {
        if entry.weight == 0 {
            return Err(PriorError::ZeroAfterNormalization(entry.account));
        }
        if index > 0 && entries[index - 1].account >= entry.account {
            return Err(PriorError::NotStrictlySorted(entry.account));
        }
        sum = sum.checked_add(entry.weight).ok_or(PriorError::InvalidNormalizedSum(u64::MAX))?;
    }
    if sum != SCALE {
        return Err(PriorError::InvalidNormalizedSum(sum));
    }
    Ok(())
}

/// Sparse fixed-point research kernel. It is intentionally small and deterministic so its SP1
/// instruction slope can be measured. The design ADR, not this prototype, specifies eventual
/// consensus rounding and validation.
pub fn sparse_rank(input: &BenchInput) -> Vec<u64> {
    let n = input.prior.len();
    assert!(n > 0 && input.damping_bps <= 10_000);
    let mut outgoing = vec![0u32; n];
    for edge in &input.edges {
        assert!((edge.from as usize) < n && (edge.to as usize) < n);
        outgoing[edge.from as usize] += 1;
    }
    let mut rank = input.prior.iter().map(|entry| entry.weight).collect::<Vec<_>>();
    let damping = input.damping_bps as u128;
    for _ in 0..input.iterations {
        let mut next = input
            .prior
            .iter()
            .map(|entry| ((entry.weight as u128) * (10_000 - damping) / 10_000) as u64)
            .collect::<Vec<_>>();
        let mut dangling = 0u128;
        for (index, value) in rank.iter().enumerate() {
            if outgoing[index] == 0 {
                dangling += (*value as u128) * damping / 10_000;
            }
        }
        for (index, entry) in input.prior.iter().enumerate() {
            next[index] = next[index]
                .saturating_add((dangling * entry.weight as u128 / SCALE as u128) as u64);
        }
        for edge in &input.edges {
            let from = edge.from as usize;
            let contribution = (rank[from] as u128) * damping / 10_000 / outgoing[from] as u128;
            next[edge.to as usize] = next[edge.to as usize].saturating_add(contribution as u64);
        }
        rank = next;
    }
    rank
}

pub fn rank_digest(rank: &[u64]) -> B256 {
    let mut encoded = Vec::with_capacity(rank.len() * 8);
    for value in rank {
        encoded.extend_from_slice(&value.to_be_bytes());
    }
    keccak256(encoded)
}

fn parse_decimal(value: &str) -> Result<U256, PriorError> {
    if value.is_empty()
        || value.starts_with('+')
        || value.starts_with('-')
        || value.contains('e')
        || value.contains('E')
        || value.ends_with('.')
    {
        return Err(PriorError::NonCanonicalDecimal(value.to_string()));
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
        return Err(PriorError::NonCanonicalDecimal(value.to_string()));
    }
    let whole =
        whole.parse::<U256>().map_err(|_| PriorError::NonCanonicalDecimal(value.to_string()))?;
    let fraction = if fractional.is_empty() {
        U256::ZERO
    } else {
        fractional
            .parse::<U256>()
            .map_err(|_| PriorError::NonCanonicalDecimal(value.to_string()))?
            * U256::from(10).pow(U256::from(18 - fractional.len()))
    };
    let parsed = whole * U256::from(SCALE) + fraction;
    if parsed == U256::ZERO {
        return Err(PriorError::NonCanonicalDecimal(value.to_string()));
    }
    Ok(parsed)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn largest_remainder_is_exact_and_account_tiebroken() {
        let raw = vec![
            RawPriorEntry { account: Address::from([0x03; 20]), weight: "1".into() },
            RawPriorEntry { account: Address::from([0x01; 20]), weight: "1".into() },
            RawPriorEntry { account: Address::from([0x02; 20]), weight: "1".into() },
        ];
        let normalized = normalize(&raw).unwrap();
        assert_eq!(normalized.iter().map(|entry| entry.weight).sum::<u64>(), SCALE);
        assert_eq!(normalized[0].weight, 333_333_333_333_333_334);
        assert_eq!(normalized[1].weight, 333_333_333_333_333_333);
        assert_eq!(normalized[2].weight, 333_333_333_333_333_333);
    }

    #[test]
    fn prior_only_nodes_survive_an_empty_graph() {
        let prior = vec![
            PriorEntry { account: Address::from([0x01; 20]), weight: 750_000_000_000_000_000 },
            PriorEntry { account: Address::from([0x02; 20]), weight: 250_000_000_000_000_000 },
        ];
        let rank = sparse_rank(&BenchInput {
            prior: prior.clone(),
            edges: vec![],
            damping_bps: 8500,
            iterations: 8,
        });
        assert_eq!(rank, prior.iter().map(|entry| entry.weight).collect::<Vec<_>>());
    }

    #[test]
    fn commitments_reject_noncanonical_normalized_entries() {
        let reversed = vec![
            PriorEntry { account: Address::from([0x02; 20]), weight: SCALE / 2 },
            PriorEntry { account: Address::from([0x01; 20]), weight: SCALE / 2 },
        ];
        assert!(matches!(prior_root(&reversed), Err(PriorError::NotStrictlySorted(_))));
        assert!(matches!(
            canonical_manifest(
                10,
                &[PriorEntry { account: Address::from([0x01; 20]), weight: SCALE - 1 }]
            ),
            Err(PriorError::InvalidNormalizedSum(_))
        ));
        assert!(matches!(
            normalize(&[RawPriorEntry { account: Address::from([0x01; 20]), weight: "1.".into() }]),
            Err(PriorError::NonCanonicalDecimal(_))
        ));
    }
}
