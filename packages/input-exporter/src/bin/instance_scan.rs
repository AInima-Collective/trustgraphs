//! instance-scan — "chain is the config": reconstruct every registry instance from chain data.
//!
//! Given nothing but an RPC endpoint and an `InstanceRegistry` address, this walks the directory and
//! rebuilds each instance's complete proving configuration — addresses, EAS, and its full canonical
//! params tuple — with **zero per-instance config files and zero manual params entry**. It writes one
//! `params.json` per instance plus a machine-readable plan (`instances.json`) that
//! `task instances:prove-all` drives the trigger → export → prove → pin → submit loop from.
//!
//! How it finds an instance's params without being told where to look:
//!
//! 1. `getInstanceIds()` enumerates the directory; `getInstance(id)` gives the contract set.
//! 2. Trust graphs recover the creation tuple from their factory's `InstanceCreated` log.
//! 3. Contributions instances follow `paramsAuthority(id)` to their typed controller and recover
//!    the hash-selected tuple from its append-only `ContributionsParamsUpdated` history. The
//!    controller also publishes its EAS and snapshot addresses.
//!
//! The load-bearing safety check is step 4: `pagerank_core::encode::params_hash(event.params)` must
//! equal the live `snapshot.paramsHash()`. That is the canonical **Rust** encoder re-deriving the
//! hash that `ParamsCodec.hash` (Solidity) wrote at creation, over params decoded from the event —
//! so a mismatch means the event, the codec ports, or the snapshot disagree about what this instance
//! computes. Proving on a bad params set produces a journal digest that can never verify (best case)
//! or one that verifies for the *wrong* instance (the §6.1 replay hazard the v2 schema closes), so a
//! mismatch is a hard stop for the whole run, never a warning.
//!
//! Read-only: this binary never signs or sends a transaction.

use alloy_primitives::{keccak256, Address, B256, U256};
use alloy_sol_types::{sol, SolCall, SolEvent, SolValue};
use anyhow::{anyhow, bail, Context, Result};
use clap::Parser;
use input_exporter::rpc::{parse_addr, Rpc};
use pagerank_core::{encode, Params};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

sol! {
    /// Mirror of `ParamsCodec.Params` (params schema v2 — 17 fields, order FROZEN).
    struct SolParams {
        uint256 dampingFp;
        uint256 toleranceFp;
        uint32 maxIterations;
        uint256 minWeightFp;
        uint256 maxWeightFp;
        uint256 trustMultiplierFp;
        uint256 trustShareFp;
        uint256 trustDecayFp;
        address[] trustedSeeds;
        uint256 totalPool;
        uint256 precisionScale;
        bytes32 schemaUid;
        uint32 weightFieldIndex;
        bytes32[] envelope0DomainSeparators;
        uint64 lane2MaxHeadAge;
        address accumulator;
        uint64 chainId;
    }

    /// Mirror of `ContributionsParamsCodec.Params` (21 fields, order FROZEN).
    struct SolContributionsParams {
        uint256 dampingFp;
        uint256 toleranceFp;
        uint32 maxIterations;
        uint256 minWeightFp;
        uint256 maxWeightFp;
        uint256 trustMultiplierFp;
        uint256 trustShareFp;
        uint256 trustDecayFp;
        address[] trustedSeeds;
        uint256 precisionScale;
        uint32 weightFieldIndex;
        uint64 roundStart;
        uint64 roundEnd;
        uint256 unacceptedMultFp;
        uint256 collaboratorMultFp;
        uint256 minRaterRepFp;
        uint32 evaluatorCarveoutBps;
        uint256 totalPool;
        bytes32 claimSchemaUid;
        bytes32 responseSchemaUid;
        bytes32 valuationSchemaUid;
    }

    /// The frozen factory interface (`TrustgraphsFactory.sol`).
    event InstanceCreated(
        bytes32 indexed instanceId,
        address indexed creator,
        address indexed admin,
        string name,
        string metadataURI,
        address resolver,
        bytes32 schemaUid,
        address snapshot,
        address distributor,
        address distributorToken,
        uint64 epochLength,
        SolParams params
    );
    event OffchainEasLaneCreated(
        bytes32 indexed instanceId, address registry, bytes32 domainSeparator, uint64 maxTotalInputs
    );

    /// `IInstanceRegistry`.
    struct Instance {
        bytes32 program;
        address snapshot;
        address verifier;
        address registryOrAccumulator;
        bytes32 paramsHash;
    }
    event InstanceRegistered(
        bytes32 indexed instanceId,
        bytes32 indexed program,
        address snapshot,
        address verifier,
        address registryOrAccumulator,
        bytes32 paramsHash
    );
    function getInstanceIds() external view returns (bytes32[]);
    function getInstance(bytes32 instanceId) external view returns (Instance);
    function paramsAuthority(bytes32 instanceId) external view returns (address);

    /// `ContributionsParamsController` — the complete, versioned params preimage.
    event ContributionsParamsUpdated(
        bytes32 indexed instanceId,
        uint64 indexed version,
        bytes32 indexed paramsHash,
        bytes32 previousParamsHash,
        SolContributionsParams params,
        string evidenceURI
    );
    function instanceId() external view returns (bytes32);
    function snapshot() external view returns (address);
    function eas() external view returns (address);
    function currentParamsHash() external view returns (bytes32);
    function getContributionsParams() external view returns (SolContributionsParams);

    /// `MerkleSnapshot` — the authority on what an instance is pinned to prove.
    function paramsHash() external view returns (bytes32);
    function epochLength() external view returns (uint64);
    function lastTriggerBlock() external view returns (uint64);
    function hasAppliedCheckpoint() external view returns (bool);
    function lastAppliedCheckpoint() external view returns (uint256);
    function anchorRegistry() external view returns (address);
    function checkpointWorkCount(uint256 checkpointId) external view returns (uint64);

    /// `AttestationAccumulator` (the instance's `EASIndexerResolver`).
    struct Checkpoint { bytes32 acc; uint64 leafCount; uint64 blockNumber; }
    function leafCount() external view returns (uint64);
    function checkpointCount() external view returns (uint256);
    function getCheckpoint(uint256 id) external view returns (Checkpoint);
    function anchorCount() external view returns (uint64);
    function workCount() external view returns (uint64);

    /// `EasOffchainAnchorRegistry` immutable/bound provenance.
    function schemaUid() external view returns (bytes32);
    function maxTotalInputs() external view returns (uint64);
    function easDomainSeparator() external view returns (bytes32);
    function headDomainSeparator() external view returns (bytes32);

    /// `TrustgraphsFactory` — the shared singletons an instance inherits.
    function EAS() external view returns (address);
}

#[derive(Parser, Debug)]
#[command(
    name = "instance-scan",
    about = "Enumerate InstanceRegistry and rebuild every instance's proving config from chain data"
)]
struct Args {
    /// JSON-RPC endpoint.
    #[arg(long)]
    rpc: String,
    /// The chain's `InstanceRegistry`. This plus --rpc is the whole configuration.
    #[arg(long)]
    registry: String,
    /// Only scan instances whose registry `program` label is `keccak256(<this>)`.
    #[arg(long, default_value = "trust-graph")]
    program: String,
    /// Root output directory (default: `<repo root>/.trustgraph/trust-graph`). Each instance gets
    /// its own `<root>/<instanceId>/` so concurrent instances never clobber each other's artifacts.
    #[arg(long)]
    out_dir: Option<String>,
    /// First block to scan for `InstanceRegistered` logs (default: 0 — the registry's deploy block
    /// is the fast choice on a long chain).
    #[arg(long, default_value_t = 0)]
    from_block: u64,
    /// Max blocks per eth_getLogs request (many RPCs cap the range).
    #[arg(long, default_value_t = 10_000)]
    chunk: u64,
}

/// Why an instance is not being proven this pass. Never a crash — one unprovable instance must not
/// stop the other N-1 (that is the whole point of a multi-instance loop).
enum Status {
    Ready,
    Skipped(String),
}

impl Status {
    fn label(&self) -> &'static str {
        match self {
            Status::Ready => "ready",
            Status::Skipped(_) => "skipped",
        }
    }
    fn reason(&self) -> &str {
        match self {
            Status::Ready => "",
            Status::Skipped(r) => r,
        }
    }
}

#[tokio::main]
async fn main() -> Result<()> {
    let args = Args::parse();
    let rpc = Rpc::new(args.rpc.clone());
    let registry = parse_addr(&args.registry)?;
    let want_program = keccak256(args.program.as_bytes());

    let chain_id = rpc.eth_chain_id().await.context("eth_chainId failed")?;
    let head = rpc.block_number().await.context("eth_blockNumber failed")?;
    // A trigger sent now executes at `head + 1` at the earliest; judge the epoch boundary against
    // the block the transaction would actually run in, not the one we just read.
    let next_block = head + 1;
    eprintln!("registry {registry:#x} on chain {chain_id} @ block {head}");

    let out_root = match &args.out_dir {
        Some(d) => PathBuf::from(d),
        None => repo_root().join(".trustgraph").join("trust-graph"),
    };
    std::fs::create_dir_all(&out_root)
        .with_context(|| format!("create output dir {}", out_root.display()))?;
    let out_root = out_root.canonicalize().unwrap_or(out_root);

    // --- 1. The directory. ---------------------------------------------------------------------
    let ids_ret = rpc
        .eth_call(registry, getInstanceIdsCall {}.abi_encode())
        .await
        .context("getInstanceIds failed — is --registry an InstanceRegistry?")?;
    let ids = getInstanceIdsCall::abi_decode_returns(&ids_ret).context("decoding instance ids")?;
    eprintln!("{} registered instance(s)", ids.len());

    // --- 2. id -> the transaction that registered it. ------------------------------------------
    let reg_logs = rpc
        .get_logs(
            registry,
            &[Some(InstanceRegistered::SIGNATURE_HASH)],
            args.from_block,
            head,
            args.chunk,
        )
        .await
        .context("querying InstanceRegistered logs")?;
    let mut registered_in: BTreeMap<B256, (u64, B256)> = BTreeMap::new();
    for log in &reg_logs {
        if let Some(id) = log.topics.get(1) {
            // First registration wins; `update()` emits a different event and never re-registers.
            registered_in.entry(*id).or_insert((log.block_number, log.transaction_hash));
        }
    }

    let mut entries: Vec<Value> = Vec::new();
    let mut ready = 0usize;
    let mut eas_by_factory: BTreeMap<Address, Address> = BTreeMap::new();

    for id in ids.iter() {
        let record_ret = rpc
            .eth_call(registry, getInstanceCall { instanceId: *id }.abi_encode())
            .await
            .with_context(|| format!("getInstance({id:#x}) failed"))?;
        let record =
            getInstanceCall::abi_decode_returns(&record_ret).context("decoding Instance record")?;

        if record.program != want_program {
            entries.push(skip_entry(
                id,
                &record,
                format!(
                    "program {:#x} is not keccak256(\"{}\") — a different SP1 program owns this instance",
                    record.program, args.program
                ),
            ));
            continue;
        }

        let Some((created_block, tx_hash)) = registered_in.get(id).copied() else {
            entries.push(skip_entry(
                id,
                &record,
                format!("no InstanceRegistered log at or after block {}", args.from_block),
            ));
            continue;
        };

        if args.program == "contributions" {
            let authority_ret = rpc
                .eth_call(registry, paramsAuthorityCall { instanceId: *id }.abi_encode())
                .await
                .with_context(|| format!("paramsAuthority({id:#x}) failed"))?;
            let controller = paramsAuthorityCall::abi_decode_returns(&authority_ret)
                .context("decoding contributions params authority")?;
            if controller == Address::ZERO {
                bail!("contributions instance {id:#x} has no typed params authority");
            }

            let controller_id = B256::from(instanceIdCall::abi_decode_returns(
                &rpc.eth_call(controller, instanceIdCall {}.abi_encode()).await?,
            )?);
            let controller_snapshot = snapshotCall::abi_decode_returns(
                &rpc.eth_call(controller, snapshotCall {}.abi_encode()).await?,
            )?;
            let eas = easCall::abi_decode_returns(
                &rpc.eth_call(controller, easCall {}.abi_encode()).await?,
            )?;
            let controller_hash = B256::from(currentParamsHashCall::abi_decode_returns(
                &rpc.eth_call(controller, currentParamsHashCall {}.abi_encode()).await?,
            )?);
            if controller_id != *id || controller_snapshot != record.snapshot {
                bail!(
                    "contributions controller {controller:#x} is bound to id {controller_id:#x} / \
                     snapshot {controller_snapshot:#x}, not registry id {id:#x} / snapshot {:#x}",
                    record.snapshot
                );
            }

            let live = B256::from(paramsHashCall::abi_decode_returns(
                &rpc.eth_call(record.snapshot, paramsHashCall {}.abi_encode())
                    .await
                    .with_context(|| format!("paramsHash() on snapshot {:#x}", record.snapshot))?,
            )?);
            if record.paramsHash != live || controller_hash != live {
                bail!(
                    "contributions instance {id:#x} commitment divergence: registry={:#x}, \
                     controller={controller_hash:#x}, snapshot={live:#x}",
                    record.paramsHash
                );
            }

            // Recover the tuple from chain history, keyed by the exact live commitment. This is
            // deliberately not just a getter read: old versions remain reproducible after a later
            // round rotates the controller.
            let param_logs = rpc
                .get_logs(
                    controller,
                    &[
                        Some(ContributionsParamsUpdated::SIGNATURE_HASH),
                        Some(*id),
                        None,
                        Some(live),
                    ],
                    created_block,
                    head,
                    args.chunk,
                )
                .await
                .with_context(|| format!("querying params history on {controller:#x}"))?;
            let selected_log = param_logs.last().ok_or_else(|| {
                anyhow!(
                    "contributions instance {id:#x}: controller has no full tuple event for live hash {live:#x}"
                )
            })?;
            let published = ContributionsParamsUpdated::decode_raw_log(
                selected_log.topics.iter().copied(),
                &selected_log.data,
            )
            .context("decoding ContributionsParamsUpdated")?;
            let params = to_contributions_params(&published.params);
            let computed = contributions_core::params::params_hash(&params);
            if computed != live {
                bail!(
                    "PARAMS HASH MISMATCH for contributions instance {id:#x}: \
                     params_hash(on-chain event tuple)={computed:#x}, live={live:#x}"
                );
            }

            // The getter is a convenience surface, while the event is the historical source. Both
            // must describe the same current tuple or the controller implementation is unsafe.
            let current_ret = rpc
                .eth_call(controller, getContributionsParamsCall {}.abi_encode())
                .await
                .context("getContributionsParams failed")?;
            let current = getContributionsParamsCall::abi_decode_returns(&current_ret)?;
            let getter_hash =
                contributions_core::params::params_hash(&to_contributions_params(&current));
            if getter_hash != live {
                bail!(
                    "contributions controller getter hash {getter_hash:#x} != published/live hash {live:#x}"
                );
            }

            let epoch_length =
                call_u64(&rpc, record.snapshot, epochLengthCall {}.abi_encode()).await?;
            let last_trigger =
                call_u64(&rpc, record.snapshot, lastTriggerBlockCall {}.abi_encode()).await?;
            let anchor_count =
                call_u64(&rpc, record.registryOrAccumulator, anchorCountCall {}.abi_encode())
                    .await?;
            let status = if epoch_length > 0 && next_block < last_trigger + epoch_length {
                Status::Skipped(format!(
                    "epoch boundary not reached — next trigger allowed at block {}",
                    last_trigger + epoch_length
                ))
            } else if anchor_count == 0 {
                Status::Skipped("no contribution records yet — nothing to prove".to_string())
            } else {
                Status::Ready
            };

            let inst_dir = out_root.join(format!("{id:#x}"));
            std::fs::create_dir_all(&inst_dir)
                .with_context(|| format!("create {}", inst_dir.display()))?;
            let params_path = inst_dir.join("params.json");
            std::fs::write(&params_path, serde_json::to_string_pretty(&params)?)
                .with_context(|| format!("write {}", params_path.display()))?;
            if matches!(status, Status::Ready) {
                ready += 1;
            }
            eprintln!(
                "  {:<8} {id:#x} contributions snapshot={:#x} records={anchor_count}{}",
                status.label(),
                record.snapshot,
                if status.reason().is_empty() {
                    String::new()
                } else {
                    format!("\n           └─ {}", status.reason())
                }
            );
            entries.push(json!({
                "instanceId": format!("{id:#x}"),
                "program": "contributions",
                "controller": format!("{controller:#x}"),
                "eas": format!("{eas:#x}"),
                "snapshot": format!("{:#x}", record.snapshot),
                "resolver": format!("{:#x}", record.registryOrAccumulator),
                "verifier": format!("{:#x}", record.verifier),
                "paramsHash": format!("{live:#x}"),
                "paramsVersion": published.version,
                "paramsPublishedBlock": selected_log.block_number,
                "epochLength": epoch_length,
                "lastTriggerBlock": last_trigger,
                "createdBlock": created_block,
                "inputFromBlock": args.from_block,
                "anchorCount": anchor_count,
                "paramsPath": params_path.display().to_string(),
                "outDir": inst_dir.display().to_string(),
                "status": status.label(),
                "reason": status.reason(),
            }));
            continue;
        }

        // --- 3. The creating transaction's InstanceCreated log: params + the factory address. ---
        let logs = rpc
            .transaction_receipt_logs(tx_hash)
            .await
            .with_context(|| format!("receipt for {tx_hash:#x}"))?;
        let created = logs.iter().find(|l| {
            l.topics.first() == Some(&InstanceCreated::SIGNATURE_HASH)
                && l.topics.get(1) == Some(id)
        });
        let Some(created_log) = created else {
            entries.push(skip_entry(
                id,
                &record,
                "registered without a factory InstanceCreated event — its params are not on chain, \
                 so they cannot be reconstructed"
                    .to_string(),
            ));
            continue;
        };
        let factory = created_log.address;
        let ev =
            InstanceCreated::decode_raw_log(created_log.topics.iter().copied(), &created_log.data)
                .context("decoding InstanceCreated")?;

        // The event must describe the instance the directory points at, or one of the two is lying
        // about this id. Nothing downstream is safe if they disagree.
        if ev.snapshot != record.snapshot || ev.resolver != record.registryOrAccumulator {
            bail!(
                "instance {id:#x}: InstanceCreated (snapshot {:#x}, resolver {:#x}) does not match \
                 the registry record (snapshot {:#x}, accumulator {:#x})",
                ev.snapshot,
                ev.resolver,
                record.snapshot,
                record.registryOrAccumulator
            );
        }

        let params = to_core_params(&ev.params);

        // The snapshot is authoritative for the optional lane address. The additive factory event
        // is the public discovery record and must agree for the strict two-domain profile.
        let anchor_registry_ret = rpc
            .eth_call(record.snapshot, anchorRegistryCall {}.abi_encode())
            .await
            .with_context(|| format!("anchorRegistry() on snapshot {:#x}", record.snapshot))?;
        let anchor_registry = anchorRegistryCall::abi_decode_returns(&anchor_registry_ret)
            .context("decoding anchorRegistry()")?;
        let lane_event = logs.iter().find(|log| {
            log.address == factory
                && log.topics.first() == Some(&OffchainEasLaneCreated::SIGNATURE_HASH)
                && log.topics.get(1) == Some(id)
        });
        let mut hybrid_registry_eas = None;
        if params.envelope0_domain_separators.len() == 2 {
            let lane_log = lane_event.ok_or_else(|| {
                anyhow!(
                    "strict hybrid instance {id:#x} has no factory OffchainEasLaneCreated discovery event"
                )
            })?;
            let lane = OffchainEasLaneCreated::decode_raw_log(
                lane_log.topics.iter().copied(),
                &lane_log.data,
            )
            .context("decoding OffchainEasLaneCreated")?;
            if anchor_registry == Address::ZERO || lane.registry != anchor_registry {
                bail!(
                    "strict hybrid discovery mismatch for {id:#x}: event registry={:#x}, snapshot registry={anchor_registry:#x}",
                    lane.registry
                );
            }

            let registry_eas_ret = rpc
                .eth_call(anchor_registry, EASCall {}.abi_encode())
                .await
                .context("reading strict registry EAS")?;
            let registry_eas = EASCall::abi_decode_returns(&registry_eas_ret)?;
            hybrid_registry_eas = Some(registry_eas);
            let registry_schema_ret = rpc
                .eth_call(anchor_registry, schemaUidCall {}.abi_encode())
                .await
                .context("reading strict registry schemaUid")?;
            let registry_schema = schemaUidCall::abi_decode_returns(&registry_schema_ret)?;
            let registry_snapshot_ret = rpc
                .eth_call(anchor_registry, snapshotCall {}.abi_encode())
                .await
                .context("reading strict registry snapshot")?;
            let registry_snapshot = snapshotCall::abi_decode_returns(&registry_snapshot_ret)?;
            let registry_cap_ret = rpc
                .eth_call(anchor_registry, maxTotalInputsCall {}.abi_encode())
                .await
                .context("reading strict registry maxTotalInputs")?;
            let registry_cap = maxTotalInputsCall::abi_decode_returns(&registry_cap_ret)?;
            let registry_eas_domain_ret = rpc
                .eth_call(anchor_registry, easDomainSeparatorCall {}.abi_encode())
                .await
                .context("reading strict registry EAS domain")?;
            let registry_eas_domain =
                easDomainSeparatorCall::abi_decode_returns(&registry_eas_domain_ret)?;
            let registry_head_domain_ret = rpc
                .eth_call(anchor_registry, headDomainSeparatorCall {}.abi_encode())
                .await
                .context("reading strict registry head domain")?;
            let registry_head_domain =
                headDomainSeparatorCall::abi_decode_returns(&registry_head_domain_ret)?;

            if lane.domainSeparator != params.envelope0_domain_separators[0]
                || registry_eas_domain != params.envelope0_domain_separators[0]
                || registry_head_domain != params.envelope0_domain_separators[1]
                || registry_schema != params.schema_uid
                || registry_schema != ev.schemaUid
                || registry_snapshot != record.snapshot
                || registry_cap == 0
                || registry_cap != lane.maxTotalInputs
            {
                bail!(
                    "strict hybrid provenance mismatch for {id:#x}: event EAS domain={:#x}, registry EAS domain={registry_eas_domain:#x}, registry head domain={registry_head_domain:#x}, registry schema={registry_schema:#x}, registry snapshot={registry_snapshot:#x}, registry cap={registry_cap}",
                    lane.domainSeparator
                );
            }
        } else if anchor_registry != Address::ZERO {
            bail!(
                "instance {id:#x} names lane registry {anchor_registry:#x} without the strict two-domain params profile"
            );
        }

        // --- 4. THE SELF-CHECK. ----------------------------------------------------------------
        let computed = B256::from(encode::params_hash(&params));
        let live_ret = rpc
            .eth_call(record.snapshot, paramsHashCall {}.abi_encode())
            .await
            .with_context(|| format!("paramsHash() on snapshot {:#x}", record.snapshot))?;
        let live = paramsHashCall::abi_decode_returns(&live_ret).context("decoding paramsHash")?;
        if computed != live {
            bail!(
                "PARAMS HASH MISMATCH for instance {id:#x} (\"{}\")\n  \
                 params_hash(InstanceCreated.params) = {computed:#x}\n  \
                 snapshot {:#x} paramsHash()        = {live:#x}\n\
                 Refusing to prove ANY instance: the event no longer describes what this snapshot is \
                 pinned to verify, so a proof built from it would be rejected on-chain — or, worse, \
                 be valid for a different instance (INSTANCE_FACTORY §6.1). Fix the divergence (a \
                 rotated paramsHash, a codec drift between ParamsCodec.sol and pagerank-core, or a \
                 tampered directory) before proving.",
                ev.name,
                record.snapshot
            );
        }
        // The directory copy is advisory — `update()` may legitimately lag a rotation — but a
        // divergence is worth saying out loud, since consumers read the registry, not the snapshot.
        if record.paramsHash != live {
            eprintln!(
                "  WARNING {id:#x}: registry paramsHash {:#x} != live snapshot paramsHash {live:#x}",
                record.paramsHash
            );
        }

        // --- 5. Everything else the loop needs, all read off the chain. ------------------------
        let eas = match eas_by_factory.get(&factory) {
            Some(a) => *a,
            None => {
                let ret = rpc
                    .eth_call(factory, EASCall {}.abi_encode())
                    .await
                    .with_context(|| format!("EAS() on factory {factory:#x}"))?;
                let a = EASCall::abi_decode_returns(&ret).context("decoding EAS()")?;
                eas_by_factory.insert(factory, a);
                a
            }
        };
        if let Some(registry_eas) = hybrid_registry_eas {
            if registry_eas != eas {
                bail!(
                    "strict hybrid EAS mismatch for {id:#x}: factory={eas:#x}, registry={registry_eas:#x}"
                );
            }
        }

        let epoch_length = call_u64(&rpc, record.snapshot, epochLengthCall {}.abi_encode()).await?;
        let last_trigger =
            call_u64(&rpc, record.snapshot, lastTriggerBlockCall {}.abi_encode()).await?;
        let acc = record.registryOrAccumulator;
        let leaf_count = call_u64(&rpc, acc, leafCountCall {}.abi_encode()).await?;
        let cp_count_ret = rpc.eth_call(acc, checkpointCountCall {}.abi_encode()).await?;
        let cp_count = checkpointCountCall::abi_decode_returns(&cp_count_ret)?;
        let checkpointed_leaves = if cp_count > U256::ZERO {
            let ret = rpc
                .eth_call(acc, getCheckpointCall { id: cp_count - U256::from(1) }.abi_encode())
                .await?;
            Checkpoint::abi_decode(&ret).context("decoding Checkpoint")?.leafCount
        } else {
            0
        };
        let anchor_work = if anchor_registry == Address::ZERO {
            0
        } else {
            call_u64(&rpc, anchor_registry, workCountCall {}.abi_encode()).await?
        };
        let checkpointed_anchor_work = if cp_count > U256::ZERO {
            call_u64(
                &rpc,
                record.snapshot,
                checkpointWorkCountCall { checkpointId: cp_count - U256::from(1) }.abi_encode(),
            )
            .await?
        } else {
            0
        };

        // --- 6. Readiness. Every not-ready case is a logged skip, never an abort. ---------------
        let status = if epoch_length > 0 && next_block < last_trigger + epoch_length {
            Status::Skipped(format!(
                "epoch boundary not reached — next trigger allowed at block {}, chain is at {head} \
                 ({} block(s) to go)",
                last_trigger + epoch_length,
                last_trigger + epoch_length - next_block
            ))
        } else if cp_count == U256::ZERO && leaf_count == 0 && anchor_work == 0 {
            Status::Skipped("neither input lane has entries yet — nothing to prove".to_string())
        } else if cp_count > U256::ZERO
            && leaf_count <= checkpointed_leaves
            && anchor_work <= checkpointed_anchor_work
        {
            Status::Skipped(format!(
                "no new inputs since checkpoint #{} (lane1 {leaf_count}/{checkpointed_leaves}, \
                 lane2 work {anchor_work}/{checkpointed_anchor_work}) — trigger() would revert NoNewInputs()",
                cp_count - U256::from(1)
            ))
        } else {
            Status::Ready
        };

        // Every reconstructed instance gets its params file, ready or not: it is the auditable
        // artifact of "what this community actually computes", and it costs nothing to write.
        let inst_dir = out_root.join(format!("{id:#x}"));
        std::fs::create_dir_all(&inst_dir)
            .with_context(|| format!("create {}", inst_dir.display()))?;
        let params_path = inst_dir.join("params.json");
        std::fs::write(&params_path, serde_json::to_string_pretty(&params)?)
            .with_context(|| format!("write {}", params_path.display()))?;

        if matches!(status, Status::Ready) {
            ready += 1;
        }
        eprintln!(
            "  {:<8} {id:#x} \"{}\"  snapshot={:#x} lane1={leaf_count} lane2Work={anchor_work}{}",
            status.label(),
            ev.name,
            record.snapshot,
            if status.reason().is_empty() {
                String::new()
            } else {
                format!("\n           └─ {}", status.reason())
            }
        );

        entries.push(json!({
            "instanceId": format!("{id:#x}"),
            "name": ev.name,
            "creator": format!("{:#x}", ev.creator),
            "admin": format!("{:#x}", ev.admin),
            "metadataURI": ev.metadataURI,
            "factory": format!("{factory:#x}"),
            "eas": format!("{eas:#x}"),
            "snapshot": format!("{:#x}", record.snapshot),
            "accumulator": format!("{acc:#x}"),
            "anchorRegistry": format!("{anchor_registry:#x}"),
            "verifier": format!("{:#x}", record.verifier),
            "distributor": format!("{:#x}", ev.distributor),
            "distributorToken": format!("{:#x}", ev.distributorToken),
            "schemaUid": format!("{:#x}", ev.schemaUid),
            "paramsHash": format!("{live:#x}"),
            "epochLength": epoch_length,
            "lastTriggerBlock": last_trigger,
            "createdBlock": created_block,
            "leafCount": leaf_count,
            "checkpointCount": cp_count.to::<u64>(),
            "checkpointedLeafCount": checkpointed_leaves,
            "anchorWork": anchor_work,
            "checkpointedAnchorWork": checkpointed_anchor_work,
            "paramsPath": params_path.display().to_string(),
            "outDir": inst_dir.display().to_string(),
            "status": status.label(),
            "reason": status.reason(),
        }));
    }

    let plan = json!({
        "chainId": chain_id,
        "blockNumber": head,
        "registry": format!("{registry:#x}"),
        "program": args.program,
        "programLabel": format!("{want_program:#x}"),
        "readyCount": ready,
        "instances": entries,
    });
    let plan_path = out_root.join("instances.json");
    std::fs::write(&plan_path, serde_json::to_string_pretty(&plan)?)
        .with_context(|| format!("write {}", plan_path.display()))?;
    eprintln!("{ready} instance(s) ready to prove — plan at {}", plan_path.display());

    println!("{}", serde_json::to_string_pretty(&plan)?);
    Ok(())
}

/// Repo root, resolved from this crate's manifest dir so default output paths are CWD-independent
/// (same convention as `input-exporter` and the prover host).
fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../..")
}

async fn call_u64(rpc: &Rpc, to: Address, data: Vec<u8>) -> Result<u64> {
    let ret = rpc.eth_call(to, data).await?;
    if ret.len() < 32 {
        return Err(anyhow!("short return from {to:#x}"));
    }
    Ok(U256::from_be_slice(&ret[..32]).to::<u64>())
}

/// A directory row we cannot (or should not) prove. It still appears in the plan so the run reports
/// on every registered instance rather than silently narrowing the set.
fn skip_entry(id: &B256, record: &Instance, reason: String) -> Value {
    eprintln!("  skipped  {id:#x}\n           └─ {reason}");
    json!({
        "instanceId": format!("{id:#x}"),
        "snapshot": format!("{:#x}", record.snapshot),
        "accumulator": format!("{:#x}", record.registryOrAccumulator),
        "program": format!("{:#x}", record.program),
        "paramsHash": format!("{:#x}", record.paramsHash),
        "status": "skipped",
        "reason": reason,
    })
}

/// `ParamsCodec.Params` (as emitted) → `pagerank_core::Params` (as the guest consumes). The field
/// order below is the frozen schema-v2 order; keep it aligned with `ParamsCodec.sol` and
/// `pagerank_core::encode::params_hash`.
fn to_core_params(p: &SolParams) -> Params {
    Params {
        damping_fp: p.dampingFp,
        tolerance_fp: p.toleranceFp,
        max_iterations: p.maxIterations,
        min_weight_fp: p.minWeightFp,
        max_weight_fp: p.maxWeightFp,
        trust_multiplier_fp: p.trustMultiplierFp,
        trust_share_fp: p.trustShareFp,
        trust_decay_fp: p.trustDecayFp,
        trusted_seeds: p.trustedSeeds.clone(),
        total_pool: p.totalPool,
        precision_scale: p.precisionScale,
        schema_uid: p.schemaUid,
        weight_field_index: p.weightFieldIndex,
        envelope0_domain_separators: p.envelope0DomainSeparators.clone(),
        lane2_max_head_age: p.lane2MaxHeadAge,
        accumulator: p.accumulator,
        chain_id: p.chainId,
    }
}

/// On-chain canonical contributions tuple → the exact Rust type consumed by the guest.
fn to_contributions_params(p: &SolContributionsParams) -> contributions_core::Params {
    contributions_core::Params {
        damping_fp: p.dampingFp,
        tolerance_fp: p.toleranceFp,
        max_iterations: p.maxIterations,
        min_weight_fp: p.minWeightFp,
        max_weight_fp: p.maxWeightFp,
        trust_multiplier_fp: p.trustMultiplierFp,
        trust_share_fp: p.trustShareFp,
        trust_decay_fp: p.trustDecayFp,
        trusted_seeds: p.trustedSeeds.clone(),
        precision_scale: p.precisionScale,
        weight_field_index: p.weightFieldIndex,
        round_start: p.roundStart,
        round_end: p.roundEnd,
        unaccepted_mult_fp: p.unacceptedMultFp,
        collaborator_mult_fp: p.collaboratorMultFp,
        min_rater_rep_fp: p.minRaterRepFp,
        evaluator_carveout_bps: p.evaluatorCarveoutBps,
        total_pool: p.totalPool,
        claim_schema_uid: p.claimSchemaUid,
        response_schema_uid: p.responseSchemaUid,
        valuation_schema_uid: p.valuationSchemaUid,
    }
}
