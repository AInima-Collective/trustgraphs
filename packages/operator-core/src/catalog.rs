//! "Chain is the config", made reusable and made honest about where that stops.
//!
//! This lifts the reconstruction that `packages/input-exporter/src/bin/instance_scan.rs` does —
//! registry → `InstanceRegistered` tx → factory `InstanceCreated` → full params → self-check
//! `params_hash(event.params) == snapshot.paramsHash()` — out of a binary and behind a
//! [`ChainReader`] trait, so CI can drive it with a fake chain.
//!
//! **One behaviour deliberately differs from the binary.** `instance_scan` treats a params-hash
//! mismatch as a hard stop for the whole run, which is right for a human running a one-shot script
//! and wrong for a daemon: one garbage registry row must not stop every healthy instance from
//! being proven. Here a failure is per-instance ([`Skipped`]), and the run continues.
//!
//! The self-check itself is unchanged and stays load-bearing. It is the canonical Rust encoder
//! re-deriving the hash `ParamsCodec.hash` (Solidity) wrote at creation, over params decoded from
//! the event. A mismatch means the event, the codec ports, and the snapshot disagree about what
//! this instance computes — and proving on a bad params set yields a journal digest that can never
//! verify, or (before journal v3) one valid for a *different* instance.

use alloy_primitives::{Address, B256};
use pagerank_core::{encode, Params};

use crate::manifest::{Manifest, ManifestEntry};
use crate::types::Program;

/// The chain reads the catalog needs. Implemented over RPC by the daemon, and over a table by the
/// tests.
pub trait ChainReader {
    type Error: std::fmt::Display;

    fn chain_id(&self) -> Result<u64, Self::Error>;

    /// `InstanceRegistry.getInstanceIds()`.
    fn instance_ids(&self) -> Result<Vec<B256>, Self::Error>;

    /// `InstanceRegistry.getInstance(id)`.
    fn instance_record(&self, id: B256) -> Result<RegistryRecord, Self::Error>;

    /// `InstanceRegistry.paramsAuthority(id)`. Zero identifies an unmigrated legacy row.
    fn params_authority(&self, id: B256) -> Result<Address, Self::Error>;

    /// The full params the factory emitted for this id, reconstructed from the `InstanceCreated`
    /// log in the registering transaction's receipt. `None` when there is no such log — which is
    /// the normal case for anything the factory did not mint.
    fn created_params(&self, id: B256) -> Result<Option<CreatedParams>, Self::Error>;

    /// Complete current tuple read directly from a registered typed controller.
    fn controller_params(&self, controller: Address) -> Result<ControllerParams, Self::Error>;

    /// `MerkleSnapshot.paramsHash()`.
    fn snapshot_params_hash(&self, snapshot: Address) -> Result<B256, Self::Error>;

    /// `TrustGraphFactory.EAS()`.
    fn factory_eas(&self, factory: Address) -> Result<Address, Self::Error>;
}

/// The directory row.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct RegistryRecord {
    pub program: B256,
    pub snapshot: Address,
    pub verifier: Address,
    pub registry_or_accumulator: Address,
    pub params_hash: B256,
}

/// What the factory's `InstanceCreated` log carries.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CreatedParams {
    pub factory: Address,
    pub name: String,
    pub snapshot: Address,
    pub resolver: Address,
    pub created_block: u64,
    pub params: Params,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ControllerParams {
    pub instance_id: B256,
    pub snapshot: Address,
    pub version: u64,
    pub current_params_hash: B256,
    pub params: Params,
}

/// A fully reconstructed, self-checked instance the operator can act on.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CatalogEntry {
    pub instance_id: B256,
    pub program: Program,
    pub snapshot: Address,
    pub accumulator: Address,
    pub verifier: Address,
    /// `None` for a manifest instance whose params come from a file rather than an event.
    pub params: Option<Params>,
    /// The hash our reconstruction produces. Equal to the snapshot's, or this would be a skip.
    pub reconstructed_params_hash: B256,
    /// Typed control metadata. Both are absent for legacy and manifest instances.
    pub params_controller: Option<Address>,
    pub params_version: Option<u64>,
    pub eas: Option<Address>,
    pub created_block: u64,
    pub name: String,
    /// Set when this entry came from a manifest rather than from chain reconstruction.
    pub manifest: Option<ManifestEntry>,
}

/// An instance we will not act on, and why. Never fatal to the run.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Skipped {
    pub instance_id: B256,
    pub snapshot: Address,
    pub reason: SkipCause,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SkipCause {
    /// A different SP1 program owns this instance.
    OtherProgram(B256),
    /// Registered with no factory event and no manifest entry: its params are not on chain and
    /// nothing else describes them, so they cannot be reconstructed.
    Undescribable,
    /// The event no longer describes what the snapshot is pinned to verify.
    ParamsMismatch { reconstructed: B256, on_chain: B256 },
    /// The event and the directory disagree about which contracts this id names.
    RecordDisagreement { event_snapshot: Address, record_snapshot: Address },
    /// A registered controller, its full tuple, the snapshot, or the registry disagree.
    ControllerInconsistent(String),
    /// A chain read failed for this instance. Per-instance, so one flaky read does not stop the
    /// rest of the run.
    ReadFailed(String),
}

impl std::fmt::Display for SkipCause {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            SkipCause::OtherProgram(p) => {
                write!(f, "program {p:#x} is owned by another SP1 program")
            }
            SkipCause::Undescribable => write!(
                f,
                "registered without a factory InstanceCreated event and with no manifest entry — \
                 its params are not on chain, so they cannot be reconstructed"
            ),
            SkipCause::ParamsMismatch { reconstructed, on_chain } => write!(
                f,
                "params_hash(reconstruction) = {reconstructed:#x} != snapshot.paramsHash() = \
                 {on_chain:#x}; proving this would produce a digest that cannot verify"
            ),
            SkipCause::RecordDisagreement { event_snapshot, record_snapshot } => write!(
                f,
                "InstanceCreated names snapshot {event_snapshot:#x} but the directory names \
                 {record_snapshot:#x}; one of them is lying about this id"
            ),
            SkipCause::ControllerInconsistent(detail) => write!(
                f,
                "registered parameter controller is inconsistent: {detail}; refusing this instance"
            ),
            SkipCause::ReadFailed(e) => write!(f, "chain read failed: {e}"),
        }
    }
}

/// The result of one scan.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Catalog {
    pub entries: Vec<CatalogEntry>,
    pub skipped: Vec<Skipped>,
}

impl Catalog {
    pub fn get(&self, id: B256) -> Option<&CatalogEntry> {
        self.entries.iter().find(|e| e.instance_id == id)
    }
}

/// Enumerate the registry, reconstruct every instance of `program`, and fold in the manifest.
///
/// Returns both what we can act on and what we cannot, because a silently shorter list is
/// indistinguishable from a healthy one.
pub fn scan<R: ChainReader>(
    reader: &R,
    program: Program,
    manifest: &Manifest,
) -> Result<Catalog, R::Error> {
    let chain_id = reader.chain_id()?;
    let mut catalog = Catalog::default();

    // Registry-discoverable instances. Only a top-level read is allowed to fail the whole scan:
    // without the id list there is nothing to be per-instance about.
    for id in reader.instance_ids()? {
        match scan_one(reader, program, id) {
            Ok(Some(entry)) => catalog.entries.push(entry),
            Ok(None) => {}
            Err(skipped) => catalog.skipped.push(skipped),
        }
    }

    // Manifest instances. These are keyed by a derived id because they have no registry row, and
    // they are still self-checked against the snapshot's pinned hash by the caller once their
    // params file is loaded — a manifest is a pointer, not an authority.
    for entry in &manifest.entries {
        if entry.program != program {
            continue;
        }
        let id = entry.derived_id(chain_id);
        if catalog.entries.iter().any(|e| e.snapshot == entry.snapshot)
            || catalog.skipped.iter().any(|e| e.snapshot == entry.snapshot)
        {
            continue; // the chain already described it; the chain wins
        }
        let on_chain = match reader.snapshot_params_hash(entry.snapshot) {
            Ok(h) => h,
            Err(e) => {
                catalog.skipped.push(Skipped {
                    instance_id: id,
                    snapshot: entry.snapshot,
                    reason: SkipCause::ReadFailed(e.to_string()),
                });
                continue;
            }
        };
        catalog.entries.push(CatalogEntry {
            instance_id: id,
            program: entry.program,
            snapshot: entry.snapshot,
            accumulator: Address::ZERO,
            verifier: Address::ZERO,
            params: None,
            reconstructed_params_hash: on_chain,
            params_controller: None,
            params_version: None,
            eas: entry.eas,
            created_block: entry.from_block,
            name: format!("{} @ {:#x}", entry.program.name(), entry.snapshot),
            manifest: Some(entry.clone()),
        });
    }

    Ok(catalog)
}

/// `Ok(None)` = not ours. `Err(Skipped)` = ours but unusable. Never returns a hard error: a
/// per-instance failure must not stop the run.
fn scan_one<R: ChainReader>(
    reader: &R,
    program: Program,
    id: B256,
) -> Result<Option<CatalogEntry>, Skipped> {
    let record = reader.instance_record(id).map_err(|e| Skipped {
        instance_id: id,
        snapshot: Address::ZERO,
        reason: SkipCause::ReadFailed(e.to_string()),
    })?;

    if record.program != program.id() {
        return Err(Skipped {
            instance_id: id,
            snapshot: record.snapshot,
            reason: SkipCause::OtherProgram(record.program),
        });
    }

    let created = reader.created_params(id).map_err(|e| Skipped {
        instance_id: id,
        snapshot: record.snapshot,
        reason: SkipCause::ReadFailed(e.to_string()),
    })?;
    let Some(created) = created else {
        return Err(Skipped {
            instance_id: id,
            snapshot: record.snapshot,
            reason: SkipCause::Undescribable,
        });
    };

    if created.snapshot != record.snapshot || created.resolver != record.registry_or_accumulator {
        return Err(Skipped {
            instance_id: id,
            snapshot: record.snapshot,
            reason: SkipCause::RecordDisagreement {
                event_snapshot: created.snapshot,
                record_snapshot: record.snapshot,
            },
        });
    }

    let controller = reader.params_authority(id).map_err(|e| Skipped {
        instance_id: id,
        snapshot: record.snapshot,
        reason: SkipCause::ReadFailed(e.to_string()),
    })?;

    if controller != Address::ZERO {
        let current = reader.controller_params(controller).map_err(|e| Skipped {
            instance_id: id,
            snapshot: record.snapshot,
            reason: SkipCause::ControllerInconsistent(format!("controller read failed: {e}")),
        })?;
        let reconstructed = encode::params_hash(&current.params);
        let snapshot_hash = reader.snapshot_params_hash(record.snapshot).map_err(|e| Skipped {
            instance_id: id,
            snapshot: record.snapshot,
            reason: SkipCause::ReadFailed(e.to_string()),
        })?;

        let mut disagreements = Vec::new();
        if current.instance_id != id {
            disagreements.push(format!(
                "controller instance {:#x} != registry id {id:#x}",
                current.instance_id
            ));
        }
        if current.snapshot != record.snapshot {
            disagreements.push(format!(
                "controller snapshot {:#x} != registry snapshot {:#x}",
                current.snapshot, record.snapshot
            ));
        }
        if reconstructed != current.current_params_hash {
            disagreements.push(format!(
                "params_hash(full tuple) {reconstructed:#x} != controller hash {:#x}",
                current.current_params_hash
            ));
        }
        if current.current_params_hash != snapshot_hash {
            disagreements.push(format!(
                "controller hash {:#x} != snapshot live hash {snapshot_hash:#x} (raw hash bypass or partial rotation)",
                current.current_params_hash
            ));
        }
        if current.current_params_hash != record.params_hash {
            disagreements.push(format!(
                "controller hash {:#x} != registry hash {:#x}",
                current.current_params_hash, record.params_hash
            ));
        }
        if !disagreements.is_empty() {
            return Err(Skipped {
                instance_id: id,
                snapshot: record.snapshot,
                reason: SkipCause::ControllerInconsistent(disagreements.join("; ")),
            });
        }

        let eas = reader.factory_eas(created.factory).ok();
        return Ok(Some(CatalogEntry {
            instance_id: id,
            program,
            snapshot: record.snapshot,
            accumulator: record.registry_or_accumulator,
            verifier: record.verifier,
            params: Some(current.params),
            reconstructed_params_hash: reconstructed,
            params_controller: Some(controller),
            params_version: Some(current.version),
            eas,
            created_block: created.created_block,
            name: created.name,
            manifest: None,
        }));
    }

    // Legacy fallback: the immutable creation event is the only full tuple available.
    let reconstructed = encode::params_hash(&created.params);
    let on_chain = reader.snapshot_params_hash(record.snapshot).map_err(|e| Skipped {
        instance_id: id,
        snapshot: record.snapshot,
        reason: SkipCause::ReadFailed(e.to_string()),
    })?;
    if reconstructed != on_chain {
        return Err(Skipped {
            instance_id: id,
            snapshot: record.snapshot,
            reason: SkipCause::ParamsMismatch { reconstructed, on_chain },
        });
    }

    // The EAS is the factory's, not the instance's, so it is looked up once per factory by the
    // caller's reader (which is free to cache).
    let eas = reader.factory_eas(created.factory).ok();

    Ok(Some(CatalogEntry {
        instance_id: id,
        program,
        snapshot: record.snapshot,
        accumulator: record.registry_or_accumulator,
        verifier: record.verifier,
        params: Some(created.params),
        reconstructed_params_hash: reconstructed,
        params_controller: None,
        params_version: None,
        eas,
        created_block: created.created_block,
        name: created.name,
        manifest: None,
    }))
}
