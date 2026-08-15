//! Strict canonical address/value blob decoding and commitment checks.

use std::collections::BTreeMap;

use alloy_primitives::{Address, B256, U256};

use crate::CompositionError;

pub fn decode_canonical_score_blob(blob: &[u8]) -> Result<Vec<(Address, u128)>, CompositionError> {
    let parsed = serde_json::from_slice::<BTreeMap<String, String>>(blob)
        .map_err(|_| CompositionError::SourceBlobNotJson)?;
    if parsed.is_empty() {
        return Err(CompositionError::EmptySourceBlob);
    }
    let mut entries = Vec::with_capacity(parsed.len());
    for (account, value) in parsed {
        if account.len() != 42
            || !account.starts_with("0x")
            || !account.as_bytes()[2..]
                .iter()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(byte))
        {
            return Err(CompositionError::InvalidSourceAccount(account));
        }
        let mut address = [0u8; 20];
        alloy_primitives::hex::decode_to_slice(&account[2..], &mut address)
            .map_err(|_| CompositionError::InvalidSourceAccount(account.clone()))?;
        if value.is_empty()
            || value == "0"
            || (value.len() > 1 && value.starts_with('0'))
            || !value.bytes().all(|byte| byte.is_ascii_digit())
        {
            return Err(CompositionError::InvalidSourceValue { account, value });
        }
        let parsed = value.parse::<u128>().map_err(|_| CompositionError::InvalidSourceValue {
            account: account.clone(),
            value: value.clone(),
        })?;
        entries.push((Address::from(address), parsed));
    }
    let scores =
        entries.iter().map(|(account, value)| (*account, U256::from(*value))).collect::<Vec<_>>();
    if zk_core::cid::canonical_blob(&scores) != blob {
        return Err(CompositionError::SourceBlobNotCanonical);
    }
    Ok(entries)
}

pub fn output_root(entries: &[(Address, u128)]) -> B256 {
    zk_core::merkle::merkle_root(
        entries
            .iter()
            .map(|(account, value)| zk_core::merkle::output_leaf(*account, U256::from(*value)))
            .collect(),
    )
}
