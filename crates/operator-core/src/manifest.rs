//! Manifests: the instances the chain cannot describe.
//!
//! "Zero per-instance config" is true, and it is true only for factory-minted trust-graph
//! instances: the registry row leads to the registering transaction, whose receipt carries the
//! factory's `InstanceCreated` log with the FULL params struct, and `params_hash(event.params)`
//! self-checks against the live snapshot. Nothing is typed in.
//!
//! It is not true for anything else, and saying so plainly beats implying the chain describes
//! everything:
//!
//! - Legacy **contributions** deployments predate their typed on-chain controller and still need a
//!   manifest. New deployments are registry-discoverable and need no params path.
//! - **hypercerts** registers an opaque `paramsHash` with no params-bearing event.
//! - Legacy **`SignerSyncZkModule`** deployments still need a manifest. Governed-factory modules
//!   are different: their creation receipt carries a `SignerSyncModuleConfigured` event with the
//!   source, target, verifier/vkey, selection tuple, and derived operator id, so they are discovered
//!   with no file entry.
//!
//! So those get a small explicit entry each. The goal is not to avoid config; it is to avoid
//! config that could silently disagree with the chain.

use alloy_primitives::{Address, B256};
use serde::{Deserialize, Serialize};

use crate::types::Program;

/// One instance the chain does not fully describe.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ManifestEntry {
    pub program: Program,
    /// The `MerkleSnapshot` (or, for the signer program, the instance the module follows).
    pub snapshot: Address,
    /// Path to this instance's params file. Still self-checked against the snapshot's pinned
    /// `paramsHash` before anything is proven — a manifest is a pointer, not an authority.
    pub params: String,
    /// The EAS contract, for programs that reconstruct edges from attestations.
    #[serde(default)]
    pub eas: Option<Address>,
    /// Where the proof is submitted. Defaults to `snapshot`; the signer program submits to its
    /// `SignerSyncZkModule` instead.
    #[serde(default)]
    pub submit_to: Option<Address>,
    /// For the signer program: the selection params file.
    #[serde(default)]
    pub selection: Option<String>,
    /// Instances that must have a fresh root before this one is worth proving. The signer program
    /// follows its trust instance; a contributions round reads a mirrored trust accumulator.
    #[serde(default)]
    pub depends_on: Vec<B256>,
    /// First block to scan for this instance's logs. Zero works and is slow.
    #[serde(default)]
    pub from_block: u64,
    /// Immutable `nostr-witness export` manifests selected for this instance. The operator passes
    /// these to `nostr-witness assemble`; every path is rehashed, envelope-verified, and matched
    /// against the complete checkpoint anchor log before a proof intent is persisted.
    #[serde(default)]
    pub witness_manifests: Vec<String>,
}

impl ManifestEntry {
    pub fn submit_target(&self) -> Address {
        self.submit_to.unwrap_or(self.snapshot)
    }

    /// The instance id we key this entry by. Manifest instances have no registry row, so the id is
    /// derived from what does identify them: the chain and the snapshot address.
    pub fn derived_id(&self, chain_id: u64) -> B256 {
        alloy_primitives::keccak256(
            [self.snapshot.as_slice(), &chain_id.to_be_bytes(), self.program.name().as_bytes()]
                .concat(),
        )
    }

    /// Reject an entry that cannot possibly work, at load time rather than at spend time.
    pub fn validate(&self) -> Result<(), ManifestError> {
        if self.snapshot == Address::ZERO {
            return Err(ManifestError::ZeroSnapshot);
        }
        if self.params.is_empty() {
            return Err(ManifestError::MissingParams);
        }
        if self.program == Program::Signer && self.selection.is_none() {
            return Err(ManifestError::SignerNeedsSelection);
        }
        if matches!(self.program, Program::Trustgraphs | Program::Contributions)
            && self.eas.is_none()
        {
            return Err(ManifestError::NeedsEas(self.program));
        }
        if self.program == Program::NostrWorkspace && self.witness_manifests.is_empty() {
            return Err(ManifestError::NostrNeedsWitnessManifests);
        }
        Ok(())
    }
}

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum ManifestError {
    #[error("manifest entry has a zero snapshot address")]
    ZeroSnapshot,
    #[error(
        "manifest entry has no params path; a manifest is a pointer, and this one points nowhere"
    )]
    MissingParams,
    #[error("the signer program needs `selection`: its journal binds a selectionParamsHash")]
    SignerNeedsSelection,
    #[error("program {0:?} reconstructs edges from EAS attestations and needs `eas`")]
    NeedsEas(Program),
    #[error("nostr-workspace needs at least one immutable witness manifest")]
    NostrNeedsWitnessManifests,
}

/// The full manifest, as loaded from config.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Manifest {
    #[serde(default)]
    pub entries: Vec<ManifestEntry>,
}

impl Manifest {
    pub fn validate(&self) -> Result<(), ManifestError> {
        for e in &self.entries {
            e.validate()?;
        }
        Ok(())
    }

    pub fn for_snapshot(&self, snapshot: Address) -> Option<&ManifestEntry> {
        self.entries.iter().find(|e| e.snapshot == snapshot)
    }
}
