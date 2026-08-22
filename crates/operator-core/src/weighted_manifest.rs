//! Fail-closed recovery of exact weighted-prior manifest bytes.
//!
//! The source is never an authority. Cache entries, raw-CID mirrors, and archival calldata are
//! merely ways to obtain bytes; `weighted_prior_core` re-derives chain id, entry count, root, and
//! SHA-256 against the checkpoint-pinned params before a caller may use them.

use alloy_primitives::B256;
use weighted_prior_core::{
    manifest::{validate_manifest, ParsedManifest},
    Params,
};

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ManifestSource {
    Cache,
    Mirror(String),
    Calldata(B256),
}

impl std::fmt::Display for ManifestSource {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Cache => write!(f, "local cache"),
            Self::Mirror(url) => write!(f, "mirror {url}"),
            Self::Calldata(tx) => write!(f, "transaction calldata {tx:#x}"),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Candidate {
    pub source: ManifestSource,
    /// `None` means this source did not have the object. `Err` records a degraded source without
    /// preventing a later, independently validated source from recovering the exact same bytes.
    pub bytes: Result<Option<Vec<u8>>, String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FailedAttempt {
    pub source: ManifestSource,
    pub error: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RecoveredManifest {
    pub source: ManifestSource,
    pub bytes: Vec<u8>,
    pub parsed: ParsedManifest,
    /// Earlier failures are retained for degraded-source metrics and alerts. Recovery does not
    /// erase the fact that a configured mirror is unhealthy.
    pub failed_attempts: Vec<FailedAttempt>,
}

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
#[error("weighted manifest unavailable or invalid: {detail}")]
pub struct RecoveryError {
    pub detail: String,
    pub attempts: Vec<FailedAttempt>,
}

/// Select the first candidate whose exact bytes satisfy every frozen commitment.
///
/// Params are validated before any source is considered. This makes an unsupported params
/// version or wrong configured chain a hard refusal; a valid manifest from a different version is
/// never accepted as substitute data.
pub fn recover(
    params: &Params,
    expected_chain_id: u64,
    candidates: impl IntoIterator<Item = Candidate>,
) -> Result<RecoveredManifest, RecoveryError> {
    if params.chain_id != expected_chain_id {
        return Err(RecoveryError {
            detail: format!(
                "params chain {} does not match connected chain {expected_chain_id}",
                params.chain_id
            ),
            attempts: Vec::new(),
        });
    }
    if let Err(error) = params.validate() {
        return Err(RecoveryError {
            detail: format!("weighted params are invalid: {error}"),
            attempts: Vec::new(),
        });
    }

    let mut failed_attempts = Vec::new();
    for candidate in candidates {
        let bytes = match candidate.bytes {
            Ok(Some(bytes)) => bytes,
            Ok(None) => {
                failed_attempts
                    .push(FailedAttempt { source: candidate.source, error: "not found".into() });
                continue;
            }
            Err(error) => {
                failed_attempts.push(FailedAttempt { source: candidate.source, error });
                continue;
            }
        };
        match validate_manifest(&bytes, params) {
            Ok(parsed) => {
                return Ok(RecoveredManifest {
                    source: candidate.source,
                    bytes,
                    parsed,
                    failed_attempts,
                });
            }
            Err(error) => failed_attempts.push(FailedAttempt {
                source: candidate.source,
                error: format!("commitment validation failed: {error}"),
            }),
        }
    }

    let detail = if failed_attempts.is_empty() {
        "no recovery sources were supplied".to_string()
    } else {
        failed_attempts
            .iter()
            .map(|attempt| format!("{}: {}", attempt.source, attempt.error))
            .collect::<Vec<_>>()
            .join("; ")
    };
    Err(RecoveryError { detail, attempts: failed_attempts })
}

#[cfg(test)]
mod tests {
    use super::*;
    use alloy_primitives::{Address, B256};
    use weighted_prior_core::{manifest, PriorEntry, PARAMS_VERSION, SCALE};

    fn fixture(chain: u64) -> (Params, Vec<u8>) {
        fixture_for(chain, 0x11)
    }

    fn fixture_for(chain: u64, account: u8) -> (Params, Vec<u8>) {
        let entries = vec![PriorEntry { account: Address::from([account; 20]), weight: SCALE }];
        let bytes = manifest::canonical_manifest(chain, &entries).unwrap();
        let params = Params {
            version: PARAMS_VERSION,
            damping_fp: 850_000_000_000_000_000,
            tolerance_fp: 0,
            max_iterations: 40,
            min_weight: 0,
            max_weight: 100,
            prior_root: manifest::prior_root(&entries).unwrap(),
            prior_count: 1,
            manifest_sha256: manifest::manifest_digest(&bytes),
            schema_uid: B256::from([0x22; 32]),
            weight_field_index: 1,
            accumulator: Address::from([0x33; 20]),
            chain_id: chain,
        };
        (params, bytes)
    }

    #[test]
    fn falls_through_degraded_sources_but_retains_their_failures() {
        let (params, bytes) = fixture(10);
        let tx = B256::from([0x44; 32]);
        let recovered = recover(
            &params,
            10,
            [
                Candidate { source: ManifestSource::Cache, bytes: Ok(None) },
                Candidate {
                    source: ManifestSource::Mirror("https://mirror.invalid/ipfs/".into()),
                    bytes: Err("timeout".into()),
                },
                Candidate { source: ManifestSource::Calldata(tx), bytes: Ok(Some(bytes.clone())) },
            ],
        )
        .unwrap();
        assert_eq!(recovered.bytes, bytes);
        assert_eq!(recovered.source, ManifestSource::Calldata(tx));
        assert_eq!(recovered.failed_attempts.len(), 2);
    }

    #[test]
    fn never_substitutes_a_manifest_with_the_wrong_root_or_digest() {
        let (params, mut bytes) = fixture(10);
        *bytes.last_mut().unwrap() ^= 1;
        let error = recover(
            &params,
            10,
            [Candidate { source: ManifestSource::Cache, bytes: Ok(Some(bytes)) }],
        )
        .unwrap_err();
        assert!(error.detail.contains("commitment validation failed"));
    }

    #[test]
    fn refuses_wrong_chain_and_unsupported_params_version_before_sources() {
        let (mut params, bytes) = fixture(10);
        assert!(recover(
            &params,
            1,
            [Candidate { source: ManifestSource::Cache, bytes: Ok(Some(bytes.clone())) }]
        )
        .unwrap_err()
        .attempts
        .is_empty());
        params.version = 2;
        assert!(recover(
            &params,
            10,
            [Candidate { source: ManifestSource::Cache, bytes: Ok(Some(bytes)) }]
        )
        .unwrap_err()
        .detail
        .contains("UnsupportedParamsVersion"));
    }

    #[test]
    fn restart_replay_recovers_active_and_superseded_versions_without_mirrors() {
        let (superseded_params, superseded_bytes) = fixture_for(10, 0x11);
        let (active_params, active_bytes) = fixture_for(10, 0x22);
        let superseded_tx = B256::from([0x44; 32]);
        let active_tx = B256::from([0x55; 32]);

        // First indexing/operator pass: the only usable source is immutable chain calldata.
        let superseded = recover(
            &superseded_params,
            10,
            [
                Candidate { source: ManifestSource::Cache, bytes: Ok(None) },
                Candidate {
                    source: ManifestSource::Calldata(superseded_tx),
                    bytes: Ok(Some(superseded_bytes.clone())),
                },
            ],
        )
        .unwrap();
        let active = recover(
            &active_params,
            10,
            [
                Candidate { source: ManifestSource::Cache, bytes: Ok(None) },
                Candidate {
                    source: ManifestSource::Calldata(active_tx),
                    bytes: Ok(Some(active_bytes.clone())),
                },
            ],
        )
        .unwrap();
        assert_eq!(superseded.source, ManifestSource::Calldata(superseded_tx));
        assert_eq!(active.source, ManifestSource::Calldata(active_tx));

        // A restart uses each version's own committed bytes; the active version is never
        // substituted for the older checkpoint-pinned version.
        assert_eq!(
            recover(
                &superseded_params,
                10,
                [Candidate { source: ManifestSource::Cache, bytes: Ok(Some(superseded.bytes)) }],
            )
            .unwrap()
            .parsed
            .entries[0]
                .account,
            Address::from([0x11; 20])
        );
        assert_eq!(
            recover(
                &active_params,
                10,
                [Candidate { source: ManifestSource::Cache, bytes: Ok(Some(active.bytes)) }],
            )
            .unwrap()
            .parsed
            .entries[0]
                .account,
            Address::from([0x22; 20])
        );
    }
}
