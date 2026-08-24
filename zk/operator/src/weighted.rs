//! Exact weighted-prior manifest recovery and bounded durable caching.

use anyhow::{anyhow, Context, Result};
use operator_core::catalog::CatalogEntry;
use operator_core::types::Program;
use operator_core::weighted_manifest::{recover, Candidate, ManifestSource, RecoveredManifest};
use serde_json::json;
use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};

use crate::chain::{weighted_manifest_from_calldata, weighted_manifest_source_tx, Rpc};
use crate::config::Config;

pub fn degraded_source_count(recovered: &RecoveredManifest) -> usize {
    recovered
        .failed_attempts
        .iter()
        .filter(|attempt| !matches!(attempt.source, ManifestSource::Cache))
        .count()
}

fn cache_path(cfg: &Config, entry: &CatalogEntry) -> Result<PathBuf> {
    let params = entry
        .weighted_params
        .as_ref()
        .ok_or_else(|| anyhow!("{} has no weighted params tuple", entry.name))?;
    let version = entry
        .params_version
        .ok_or_else(|| anyhow!("{} has no weighted params version", entry.name))?;
    Ok(cfg
        .weighted_cache_dir()
        .join(format!("{}", params.chain_id))
        .join(format!("{:#x}", entry.instance_id))
        .join(format!("{version}-{}.tgwp", hex::encode(params.manifest_sha256))))
}

fn raw_cid(entry: &CatalogEntry) -> Result<String> {
    let digest: [u8; 32] = entry
        .weighted_params
        .as_ref()
        .ok_or_else(|| anyhow!("{} has no weighted params tuple", entry.name))?
        .manifest_sha256
        .into();
    Ok(zk_core::cid::cid_v1_raw(&digest))
}

fn metrics_path(cfg: &Config, entry: &CatalogEntry) -> Result<PathBuf> {
    Ok(cache_path(cfg, entry)?.with_extension("metrics.json"))
}

fn degraded_retry_due(cfg: &Config, entry: &CatalogEntry) -> bool {
    let Ok(path) = metrics_path(cfg, entry) else {
        return false;
    };
    let Ok(bytes) = std::fs::read(path) else {
        return false;
    };
    let Ok(value) = serde_json::from_slice::<serde_json::Value>(&bytes) else {
        return true;
    };
    if value.get("degraded").and_then(|value| value.as_bool()) != Some(true) {
        return false;
    }
    let recovered_at = value.get("recoveredAt").and_then(|value| value.as_u64()).unwrap_or(0);
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(0);
    now >= recovered_at.saturating_add(cfg.weighted_manifests.retry_seconds)
}

fn fetch(url: &str) -> Result<Option<Vec<u8>>> {
    let response = reqwest::blocking::Client::new()
        .get(url)
        .timeout(std::time::Duration::from_secs(30))
        .send()
        .with_context(|| format!("fetching weighted manifest {url}"))?;
    if response.status() == reqwest::StatusCode::NOT_FOUND {
        return Ok(None);
    }
    anyhow::ensure!(response.status().is_success(), "{url} returned {}", response.status());
    Ok(Some(response.bytes()?.to_vec()))
}

fn try_recover(
    params: &weighted_prior_core::Params,
    chain_id: u64,
    candidates: &[Candidate],
) -> Option<RecoveredManifest> {
    recover(params, chain_id, candidates.iter().cloned()).ok()
}

/// Recover the exact bytes for this entry's pinned params version.
///
/// Order is local cache → configured raw-CID mirrors → archival transaction calldata. Each
/// candidate is commitment-checked before the next source is considered; no syntactically valid
/// but differently committed manifest can be substituted.
pub fn recover_for_entry(
    cfg: &Config,
    rpc: &Rpc,
    entry: &CatalogEntry,
) -> Result<RecoveredManifest> {
    anyhow::ensure!(
        entry.program == Program::Weighted,
        "weighted recovery called for {}",
        entry.program.name()
    );
    let params = entry
        .weighted_params
        .as_ref()
        .ok_or_else(|| anyhow!("{} has no weighted params tuple", entry.name))?;
    let connected_chain = rpc.eth_chain_id()?;
    let path = cache_path(cfg, entry)?;
    let cache = Candidate {
        source: ManifestSource::Cache,
        bytes: match std::fs::read(&path) {
            Ok(bytes) => Ok(Some(bytes)),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(error) => Err(error.to_string()),
        },
    };
    let mut candidates = vec![cache];
    if let Some(mut recovered) = try_recover(params, connected_chain, &candidates) {
        // A healthy cache avoids network work. A previously degraded mirror is retried only after
        // its configured interval; cache success must not permanently mask that outage.
        if degraded_retry_due(cfg, entry) {
            recovered.failed_attempts.clear();
            let cid = raw_cid(entry)?;
            for mirror in &cfg.weighted_manifests.mirrors {
                let url = format!("{mirror}{cid}");
                let candidate = Candidate {
                    source: ManifestSource::Mirror(url.clone()),
                    bytes: fetch(&url).map_err(|error| error.to_string()),
                };
                if let Err(error) = recover(params, connected_chain, [candidate]) {
                    recovered.failed_attempts.extend(error.attempts);
                }
            }
            record_metrics(cfg, entry, &recovered)?;
        } else if !metrics_path(cfg, entry)?.exists() {
            record_metrics(cfg, entry, &recovered)?;
        }
        return Ok(recovered);
    }

    let cid = raw_cid(entry)?;
    for mirror in &cfg.weighted_manifests.mirrors {
        let url = format!("{mirror}{cid}");
        candidates.push(Candidate {
            source: ManifestSource::Mirror(url.clone()),
            bytes: fetch(&url).map_err(|error| error.to_string()),
        });
        if let Some(recovered) = try_recover(params, connected_chain, &candidates) {
            persist(cfg, entry, &path, &recovered)?;
            return Ok(recovered);
        }
    }

    let head = rpc.block_number()?;
    let source_tx = weighted_manifest_source_tx(rpc, entry, head)
        .with_context(|| format!("locating manifest source for {}", entry.name))?;
    let calldata =
        rpc.transaction_input(source_tx).and_then(|input| weighted_manifest_from_calldata(&input));
    candidates.push(Candidate {
        source: ManifestSource::Calldata(source_tx),
        bytes: calldata.map(Some).map_err(|error| error.to_string()),
    });
    let recovered = recover(params, connected_chain, candidates).map_err(|error| anyhow!(error))?;
    persist(cfg, entry, &path, &recovered)?;
    Ok(recovered)
}

fn persist(
    cfg: &Config,
    entry: &CatalogEntry,
    path: &Path,
    recovered: &RecoveredManifest,
) -> Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    // A crash may leave the temporary file but can never turn a partial write into a valid cache
    // entry. The next successful recovery overwrites it and rename is atomic on one filesystem.
    let temporary = path.with_extension("tgwp.tmp");
    std::fs::write(&temporary, &recovered.bytes)?;
    std::fs::rename(&temporary, path)?;
    prune_cache(cfg, path)?;
    record_metrics(cfg, entry, recovered)
}

fn record_metrics(cfg: &Config, entry: &CatalogEntry, recovered: &RecoveredManifest) -> Result<()> {
    let path = metrics_path(cfg, entry)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let metrics = json!({
        "instanceId": format!("{:#x}", entry.instance_id),
        "version": entry.params_version,
        "paramsHash": format!("{:#x}", entry.reconstructed_params_hash),
        "source": recovered.source.to_string(),
        "degraded": degraded_source_count(recovered) > 0,
        "failedSources": recovered.failed_attempts.iter().map(|failure| json!({
            "source": failure.source.to_string(),
            "error": failure.error,
        })).collect::<Vec<_>>(),
        "retrySeconds": cfg.weighted_manifests.retry_seconds,
        "recoveredAt": std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|duration| duration.as_secs())
            .unwrap_or(0),
    });
    std::fs::write(path, serde_json::to_vec_pretty(&metrics)?)?;
    if degraded_source_count(recovered) > 0 {
        eprintln!(
            "weighted_manifest_degraded instance={:#x} version={} source={} failed_sources={}",
            entry.instance_id,
            entry.params_version.unwrap_or_default(),
            recovered.source,
            degraded_source_count(recovered)
        );
    }
    Ok(())
}

fn collect_manifests(
    path: &Path,
    out: &mut Vec<(PathBuf, u64, std::time::SystemTime)>,
) -> Result<()> {
    let entries = match std::fs::read_dir(path) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error.into()),
    };
    for entry in entries {
        let entry = entry?;
        let metadata = entry.metadata()?;
        if metadata.is_dir() {
            collect_manifests(&entry.path(), out)?;
        } else if entry.path().extension().and_then(|value| value.to_str()) == Some("tgwp") {
            out.push((
                entry.path(),
                metadata.len(),
                metadata.modified().unwrap_or(std::time::UNIX_EPOCH),
            ));
        }
    }
    Ok(())
}

fn retained_versions(files: &[(PathBuf, u64, std::time::SystemTime)]) -> BTreeSet<PathBuf> {
    let mut by_instance =
        BTreeMap::<PathBuf, BTreeMap<u64, (PathBuf, std::time::SystemTime)>>::new();
    for (path, _, modified) in files {
        let Some(parent) = path.parent() else { continue };
        let Some(version) = path
            .file_stem()
            .and_then(|name| name.to_str())
            .and_then(|name| name.split_once('-'))
            .and_then(|(version, _)| version.parse::<u64>().ok())
        else {
            continue;
        };
        let versions = by_instance.entry(parent.to_path_buf()).or_default();
        let replace = versions
            .get(&version)
            .is_none_or(|(_, retained_modified)| modified > retained_modified);
        if replace {
            versions.insert(version, (path.clone(), *modified));
        }
    }
    by_instance
        .into_values()
        .flat_map(|versions| versions.into_iter().rev().take(2).map(|(_, (path, _))| path))
        .collect()
}

/// Enforce both global cache ceilings without evicting the newest two distinct versions for any
/// instance. Those are the active/pending working set during rotation (and active/most-recent
/// history otherwise). If the configured global ceilings cannot contain that pinned set, recovery
/// fails loudly instead of silently deleting checkpoint-critical bytes.
fn prune_cache(cfg: &Config, protected: &Path) -> Result<()> {
    let root = cfg.weighted_cache_dir();
    let root = root.as_path();
    let mut files = Vec::new();
    collect_manifests(root, &mut files)?;
    let mut retained = retained_versions(&files);
    retained.insert(protected.to_path_buf());
    files.sort_by_key(|(_, _, modified)| *modified);
    let mut count = files.len();
    let mut bytes = files.iter().map(|(_, size, _)| *size).sum::<u64>();
    for (path, size, _) in files {
        if count <= cfg.weighted_manifests.max_versions && bytes <= cfg.weighted_manifests.max_bytes
        {
            break;
        }
        if retained.contains(&path) {
            continue;
        }
        std::fs::remove_file(&path)?;
        let metrics = path.with_extension("metrics.json");
        if let Err(error) = std::fs::remove_file(metrics) {
            if error.kind() != std::io::ErrorKind::NotFound {
                return Err(error.into());
            }
        }
        count -= 1;
        bytes = bytes.saturating_sub(size);
    }
    anyhow::ensure!(
        count <= cfg.weighted_manifests.max_versions && bytes <= cfg.weighted_manifests.max_bytes,
        "weighted manifest cache limits are smaller than the pinned active/pending working set"
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cache_pruning_keeps_active_and_pending_while_removing_superseded_versions() {
        let root = tempfile::tempdir().unwrap();
        let instance = root.path().join("10/instance");
        std::fs::create_dir_all(&instance).unwrap();
        let old = instance.join("1-old.tgwp");
        let active = instance.join("2-active.tgwp");
        let pending = instance.join("3-pending.tgwp");
        std::fs::write(&old, vec![1u8; 20]).unwrap();
        std::fs::write(&active, vec![2u8; 20]).unwrap();
        std::fs::write(&pending, vec![3u8; 20]).unwrap();
        std::fs::write(old.with_extension("metrics.json"), b"old metrics").unwrap();
        let mut cfg: Config = toml::from_str(&format!(
            "rpc = 'http://localhost:8545'\nregistry = '0x1111111111111111111111111111111111111111'\n[weighted_manifests]\ncache_dir = '{}'\nmax_versions = 2\nmax_bytes = 114724\nretry_seconds = 1\n",
            root.path().display()
        ))
        .unwrap();
        // Keep the compiler honest if Config grows fields with post-deserialization defaults.
        cfg.weighted_manifests.mirrors.clear();
        prune_cache(&cfg, &pending).unwrap();
        assert!(active.exists());
        assert!(pending.exists());
        assert!(!old.exists());
        assert!(!old.with_extension("metrics.json").exists());
    }
}
