//! The catalog against a fake chain: what gets reconstructed, what gets skipped, and — the point
//! of the whole module — that a skip is per-instance and never takes the run down with it.

use alloy_primitives::{address, Address, B256, U256};
use operator_core::catalog::{
    scan, Catalog, ChainReader, CompositionControllerParams, ContributionsControllerParams,
    ControllerParams, CreatedParams, RegistryRecord, SignerSyncDescriptor, SkipCause,
    WeightedControllerParams, WeightedCreatedParams,
};
use operator_core::manifest::{Manifest, ManifestEntry};
use operator_core::types::Program;
use pagerank_core::{encode, Params, SelectionParams};
use std::collections::BTreeMap;

fn params(seed: u8) -> Params {
    let s = U256::from(10u64).pow(U256::from(18u64));
    Params {
        damping_fp: s * U256::from(85u64) / U256::from(100u64),
        tolerance_fp: s / U256::from(1_000_000u64),
        max_iterations: 100,
        min_weight_fp: U256::ZERO,
        max_weight_fp: U256::from(100u64) * s,
        trust_share_fp: s,
        trust_decay_fp: s * U256::from(80u64) / U256::from(100u64),
        trusted_seeds: vec![Address::from([seed; 20])],
        total_pool: U256::from(1_000_000u64),
        precision_scale: s,
        schema_uid: B256::from([seed; 32]),
        weight_field_index: 1,
        envelope0_domain_separators: vec![],
        lane2_max_head_age: 0,
        accumulator: Address::from([seed.wrapping_add(1); 20]),
        chain_id: 31337,
    }
}

#[derive(Default)]
struct FakeChain {
    ids: Vec<B256>,
    records: BTreeMap<B256, RegistryRecord>,
    created: BTreeMap<B256, CreatedParams>,
    snapshot_hashes: BTreeMap<Address, B256>,
    factory_eas: BTreeMap<Address, Address>,
    authorities: BTreeMap<B256, Address>,
    controllers: BTreeMap<Address, ControllerParams>,
    contributions_controllers: BTreeMap<Address, ContributionsControllerParams>,
    weighted_controllers: BTreeMap<Address, WeightedControllerParams>,
    composition_controllers: BTreeMap<Address, CompositionControllerParams>,
    weighted_created: BTreeMap<B256, WeightedCreatedParams>,
    registration_blocks: BTreeMap<B256, u64>,
    /// Instance ids whose reads blow up, to prove one flaky read does not stop the rest.
    poisoned: Vec<B256>,
}

#[derive(Debug)]
struct FakeError(String);
impl std::fmt::Display for FakeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.0)
    }
}

impl ChainReader for FakeChain {
    type Error = FakeError;

    fn chain_id(&self) -> Result<u64, Self::Error> {
        Ok(31337)
    }
    fn instance_ids(&self) -> Result<Vec<B256>, Self::Error> {
        Ok(self.ids.clone())
    }
    fn instance_record(&self, id: B256) -> Result<RegistryRecord, Self::Error> {
        if self.poisoned.contains(&id) {
            return Err(FakeError("rpc exploded".into()));
        }
        self.records.get(&id).copied().ok_or_else(|| FakeError("no such instance".into()))
    }
    fn params_authority(&self, id: B256) -> Result<Address, Self::Error> {
        Ok(self.authorities.get(&id).copied().unwrap_or(Address::ZERO))
    }
    fn registration_block(&self, id: B256) -> Result<u64, Self::Error> {
        self.registration_blocks
            .get(&id)
            .copied()
            .or_else(|| self.created.get(&id).map(|created| created.created_block))
            .ok_or_else(|| FakeError("no registration event".into()))
    }
    fn created_params(&self, id: B256) -> Result<Option<CreatedParams>, Self::Error> {
        Ok(self.created.get(&id).cloned())
    }
    fn controller_params(&self, controller: Address) -> Result<ControllerParams, Self::Error> {
        self.controllers.get(&controller).cloned().ok_or_else(|| FakeError("no controller".into()))
    }
    fn contributions_controller_params(
        &self,
        controller: Address,
    ) -> Result<ContributionsControllerParams, Self::Error> {
        self.contributions_controllers
            .get(&controller)
            .cloned()
            .ok_or_else(|| FakeError("no contributions controller".into()))
    }
    fn weighted_controller_params(
        &self,
        controller: Address,
    ) -> Result<WeightedControllerParams, Self::Error> {
        self.weighted_controllers
            .get(&controller)
            .cloned()
            .ok_or_else(|| FakeError("no weighted controller".into()))
    }
    fn weighted_created_params(
        &self,
        id: B256,
    ) -> Result<Option<WeightedCreatedParams>, Self::Error> {
        Ok(self.weighted_created.get(&id).cloned())
    }
    fn composition_controller_params(
        &self,
        controller: Address,
    ) -> Result<CompositionControllerParams, Self::Error> {
        self.composition_controllers
            .get(&controller)
            .cloned()
            .ok_or_else(|| FakeError("no composition controller".into()))
    }
    fn snapshot_params_hash(&self, snapshot: Address) -> Result<B256, Self::Error> {
        self.snapshot_hashes.get(&snapshot).copied().ok_or_else(|| FakeError("no snapshot".into()))
    }
    fn factory_eas(&self, factory: Address) -> Result<Address, Self::Error> {
        self.factory_eas.get(&factory).copied().ok_or_else(|| FakeError("no factory".into()))
    }
}

const FACTORY: Address = address!("00000000000000000000000000000000000000F1");
const EAS: Address = address!("00000000000000000000000000000000000000E1");

/// Register a healthy, self-consistent trust-graph instance.
fn add_healthy(chain: &mut FakeChain, seed: u8) -> B256 {
    let id = B256::from([seed; 32]);
    let snapshot = Address::from([seed.wrapping_add(0x10); 20]);
    let resolver = Address::from([seed.wrapping_add(0x20); 20]);
    let p = params(seed);
    let hash = encode::params_hash(&p);

    chain.ids.push(id);
    chain.records.insert(
        id,
        RegistryRecord {
            program: Program::Trustgraphs.id(),
            snapshot,
            verifier: Address::from([seed.wrapping_add(0x30); 20]),
            registry_or_accumulator: resolver,
            params_hash: hash,
        },
    );
    chain.created.insert(
        id,
        CreatedParams {
            factory: FACTORY,
            name: format!("net-{seed}"),
            snapshot,
            resolver,
            created_block: 100,
            params: p,
            signer_sync: None,
        },
    );
    chain.snapshot_hashes.insert(snapshot, hash);
    chain.factory_eas.insert(FACTORY, EAS);
    id
}

#[test]
fn governed_signer_module_is_derived_from_creation_events_without_a_manifest() {
    let mut chain = FakeChain::default();
    let parent = add_healthy(&mut chain, 1);
    let module = Address::from([0x91; 20]);
    let selection = SelectionParams {
        top_n: 5,
        min_threshold: 2,
        target_threshold_bps: 6000,
        max_inactive_blocks: 151_200,
        min_activity_witnesses: 2,
    };
    let operator_instance_id = B256::from([0xA1; 32]);
    let created = chain.created.get_mut(&parent).unwrap();
    created.signer_sync = Some(SignerSyncDescriptor {
        operator_instance_id,
        module,
        safe: Address::from([0x92; 20]),
        score_snapshot: created.snapshot,
        activity_source: Address::from([0x95; 20]),
        accumulator: created.resolver,
        verifier: Address::from([0x93; 20]),
        program_vkey: B256::from([0x94; 32]),
        selection_params_hash: encode::selection_params_hash(&selection),
        selection,
    });

    let catalog = scan(&chain, Program::Signer, &Manifest::default()).unwrap();
    assert!(catalog.skipped.is_empty());
    let signer = catalog.get(operator_instance_id).expect("derived signer program");
    assert_eq!(signer.parent_instance_id, Some(parent));
    assert_eq!(signer.submit_to, module);
    assert_eq!(signer.selection, Some(selection));
    assert_eq!(signer.program, Program::Signer);
    assert!(signer.manifest.is_none(), "the helper event is the descriptor");
}

fn add_controller(chain: &mut FakeChain, id: B256, version: u64, current: Params) -> Address {
    let controller = Address::from([id[0].wrapping_add(0x40); 20]);
    let record = chain.records.get_mut(&id).unwrap();
    let hash = encode::params_hash(&current);
    record.params_hash = hash;
    chain.snapshot_hashes.insert(record.snapshot, hash);
    chain.authorities.insert(id, controller);
    chain.controllers.insert(
        controller,
        ControllerParams {
            instance_id: id,
            snapshot: record.snapshot,
            version,
            current_params_hash: hash,
            params: current,
        },
    );
    controller
}

fn contributions_params(seed: u8) -> contributions_core::Params {
    let s = U256::from(10u64).pow(U256::from(18u64));
    contributions_core::Params {
        damping_fp: s * U256::from(85u64) / U256::from(100u64),
        tolerance_fp: s / U256::from(1_000_000u64),
        max_iterations: 100,
        min_weight_fp: U256::ZERO,
        max_weight_fp: U256::from(100u64) * s,
        trust_share_fp: s,
        trust_decay_fp: s * U256::from(80u64) / U256::from(100u64),
        trusted_seeds: vec![Address::from([seed; 20])],
        precision_scale: s,
        weight_field_index: 1,
        round_start: 1_700_000_000,
        round_end: 1_700_604_800,
        unaccepted_mult_fp: s / U256::from(2u64),
        collaborator_mult_fp: s / U256::from(2u64),
        min_rater_rep_fp: U256::from(1_000_000_000u64),
        evaluator_carveout_bps: 100,
        total_pool: U256::from(5_000_000_000u64),
        claim_schema_uid: B256::from([seed; 32]),
        response_schema_uid: B256::from([seed.wrapping_add(1); 32]),
        valuation_schema_uid: B256::from([seed.wrapping_add(2); 32]),
    }
}

fn add_contributions(chain: &mut FakeChain, seed: u8) -> B256 {
    let id = B256::from([seed; 32]);
    let snapshot = Address::from([seed.wrapping_add(0x10); 20]);
    let resolver = Address::from([seed.wrapping_add(0x20); 20]);
    let controller = Address::from([seed.wrapping_add(0x40); 20]);
    let p = contributions_params(seed);
    let hash = contributions_core::params::params_hash(&p);
    chain.ids.push(id);
    chain.records.insert(
        id,
        RegistryRecord {
            program: Program::Contributions.id(),
            snapshot,
            verifier: Address::from([seed.wrapping_add(0x30); 20]),
            registry_or_accumulator: resolver,
            params_hash: hash,
        },
    );
    chain.snapshot_hashes.insert(snapshot, hash);
    chain.authorities.insert(id, controller);
    chain.registration_blocks.insert(id, 77);
    chain.contributions_controllers.insert(
        controller,
        ContributionsControllerParams {
            instance_id: id,
            snapshot,
            eas: EAS,
            version: 1,
            current_params_hash: hash,
            params: p,
        },
    );
    id
}

fn weighted_params(seed: u8, resolver: Address) -> weighted_prior_core::Params {
    use weighted_prior_core::{manifest, PriorEntry, PARAMS_VERSION, SCALE};
    let entries = vec![PriorEntry { account: Address::from([seed; 20]), weight: SCALE }];
    let bytes = manifest::canonical_manifest(31_337, &entries).unwrap();
    weighted_prior_core::Params {
        version: PARAMS_VERSION,
        damping_fp: 850_000_000_000_000_000,
        tolerance_fp: 1_000_000_000_000,
        max_iterations: 40,
        min_weight: 0,
        max_weight: 100,
        prior_root: manifest::prior_root(&entries).unwrap(),
        prior_count: 1,
        manifest_sha256: manifest::manifest_digest(&bytes),
        schema_uid: B256::from([seed; 32]),
        weight_field_index: 1,
        accumulator: resolver,
        chain_id: 31_337,
    }
}

fn add_weighted(chain: &mut FakeChain, seed: u8) -> B256 {
    let id = B256::from([seed; 32]);
    let snapshot = Address::from([seed.wrapping_add(0x10); 20]);
    let resolver = Address::from([seed.wrapping_add(0x20); 20]);
    let controller = Address::from([seed.wrapping_add(0x40); 20]);
    let params = weighted_params(seed, resolver);
    let hash = weighted_prior_core::encode::params_hash(&params);
    chain.ids.push(id);
    chain.records.insert(
        id,
        RegistryRecord {
            program: Program::Weighted.id(),
            snapshot,
            verifier: Address::from([seed.wrapping_add(0x30); 20]),
            registry_or_accumulator: resolver,
            params_hash: hash,
        },
    );
    chain.snapshot_hashes.insert(snapshot, hash);
    chain.authorities.insert(id, controller);
    chain.factory_eas.insert(FACTORY, EAS);
    chain.weighted_created.insert(
        id,
        WeightedCreatedParams {
            factory: FACTORY,
            name: format!("weighted-{seed}"),
            snapshot,
            resolver,
            created_block: 88,
        },
    );
    chain.weighted_controllers.insert(
        controller,
        WeightedControllerParams {
            instance_id: id,
            snapshot,
            version: 1,
            current_params_hash: hash,
            params,
        },
    );
    id
}

fn composition_params(accumulator: Address) -> composition_core::Params {
    let sample = composition_core::fixture::sample_input();
    let capture =
        composition_core::codec::parse_capture_manifest(&sample.manifest, sample.params.chain_id)
            .unwrap();
    let mut params = sample.params;
    params.chain_id = 31_337;
    params.accumulator = accumulator;
    params.source_policy_root = composition_core::codec::source_policy_root(&capture.sources);
    params.policy_manifest_sha256 = composition_core::codec::manifest_digest(
        &composition_core::codec::policy_manifest_encoded(31_337, &capture.sources),
    );
    params
}

fn add_composition(chain: &mut FakeChain, seed: u8) -> B256 {
    let id = B256::from([seed; 32]);
    let snapshot = Address::from([seed.wrapping_add(0x10); 20]);
    let accumulator = Address::from([seed.wrapping_add(0x20); 20]);
    let controller = Address::from([seed.wrapping_add(0x40); 20]);
    let params = composition_params(accumulator);
    let hash = composition_core::codec::params_hash(&params);
    chain.ids.push(id);
    chain.records.insert(
        id,
        RegistryRecord {
            program: Program::Composition.id(),
            snapshot,
            verifier: Address::from([seed.wrapping_add(0x30); 20]),
            registry_or_accumulator: accumulator,
            params_hash: hash,
        },
    );
    chain.snapshot_hashes.insert(snapshot, hash);
    chain.authorities.insert(id, controller);
    chain.registration_blocks.insert(id, 99);
    chain.composition_controllers.insert(
        controller,
        CompositionControllerParams {
            instance_id: id,
            snapshot,
            version: 1,
            current_params_hash: hash,
            params,
        },
    );
    id
}

fn add_nostr_workspace(chain: &mut FakeChain, seed: u8) -> (B256, ManifestEntry) {
    let id = B256::from([seed; 32]);
    let snapshot = Address::from([seed.wrapping_add(0x10); 20]);
    let anchor_registry = Address::from([seed.wrapping_add(0x20); 20]);
    let params_authority = Address::from([seed.wrapping_add(0x40); 20]);
    let params_hash = B256::from([seed.wrapping_add(0x50); 32]);

    chain.ids.push(id);
    chain.records.insert(
        id,
        RegistryRecord {
            program: Program::NostrWorkspace.id(),
            snapshot,
            verifier: Address::from([seed.wrapping_add(0x30); 20]),
            registry_or_accumulator: anchor_registry,
            params_hash,
        },
    );
    chain.snapshot_hashes.insert(snapshot, params_hash);
    chain.authorities.insert(id, params_authority);
    chain.registration_blocks.insert(id, 111);

    let manifest = ManifestEntry {
        program: Program::NostrWorkspace,
        snapshot,
        params: "nostr-workspace.params.json".into(),
        eas: None,
        submit_to: None,
        selection: None,
        depends_on: vec![],
        from_block: 0,
        witness_manifests: vec!["archives/a.manifest.json".into()],
    };
    (id, manifest)
}

fn scan_all(chain: &FakeChain) -> Catalog {
    scan(chain, Program::Trustgraphs, &Manifest::default()).unwrap()
}

#[test]
fn a_healthy_instance_is_reconstructed_with_zero_per_instance_config() {
    let mut chain = FakeChain::default();
    let id = add_healthy(&mut chain, 1);

    let catalog = scan_all(&chain);
    assert!(catalog.skipped.is_empty());
    let entry = catalog.get(id).expect("reconstructed");
    assert_eq!(entry.program, Program::Trustgraphs);
    assert_eq!(entry.eas, Some(EAS));
    assert_eq!(entry.name, "net-1");
    assert!(entry.manifest.is_none(), "the chain described it; no manifest needed");
    // The self-check: our Rust encoder reproduced the hash the Solidity codec wrote at creation.
    assert_eq!(entry.reconstructed_params_hash, chain.snapshot_hashes[&entry.snapshot]);
}

#[test]
fn a_controller_rotation_uses_the_live_tuple_not_the_creation_tuple() {
    let mut chain = FakeChain::default();
    let id = add_healthy(&mut chain, 1);
    let creation_hash = encode::params_hash(&chain.created[&id].params);
    let mut current = chain.created[&id].params.clone();
    current.damping_fp -= U256::from(1u64);
    current.trusted_seeds = vec![Address::from([0xAA; 20]), Address::from([0xBB; 20])];
    let controller = add_controller(&mut chain, id, 2, current.clone());

    let catalog = scan_all(&chain);
    let entry = catalog.get(id).expect("controller-backed instance is healthy");
    assert_eq!(entry.params_controller, Some(controller));
    assert_eq!(entry.params_version, Some(2));
    assert_eq!(entry.params, Some(current));
    assert_ne!(entry.reconstructed_params_hash, creation_hash);
    assert!(entry.manifest.is_none());
}

#[test]
fn contributions_are_reconstructed_from_the_registry_controller_without_a_manifest() {
    let mut chain = FakeChain::default();
    let id = add_contributions(&mut chain, 9);

    let catalog = scan(&chain, Program::Contributions, &Manifest::default()).unwrap();
    assert!(catalog.skipped.is_empty());
    let entry = catalog.get(id).expect("chain-described contributions round");
    assert_eq!(entry.eas, Some(EAS));
    assert_eq!(entry.created_block, 77);
    assert!(entry.params.is_none());
    let p = entry.contributions_params.as_ref().expect("complete contributions tuple");
    assert_eq!(contributions_core::params::params_hash(p), entry.reconstructed_params_hash);
    assert!(entry.manifest.is_none());
}

#[test]
fn weighted_instances_use_only_the_isolated_controller_and_codec() {
    let mut chain = FakeChain::default();
    let id = add_weighted(&mut chain, 7);

    let catalog = scan(&chain, Program::Weighted, &Manifest::default()).unwrap();
    assert!(catalog.skipped.is_empty());
    let entry = catalog.get(id).expect("chain-described weighted instance");
    assert_eq!(entry.program, Program::Weighted);
    assert_eq!(entry.eas, Some(EAS));
    assert_eq!(entry.created_block, 88);
    assert!(entry.params.is_none(), "binary params must remain isolated");
    let params = entry.weighted_params.as_ref().expect("weighted tuple");
    assert_eq!(weighted_prior_core::encode::params_hash(params), entry.reconstructed_params_hash);
}

#[test]
fn weighted_controller_disagreement_fails_closed() {
    let mut chain = FakeChain::default();
    let id = add_weighted(&mut chain, 8);
    let controller = chain.authorities[&id];
    chain.weighted_controllers.get_mut(&controller).unwrap().params.chain_id = 10;

    let catalog = scan(&chain, Program::Weighted, &Manifest::default()).unwrap();
    assert!(catalog.get(id).is_none());
    assert!(matches!(catalog.skipped[0].reason, SkipCause::ControllerInconsistent(_)));
}

#[test]
fn composition_is_discovered_only_through_its_typed_controller_and_program_id() {
    let mut chain = FakeChain::default();
    let id = add_composition(&mut chain, 12);

    let catalog = scan(&chain, Program::Composition, &Manifest::default()).unwrap();
    assert!(catalog.skipped.is_empty());
    let entry = catalog.get(id).expect("chain-described composition instance");
    assert_eq!(entry.program, Program::Composition);
    assert_eq!(entry.created_block, 99);
    assert!(entry.params.is_none());
    assert!(entry.weighted_params.is_none());
    let params = entry.composition_params.as_ref().expect("composition tuple");
    assert_eq!(composition_core::codec::params_hash(params), entry.reconstructed_params_hash);
}

#[test]
fn composition_controller_or_registry_drift_fails_closed() {
    let mut chain = FakeChain::default();
    let id = add_composition(&mut chain, 13);
    let controller = chain.authorities[&id];
    chain.composition_controllers.get_mut(&controller).unwrap().params.max_sources = 9;

    let catalog = scan(&chain, Program::Composition, &Manifest::default()).unwrap();
    assert!(catalog.get(id).is_none());
    assert!(matches!(catalog.skipped[0].reason, SkipCause::ControllerInconsistent(_)));
}

#[test]
fn nostr_workspace_joins_the_registry_tuple_to_immutable_witness_pointers() {
    let mut chain = FakeChain::default();
    let (id, manifest_entry) = add_nostr_workspace(&mut chain, 14);
    let manifest = Manifest { entries: vec![manifest_entry.clone()] };
    manifest.validate().unwrap();

    let catalog = scan(&chain, Program::NostrWorkspace, &manifest).unwrap();
    assert!(catalog.skipped.is_empty());
    let entry = catalog.get(id).expect("registered and manifest-described Nostr instance");
    let record = chain.records[&id];
    assert_eq!(entry.program, Program::NostrWorkspace);
    assert_eq!(entry.snapshot, record.snapshot);
    assert_eq!(entry.submit_to, record.snapshot);
    assert_eq!(entry.accumulator, record.registry_or_accumulator);
    assert_eq!(entry.verifier, record.verifier);
    assert_eq!(entry.reconstructed_params_hash, record.params_hash);
    assert_eq!(entry.params_controller, chain.authorities.get(&id).copied());
    assert_eq!(entry.created_block, 111);
    assert_eq!(entry.manifest, Some(manifest_entry));
}

#[test]
fn nostr_workspace_without_witness_description_fails_closed() {
    let mut chain = FakeChain::default();
    let (id, _) = add_nostr_workspace(&mut chain, 15);

    let catalog = scan(&chain, Program::NostrWorkspace, &Manifest::default()).unwrap();
    assert!(catalog.get(id).is_none());
    assert_eq!(catalog.skipped.len(), 1);
    assert_eq!(catalog.skipped[0].reason, SkipCause::Undescribable);
}

#[test]
fn a_raw_snapshot_hash_bypass_fails_closed_without_blocking_healthy_instances() {
    let mut chain = FakeChain::default();
    let bad = add_healthy(&mut chain, 1);
    let good = add_healthy(&mut chain, 2);
    let current = chain.created[&bad].params.clone();
    add_controller(&mut chain, bad, 1, current);
    let bad_snapshot = chain.records[&bad].snapshot;
    chain.snapshot_hashes.insert(bad_snapshot, B256::from([0xFF; 32]));

    let catalog = scan_all(&chain);
    assert!(catalog.get(good).is_some());
    assert!(catalog.get(bad).is_none());
    assert!(matches!(catalog.skipped[0].reason, SkipCause::ControllerInconsistent(_)));
    assert!(catalog.skipped[0].reason.to_string().contains("raw hash bypass"));
}

#[test]
fn one_bad_row_does_not_stop_every_healthy_instance() {
    // The behaviour that deliberately differs from `instance_scan`, which aborts the whole run.
    let mut chain = FakeChain::default();
    let good_a = add_healthy(&mut chain, 1);
    let bad = add_healthy(&mut chain, 2);
    let good_b = add_healthy(&mut chain, 3);

    // The middle instance's snapshot rotated to something our reconstruction cannot reproduce.
    let bad_snapshot = chain.records[&bad].snapshot;
    chain.snapshot_hashes.insert(bad_snapshot, B256::from([0xFF; 32]));

    let catalog = scan_all(&chain);
    assert!(catalog.get(good_a).is_some(), "a healthy instance must survive its neighbour");
    assert!(catalog.get(good_b).is_some());
    assert!(catalog.get(bad).is_none());
    assert_eq!(catalog.skipped.len(), 1);
    assert!(matches!(catalog.skipped[0].reason, SkipCause::ParamsMismatch { .. }));
}

#[test]
fn a_flaky_read_skips_one_instance_and_keeps_going() {
    let mut chain = FakeChain::default();
    let good = add_healthy(&mut chain, 1);
    let flaky = add_healthy(&mut chain, 2);
    chain.poisoned.push(flaky);

    let catalog = scan_all(&chain);
    assert!(catalog.get(good).is_some());
    assert_eq!(catalog.skipped.len(), 1);
    assert!(matches!(catalog.skipped[0].reason, SkipCause::ReadFailed(_)));
}

#[test]
fn an_instance_owned_by_another_program_is_skipped_not_proven() {
    let mut chain = FakeChain::default();
    let id = add_healthy(&mut chain, 1);
    chain.records.get_mut(&id).unwrap().program = Program::Hypercerts.id();

    let catalog = scan_all(&chain);
    assert!(catalog.entries.is_empty());
    assert!(matches!(catalog.skipped[0].reason, SkipCause::OtherProgram(_)));
}

#[test]
fn an_instance_the_chain_cannot_describe_is_named_as_such() {
    let mut chain = FakeChain::default();
    let id = add_healthy(&mut chain, 1);
    chain.created.remove(&id); // registered, but not by the factory

    let catalog = scan_all(&chain);
    assert!(catalog.entries.is_empty());
    assert_eq!(catalog.skipped[0].reason, SkipCause::Undescribable);
    // And the message says what to do about it rather than just refusing.
    assert!(catalog.skipped[0].reason.to_string().contains("manifest"));
}

#[test]
fn an_event_that_disagrees_with_the_directory_is_refused() {
    let mut chain = FakeChain::default();
    let id = add_healthy(&mut chain, 1);
    chain.created.get_mut(&id).unwrap().snapshot =
        address!("00000000000000000000000000000000DEADBEEF");

    let catalog = scan_all(&chain);
    assert!(catalog.entries.is_empty());
    assert!(matches!(catalog.skipped[0].reason, SkipCause::RecordDisagreement { .. }));
}

#[test]
fn a_manifest_covers_what_the_chain_cannot_describe() {
    // A legacy Contributions deployment can still be described by a manifest.
    let mut chain = FakeChain::default();
    add_healthy(&mut chain, 1);
    let contrib_snapshot = address!("00000000000000000000000000000000000000C0");
    chain.snapshot_hashes.insert(contrib_snapshot, B256::from([0x77; 32]));

    let manifest = Manifest {
        entries: vec![ManifestEntry {
            program: Program::Contributions,
            snapshot: contrib_snapshot,
            params: "params.contributions.json".into(),
            eas: Some(EAS),
            submit_to: None,
            selection: None,
            depends_on: vec![],
            from_block: 42,
            witness_manifests: vec![],
        }],
    };
    manifest.validate().unwrap();

    // Scanning for trust-graph does not pick up the contributions entry...
    let tg = scan(&chain, Program::Trustgraphs, &manifest).unwrap();
    assert_eq!(tg.entries.len(), 1);
    assert!(tg.entries.iter().all(|e| e.manifest.is_none()));

    // ...and scanning for contributions finds exactly it, with no registry row at all.
    let cc = scan(&chain, Program::Contributions, &manifest).unwrap();
    assert_eq!(cc.entries.len(), 1);
    let e = &cc.entries[0];
    assert_eq!(e.snapshot, contrib_snapshot);
    assert_eq!(e.created_block, 42);
    assert!(e.manifest.is_some());
    assert!(e.params.is_none(), "a manifest is a pointer to a params file, not the params");
}

#[test]
fn the_chain_wins_when_a_manifest_duplicates_a_registered_instance() {
    let mut chain = FakeChain::default();
    let id = add_healthy(&mut chain, 1);
    let snapshot = chain.records[&id].snapshot;

    let manifest = Manifest {
        entries: vec![ManifestEntry {
            program: Program::Trustgraphs,
            snapshot,
            params: "stale.json".into(),
            eas: Some(EAS),
            submit_to: None,
            selection: None,
            depends_on: vec![],
            from_block: 0,
            witness_manifests: vec![],
        }],
    };
    let catalog = scan(&chain, Program::Trustgraphs, &manifest).unwrap();
    assert_eq!(catalog.entries.len(), 1);
    assert!(
        catalog.entries[0].manifest.is_none(),
        "a stale manifest file must never shadow what the chain says"
    );
}

#[test]
fn a_manifest_entry_that_cannot_work_is_rejected_at_load_time() {
    use operator_core::manifest::ManifestError;

    let base = ManifestEntry {
        program: Program::Signer,
        snapshot: address!("00000000000000000000000000000000000000C0"),
        params: "p.json".into(),
        eas: None,
        submit_to: None,
        selection: None,
        depends_on: vec![],
        from_block: 0,
        witness_manifests: vec![],
    };
    assert_eq!(base.validate(), Err(ManifestError::SignerNeedsSelection));

    let mut zero = base.clone();
    zero.snapshot = Address::ZERO;
    assert_eq!(zero.validate(), Err(ManifestError::ZeroSnapshot));

    let mut no_params = base.clone();
    no_params.selection = Some("s.json".into());
    no_params.params = String::new();
    assert_eq!(no_params.validate(), Err(ManifestError::MissingParams));

    let mut no_eas = base.clone();
    no_eas.program = Program::Contributions;
    assert_eq!(no_eas.validate(), Err(ManifestError::NeedsEas(Program::Contributions)));

    let mut ok = base;
    ok.selection = Some("s.json".into());
    assert_eq!(ok.validate(), Ok(()));
}
