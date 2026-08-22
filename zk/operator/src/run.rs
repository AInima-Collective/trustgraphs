//! The tick loop.
//!
//! Read the chain, hand the facts to `operator_core::plan`, do what it says. There is no policy
//! here on purpose: if this file is making a judgement call, it belongs in `operator-core` where
//! CI can test it against a fake chain.

use alloy_primitives::{Address, B256, U256};
use anyhow::{bail, Context, Result};
use operator_core::catalog::{scan as catalog_scan, CatalogEntry, SkipCause};
use operator_core::decide::alerts;
use operator_core::finality::{Anchor, Finality};
use operator_core::journal::{Journal, Outcome, Record, Status, SubmitFailureClass, WorkKey};
use operator_core::plan;
use operator_core::types::{
    Action, AvailabilityStage, HoldReason, InFlight, InFlightState, InstanceSize, InstanceState,
    Program,
};
use serde_json::json;
use std::collections::{BTreeMap, BTreeSet};
use std::path::PathBuf;

use crate::chain::{
    entry_at_params_hash, expected_instance_domain, read_checkpoint, read_landed_publication,
    read_signer_view, read_snapshot, verifier_vkey, weighted_pending_entry, RegistryScan, Rpc,
    RpcCatalog,
};
use crate::config::Config;
use crate::handlers;
use crate::ops::{
    action_key, alert, write_status, InstanceStatus, Logger, Narration, PublicSettings,
    Status as OpsStatus,
};
use crate::tx::Sender;

/// What one proof of this instance is expected to cost us, in cents.
///
/// Crude on purpose, and crude in the safe direction: it prices the whole guest run at a flat
/// cents-per-billion-cycles, using the same cycle estimate that decides whether an instance is
/// provable at all. The budget it feeds exists to stop a runaway, not to bill anyone.
fn estimated_cost_cents(cfg: &Config, state: &InstanceState) -> u64 {
    let cycles = state.size.estimated_cycles(
        operator_core::policy::CYCLES_PER_INPUT,
        operator_core::policy::BASE_CYCLES,
    );
    // Round UP: a per-proof estimate that rounds to zero would make small instances free forever.
    cycles.saturating_mul(cfg.budget.cents_per_billion_cycles).div_ceil(1_000_000_000).max(1)
}

/// Programs this binary carries a guest for. Anything else is skipped rather than attempted.
fn supported() -> BTreeSet<Program> {
    BTreeSet::from([
        Program::Trustgraphs,
        Program::Contributions,
        Program::Weighted,
        Program::Composition,
        Program::NostrWorkspace,
        Program::Signer,
    ])
}

#[derive(Clone, Copy)]
struct PendingSettle {
    anchor: Anchor,
    confirmations: u64,
}

pub fn run(cfg: Config, once: bool, dry_run: bool) -> Result<()> {
    let logger = Logger { json: cfg.ops.log_format == "json" };
    let rpc = Rpc::new(cfg.rpc.clone());

    // ---- startup checks. Refuse to start rather than fail on the first submit. -------------
    let chain_id = rpc.eth_chain_id().context("eth_chainId")?;
    if let Some(want) = cfg.chain_id {
        if want != chain_id {
            bail!("config names chain {want} but {} is chain {chain_id}", cfg.rpc);
        }
    }

    let sender = if dry_run {
        None
    } else {
        let s = Sender::from_env(
            "SUBMITTER_PRIVATE_KEY",
            chain_id,
            (cfg.gas.priority_fee_gwei * 1e9) as u128,
        )?;
        let balance = rpc.balance(s.address())?;
        logger.event(
            "startup",
            json!({ "submitter": s.address(), "balance_wei": balance.to_string(), "chain_id": chain_id }),
        );
        if balance == 0 {
            alert(
                &logger,
                cfg.ops.alert_webhook.as_deref(),
                "submitter key has a zero balance; every send will fail",
            );
        }
        Some(s)
    };

    // The prover backend is set once, here, so a config file and an environment variable cannot
    // disagree about which one is in use.
    std::env::set_var("SP1_PROVER", &cfg.prover.backend);

    // Every instance's deployed verifier must be pinned to a vkey this binary's guest can
    // satisfy. Discovering otherwise on a failed submit costs a proof; discovering it here costs
    // one `eth_call`. A mismatch is a per-instance skip, not a refusal to start: one community
    // that rotated ahead of us must not stop the rest.
    let vkeys = guest_vkeys()?;
    logger.event(
        "vkeys",
        json!(vkeys.iter().map(|(p, k)| (p.name(), format!("{k:#x}"))).collect::<Vec<_>>()),
    );

    // A registry scan from genesis is the difference between a daemon that works on mainnet and
    // one that never gets a catalog at all (most providers reject the range as an archive
    // request). Say it once, loudly, at startup.
    if cfg.registry_from_block == 0 && chain_id != 31_337 {
        alert(
            &logger,
            cfg.ops.alert_webhook.as_deref(),
            &format!(
                "registry_from_block is 0 on chain {chain_id}: the InstanceRegistered scan will \
                 start at genesis. Set it to the registry's deployment block — many providers \
                 reject that range outright and the daemon then has no catalog at all."
            ),
        );
    }

    // Registrations are append-only and a scanned block never changes its logs, so the history is
    // built once and extended. Previously this was rebuilt from `from_block` once per program per
    // tick: three identical full scans a minute, for a list that grows by a row a week.
    let mut scan = RegistryScan::default();

    // M-9 (2026-08-13 audit): reorg detection needs a memory. `seen_anchors` records the block
    // hash each checkpoint was FIRST observed at, so a later tick can compare the canonical
    // chain against that observation instead of against itself. `pending_settles` holds
    // successful submits until their block has N confirmations — only then is `Settled{Landed}`
    // journaled, so a reorged-out submit re-plans (the proof is still held) instead of wedging
    // the journal behind manual surgery. Both are per-run: a restart re-reads the live chain,
    // which is a fresh observation.
    let mut seen_anchors: BTreeMap<(B256, u64), Anchor> = BTreeMap::new();
    let mut pending_settles: BTreeMap<WorkKey, PendingSettle> = BTreeMap::new();

    // The log narrates changes; the heartbeat file carries steady state. This remembers what has
    // already been said so a healthy tick is one line, not one line per instance per lane.
    let mut narration = Narration::default();

    let mut journal = Journal::open(PathBuf::from(&cfg.ops.journal_path))?;
    let unresolved = journal.unresolved();
    if !unresolved.is_empty() {
        alert(
            &logger,
            cfg.ops.alert_webhook.as_deref(),
            &format!(
                "{} proof request(s) with an unknown outcome are waiting on a human. They are \
                 NEVER auto-retried; resolve them with an operator `Resolved` record.",
                unresolved.len()
            ),
        );
    }

    loop {
        match tick(
            &cfg,
            &rpc,
            chain_id,
            sender.as_ref(),
            &mut journal,
            &mut scan,
            &mut seen_anchors,
            &mut pending_settles,
            &mut narration,
            &logger,
            dry_run,
        ) {
            Ok(()) => {}
            Err(e) => {
                // A failed tick is not a failed daemon: the next one re-reads everything from
                // chain. The contracts are the database; there is no local state to corrupt.
                logger.event("tick_failed", json!({ "error": e.to_string() }));
                alert(&logger, cfg.ops.alert_webhook.as_deref(), &format!("tick failed: {e}"));
            }
        }
        if once {
            return Ok(());
        }
        std::thread::sleep(std::time::Duration::from_secs(cfg.cadence.tick_seconds));
    }
}

/// Reconstruct and republish the canonical score blob for an already-landed checkpoint.
///
/// This path needs no submitter or prover credentials. Chain history supplies the checkpoint,
/// landed root, recipient, CID and (for rotated factory instances) the complete historical params
/// tuple. Publication uses the same multi-target policy and durable journal as the daemon.
pub fn republish(cfg: Config, instance_id: B256, checkpoint_id: u64) -> Result<()> {
    anyhow::ensure!(
        cfg.ipfs.required_successes() > 0,
        "republish needs at least one configured [ipfs] target"
    );
    let logger = Logger { json: cfg.ops.log_format == "json" };
    let rpc = Rpc::new(cfg.rpc.clone());
    let chain_id = rpc.eth_chain_id().context("eth_chainId")?;
    if let Some(expected) = cfg.chain_id {
        anyhow::ensure!(
            expected == chain_id,
            "config names chain {expected} but {} is chain {chain_id}",
            cfg.rpc
        );
    }
    let head = rpc.block_number()?;
    let mut scan = RegistryScan::default();
    scan.refresh(&rpc, cfg.registry, cfg.registry_from_block, head)?;
    let manifest = cfg.manifest_struct();
    let reader = RpcCatalog::new(&rpc, cfg.registry, &scan);
    let mut found = None;
    let mut diagnosis = None;
    for program in supported() {
        let catalog = catalog_scan(&reader, program, &manifest)?;
        if let Some(entry) = catalog.get(instance_id) {
            found = Some(entry.clone());
            break;
        }
        if let Some(skipped) = catalog.skipped.iter().find(|row| row.instance_id == instance_id) {
            diagnosis = Some(skipped.reason.to_string());
        }
    }
    let entry = found.ok_or_else(|| {
        anyhow::anyhow!(
            "instance {instance_id:#x} is not repairable from this catalog{}",
            diagnosis.map_or_else(String::new, |reason| format!(": {reason}"))
        )
    })?;

    let checkpoint = read_checkpoint(&rpc, entry.snapshot, checkpoint_id)?;
    let pinned_params = checkpoint.pinned_params_hash.ok_or_else(|| {
        anyhow::anyhow!(
            "checkpoint {checkpoint_id} has no pinned params hash and cannot be reconstructed safely"
        )
    })?;
    let historical = entry_at_params_hash(&rpc, &entry, pinned_params, head)?;
    let landed = read_landed_publication(
        &rpc,
        entry.snapshot,
        checkpoint_id,
        checkpoint.block_number,
        entry.created_block,
        head,
    )?;
    let built = handlers::build_input(&cfg, &rpc, &historical, checkpoint_id, landed.recipient)?;
    anyhow::ensure!(
        built.output_root == landed.output_root
            && built.ipfs_hash == landed.ipfs_hash
            && built.cid == landed.cid
            && built.total_value == landed.total_value,
        "reconstructed checkpoint does not match landed state: root {:#x}/{:#x}, hash {:#x}/{:#x}, CID {}/{}, total {}/{}",
        built.output_root,
        landed.output_root,
        built.ipfs_hash,
        landed.ipfs_hash,
        built.cid,
        landed.cid,
        built.total_value,
        landed.total_value
    );

    logger.event(
        "republish_verified",
        json!({
            "instance": format!("{instance_id:#x}"),
            "checkpoint": checkpoint_id,
            "checkpoint_block": checkpoint.block_number,
            "submitted_block": landed.submitted_block,
            "params_hash": format!("{pinned_params:#x}"),
            "cid": built.cid,
        }),
    );
    let mut journal = Journal::open(PathBuf::from(&cfg.ops.journal_path))?;
    let key = WorkKey { chain_id, instance_id, checkpoint_id };
    if !attempt_publication(&cfg, &mut journal, &logger, &historical, key, &built.cid, &built.blob)?
    {
        bail!(
            "republish did not meet the configured publication minimum; failure is journaled for retry"
        );
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn tick(
    cfg: &Config,
    rpc: &Rpc,
    chain_id: u64,
    sender: Option<&Sender>,
    journal: &mut Journal,
    scan: &mut RegistryScan,
    seen_anchors: &mut BTreeMap<(B256, u64), Anchor>,
    pending_settles: &mut BTreeMap<WorkKey, PendingSettle>,
    narration: &mut Narration,
    logger: &Logger,
    dry_run: bool,
) -> Result<()> {
    let head = rpc.block_number()?;
    let basefee = rpc.basefee()?;
    let manifest = cfg.manifest_struct();

    // M-9: judge each unconfirmed submit against the canonical chain. Final → journal
    // `Settled{Landed}` now (and only now). Reorged → drop it, alert, and let `plan` re-submit
    // the held proof. Pending → keep waiting.
    let mut resolved: Vec<WorkKey> = Vec::new();
    for (key, pending) in pending_settles.iter() {
        let anchor = pending.anchor;
        let live = rpc.block_hash(anchor.block_number).ok().flatten();
        match anchor.finality(head, pending.confirmations, live) {
            Finality::Final => {
                journal.append(Record::Settled {
                    key: *key,
                    outcome: Outcome::Landed,
                    at: now(),
                })?;
                logger.event(
                    "submit_confirmed",
                    json!({
                        "instance": format!("{:#x}", key.instance_id),
                        "checkpoint": key.checkpoint_id,
                        "block": anchor.block_number,
                        "confirmations": pending.confirmations,
                    }),
                );
                resolved.push(*key);
            }
            Finality::Reorged { expected, canonical } => {
                let text = format!(
                    "submit for checkpoint {} of {:#x} was REORGED OUT (block {} was {expected:#x}, \
                     chain now has {canonical:#x}); the held proof will be resubmitted",
                    key.checkpoint_id, key.instance_id, anchor.block_number
                );
                logger.event("submit_reorged", json!({ "detail": text }));
                alert(logger, cfg.ops.alert_webhook.as_deref(), &text);
                resolved.push(*key);
            }
            Finality::Pending { .. } => {}
        }
    }
    for key in resolved {
        pending_settles.remove(&key);
    }

    // Once per tick, not once per program.
    scan.refresh(rpc, cfg.registry, cfg.registry_from_block, head)?;
    let reader = RpcCatalog::new(rpc, cfg.registry, scan);

    let mut statuses = Vec::new();
    let mut alerts_raised = Vec::new();
    let mut in_flight_now = 0usize;
    let vkeys = guest_vkeys()?;
    let programs = supported()
        .into_iter()
        .filter(|program| *program != Program::Signer || cfg.signer_sync.enabled)
        .collect::<Vec<_>>();
    let catalogs = programs
        .iter()
        .copied()
        .map(|program| catalog_scan(&reader, program, &manifest).map(|catalog| (program, catalog)))
        .collect::<Result<Vec<_>, _>>()?;
    let signer_instance_ids = catalogs
        .iter()
        .filter(|(program, _)| *program == Program::Signer)
        .flat_map(|(_, catalog)| catalog.entries.iter().map(|entry| entry.instance_id))
        .collect::<BTreeSet<_>>();
    let root_instance_ids = catalogs
        .iter()
        .filter(|(program, _)| *program != Program::Signer)
        .flat_map(|(_, catalog)| catalog.entries.iter().map(|entry| entry.instance_id))
        .collect::<BTreeSet<_>>();

    // Ids some lane recognizes as its own: an entry, or a skip with a substantive cause (the
    // deeper checks only run once the program matches). A cross-lane `OtherProgram` skip for a
    // recognized id is routing, not an anomaly — every instance is expected to be "another
    // program's" in every lane but its own.
    let recognized = catalogs
        .iter()
        .flat_map(|(_, catalog)| {
            catalog.entries.iter().map(|entry| entry.instance_id).chain(
                catalog
                    .skipped
                    .iter()
                    .filter(|s| !matches!(s.reason, SkipCause::OtherProgram(_)))
                    .map(|s| s.instance_id),
            )
        })
        .collect::<BTreeSet<_>>();
    let mut skipped_now: BTreeSet<B256> = BTreeSet::new();

    for (program, catalog) in &catalogs {
        // Say what was skipped — when it changes, not once per lane per tick. A silently shorter
        // list is indistinguishable from a healthy one, but the same skip re-announced every tick
        // buries the line that matters; the heartbeat file carries the steady state.
        for s in &catalog.skipped {
            let lane_key = format!("skip/{}/{:#x}", program.name(), s.instance_id);
            let unclaimed_key = format!("skip/unclaimed/{:#x}", s.instance_id);
            if let SkipCause::OtherProgram(owner) = &s.reason {
                if recognized.contains(&s.instance_id) {
                    // Routing. Its own lane tells this instance's story; end any old one here.
                    narration.clear(&lane_key);
                    continue;
                }
                // No lane claims it (an unknown program id, or its lane is disabled). One line,
                // lane-less: every lane says this at once and naming one would be arbitrary.
                skipped_now.insert(s.instance_id);
                let reason = format!(
                    "no supported program claims this instance (registered program {owner:#x})"
                );
                if narration.changed(&unclaimed_key, &reason) {
                    logger.event(
                        "instance_skipped",
                        json!({
                            "instance": format!("{:#x}", s.instance_id),
                            "program": serde_json::Value::Null,
                            "reason": reason,
                        }),
                    );
                }
                continue;
            }
            skipped_now.insert(s.instance_id);
            narration.clear(&unclaimed_key);
            let reason = s.reason.to_string();
            if narration.changed(&lane_key, &reason) {
                logger.event(
                    "instance_skipped",
                    json!({
                        "instance": format!("{:#x}", s.instance_id),
                        "program": program.name(),
                        "reason": reason.clone(),
                    }),
                );
            }
            if matches!(&s.reason, SkipCause::ControllerInconsistent(_)) {
                let text = format!(
                    "parameter-control bypass/inconsistency for {:#x} ({}): {}",
                    s.instance_id,
                    program.name(),
                    reason
                );
                alert(logger, cfg.ops.alert_webhook.as_deref(), &text);
                alerts_raised.push(text);
            }
        }

        for entry in &catalog.entries {
            // A lane that lists the instance ends any skip story about it. Log the recovery so
            // the earlier `instance_skipped` line has a closing bracket.
            let was_skipped =
                narration.clear(&format!("skip/{}/{:#x}", program.name(), entry.instance_id));
            let was_unclaimed =
                narration.clear(&format!("skip/unclaimed/{:#x}", entry.instance_id));
            if was_skipped || was_unclaimed {
                logger.event(
                    "instance_recovered",
                    json!({
                        "instance": format!("{:#x}", entry.instance_id),
                        "name": entry.name,
                        "program": program.name(),
                    }),
                );
            }

            // Weighted prior bytes are checkpoint-critical data. Keep the active version warm on
            // every tick and prefetch a pending proposal before its timelock can activate. A
            // failure is loud but per-instance; proving still re-runs the same fail-closed
            // recovery, so no substitute data can slip through after this advisory pass.
            if *program == Program::Weighted {
                let mut warm = vec![("active", entry.clone())];
                match weighted_pending_entry(rpc, entry) {
                    Ok(Some(pending)) => warm.push(("pending", pending)),
                    Ok(None) => {}
                    Err(error) => {
                        let text =
                            format!("{}: pending prior discovery failed: {error}", entry.name);
                        alert(logger, cfg.ops.alert_webhook.as_deref(), &text);
                        alerts_raised.push(text);
                    }
                }
                for (status, version) in warm {
                    match crate::weighted::recover_for_entry(cfg, rpc, &version) {
                        Ok(recovered) => {
                            let degraded = crate::weighted::degraded_source_count(&recovered);
                            // The keep-warm runs every tick; the same pin re-confirmed is not
                            // news. A new version, source, or degradation is.
                            if narration.changed(
                                &format!("weighted/{:#x}/{status}", entry.instance_id),
                                &format!(
                                    "{:?}/{}/{}/{degraded}",
                                    version.params_version,
                                    recovered.source,
                                    recovered.bytes.len()
                                ),
                            ) {
                                logger.event(
                                    "weighted_manifest_pinned",
                                    json!({
                                        "instance": format!("{:#x}", entry.instance_id),
                                        "version": version.params_version,
                                        "status": status,
                                        "bytes": recovered.bytes.len(),
                                        "source": recovered.source.to_string(),
                                        "degraded_sources": degraded,
                                    }),
                                );
                            }
                            if degraded > 0 {
                                let text = format!(
                                    "{}: {status} weighted manifest recovered from {} but {} earlier source(s) are degraded; retry interval {}s",
                                    entry.name,
                                    recovered.source,
                                    degraded,
                                    cfg.weighted_manifests.retry_seconds
                                );
                                alert(logger, cfg.ops.alert_webhook.as_deref(), &text);
                                alerts_raised.push(text);
                            }
                        }
                        Err(error) => {
                            let text = format!(
                                "{}: {status} weighted manifest unavailable; proving is disabled until recovery succeeds: {error}",
                                entry.name
                            );
                            alert(logger, cfg.ops.alert_webhook.as_deref(), &text);
                            alerts_raised.push(text);
                        }
                    }
                }
            }

            // The vkey check, per instance. `expected_zk_verifier` in the state is what makes
            // `plan` produce a `VerifierRotated` hold, so it has to reflect reality rather than
            // being copied from the chain read.
            let ours = vkeys.get(program).copied();
            let state = match build_state(
                rpc,
                cfg,
                chain_id,
                *program,
                entry,
                head,
                basefee,
                journal,
                ours,
                seen_anchors,
            ) {
                Ok(s) => s,
                Err(e) => {
                    logger.event(
                        "instance_unreadable",
                        json!({ "instance": format!("{:#x}", entry.instance_id), "error": e.to_string() }),
                    );
                    continue;
                }
            };

            // Monotonic inputs cannot be trimmed. A bounded AnchorRegistry publishes the lower
            // instance-selected ingress capacity; other lanes use MAX_PRICED_INPUTS. Approaching
            // either cliff must be loud while a replacement-snapshot migration is still orderly.
            let inputs = state.live_input_work;
            let ceiling = state.input_capacity.max(1).min(operator_core::policy::MAX_PRICED_INPUTS);
            if *program != Program::Composition && inputs >= ceiling.saturating_mul(8) / 10 {
                let text = format!(
                    "{} ({}): {inputs} of {ceiling} admitted inputs ({}%) — inputs cannot be \
                     trimmed. Revoke unexpected ingress authority and plan the constitutional \
                     replacement-snapshot migration before capacity is exhausted \
                     (docs/build/production.md, 'The accumulator ceiling').",
                    entry.name,
                    program.name(),
                    inputs.saturating_mul(100) / ceiling
                );
                logger.event(
                    "input_ceiling_approaching",
                    json!({
                        "instance": format!("{:#x}", entry.instance_id),
                        "inputs": inputs,
                        "ceiling": ceiling,
                    }),
                );
                alert(logger, cfg.ops.alert_webhook.as_deref(), &text);
                alerts_raised.push(text);
            }

            let policy = cfg.policy_for(entry.instance_id, *program, supported());
            // Rolling spend, from the journal. This is what makes `LossBudget` reachable at all:
            // it was `Spend::default()` here, so the budget could never fire and "unpreventable
            // spend is budgeted" was a property of the library rather than of the daemon.
            let spend = if *program == Program::Signer {
                journal.spend_scoped(
                    entry.instance_id,
                    now(),
                    cfg.budget_window_for(*program),
                    Some(&signer_instance_ids),
                )
            } else {
                journal.spend_scoped(
                    entry.instance_id,
                    now(),
                    cfg.budget_window_for(*program),
                    Some(&root_instance_ids),
                )
            };
            let mut action = plan(&state, &policy, spend);
            let mut prepared_input = None;
            let mut envelope0_preflight = None;
            match action {
                Action::Trigger => match handlers::preflight_live_envelope0(cfg, rpc, entry) {
                    Ok(report) => envelope0_preflight = report,
                    Err(_) => {
                        logger.event(
                            "envelope0_unavailable",
                            json!({
                                "instance": format!("{:#x}", entry.instance_id),
                                "stage": "live_pretrigger",
                            }),
                        );
                        action = Action::Hold(HoldReason::InputUnavailable {
                            stage: AvailabilityStage::LivePretrigger,
                            checkpoint_id: None,
                        });
                    }
                },
                Action::Prove { checkpoint_id }
                    if entry.program == Program::Trustgraphs
                        && handlers::uses_strict_envelope0(rpc, entry).unwrap_or(true) =>
                {
                    let pinned = state
                        .checkpoints
                        .iter()
                        .find(|checkpoint| checkpoint.id == checkpoint_id)
                        .and_then(|checkpoint| checkpoint.pinned_params_hash);
                    let build = pinned
                        .ok_or_else(|| anyhow::anyhow!("checkpoint has no pinned params"))
                        .and_then(|hash| entry_at_params_hash(rpc, entry, hash, state.head_block))
                        .and_then(|proving_entry| {
                            handlers::build_input(
                                cfg,
                                rpc,
                                &proving_entry,
                                checkpoint_id,
                                cfg.recipient(),
                            )
                        });
                    match build {
                        Ok(built) => prepared_input = Some(built),
                        Err(_) => {
                            logger.event(
                                "envelope0_unavailable",
                                json!({
                                    "instance": format!("{:#x}", entry.instance_id),
                                    "stage": "checkpoint_reconstruction",
                                    "checkpoint": checkpoint_id,
                                }),
                            );
                            action = Action::Hold(HoldReason::InputUnavailable {
                                stage: AvailabilityStage::CheckpointReconstruction,
                                checkpoint_id: Some(checkpoint_id),
                            });
                        }
                    }
                }
                _ => {}
            }
            // Log the decision when the instance's STATE changes (see `action_key`), not every
            // tick: `idle/quiet` repeated forever is what the heartbeat file is for, and a
            // rising confirmation count is progress inside one state, not a new one.
            if narration
                .changed(&format!("decision/{:#x}", entry.instance_id), &action_key(&action))
            {
                logger.action(
                    &format!("{:#x}", entry.instance_id),
                    &entry.name,
                    program.name(),
                    &action,
                );
            }

            if matches!(action, Action::Idle(operator_core::types::IdleReason::Proving { .. })) {
                in_flight_now += 1;
            }
            if alerts(&action) {
                let text = format!(
                    "{} ({}): {}",
                    entry.name,
                    program.name(),
                    serde_json::to_string(&action).unwrap_or_default()
                );
                alert(logger, cfg.ops.alert_webhook.as_deref(), &text);
                alerts_raised.push(text);
            }

            if !dry_run && in_flight_now <= cfg.cadence.max_concurrent {
                if let Err(e) = act(
                    cfg,
                    rpc,
                    chain_id,
                    sender,
                    journal,
                    pending_settles,
                    logger,
                    entry,
                    &state,
                    &action,
                    prepared_input.as_ref(),
                ) {
                    logger.event(
                        "action_failed",
                        json!({
                            "instance": format!("{:#x}", entry.instance_id),
                            "action": serde_json::to_value(&action).unwrap_or(json!(null)),
                            "error": e.to_string(),
                        }),
                    );
                    alert(
                        logger,
                        cfg.ops.alert_webhook.as_deref(),
                        &format!("{}: {e}", entry.name),
                    );
                }
            }

            let blocks_since_root = state
                .last_applied_checkpoint
                .and_then(|id| state.checkpoints.iter().find(|c| c.id == id))
                .map(|c| head.saturating_sub(c.block_number));
            let input_unavailable = matches!(
                &action,
                Action::Hold(HoldReason::InputUnavailable { .. })
            );
            let unprovable_age_blocks = match &action {
                Action::Hold(HoldReason::InputUnavailable {
                    checkpoint_id: Some(checkpoint_id),
                    ..
                }) => state
                    .checkpoints
                    .iter()
                    .find(|checkpoint| checkpoint.id == *checkpoint_id)
                    .map(|checkpoint| head.saturating_sub(checkpoint.block_number)),
                _ => None,
            };
            statuses.push(InstanceStatus {
                instance_id: format!("{:#x}", entry.instance_id),
                name: entry.name.clone(),
                program: program.name().to_string(),
                snapshot: format!("{:#x}", entry.snapshot),
                curated: policy.curated,
                action,
                blocks_since_root,
                newest_anchor_count: state.live_commitments.anchor_count,
                input_work: state.live_input_work,
                input_capacity: state.input_capacity,
                envelope0_fetch_latency_ms: envelope0_preflight
                    .as_ref()
                    .map(|report| report.fetch_latency_ms),
                envelope0_exact_readers: envelope0_preflight
                    .as_ref()
                    .map(|report| report.exact_readers),
                envelope0_validation_failed: input_unavailable,
                unprovable_age_blocks,
            });
        }
    }

    // One line per tick, always. Now that steady state is change-logged, this is the log's
    // liveness pulse: a quiet healthy daemon prints exactly this and nothing else.
    logger.event(
        "tick",
        json!({
            "head": head,
            "instances": statuses.len(),
            "idle": statuses.iter().filter(|s| matches!(s.action, Action::Idle(_))).count(),
            "proving": in_flight_now,
            "skipped": skipped_now.len(),
            "alerts": alerts_raised.len(),
        }),
    );

    write_status(
        &PathBuf::from(&cfg.ops.status_path),
        &OpsStatus {
            chain_id,
            head_block: head,
            tick_at: std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_secs())
                .unwrap_or(0),
            instances: statuses,
            settings: PublicSettings {
                paid_enabled: cfg.paid.enabled,
                paid_vault: cfg.paid.vault.map(|v| format!("{v:#x}")),
                paid_recipient: cfg.paid.recipient.map(|r| format!("{r:#x}")),
                tick_seconds: cfg.cadence.tick_seconds,
                subsidy_min_blocks: cfg.cadence.subsidy_min_blocks,
                max_concurrent: cfg.cadence.max_concurrent,
                max_per_instance: cfg.cadence.max_per_instance,
                max_basefee_gwei: cfg.gas.max_basefee_gwei,
                replacement_after_s: cfg.gas.replacement_after_s,
                simulate_before_send: cfg.gas.simulate_before_send,
                confirmations: cfg.finality.confirmations,
                track_block_hash: cfg.finality.track_block_hash,
                prover_backend: cfg.prover.backend.clone(),
                groth16: cfg.prover.groth16,
                proof_timeout_s: cfg.prover.timeout_s,
                per_instance_usd_per_day: cfg.budget.per_instance_usd_per_day,
                global_usd_per_day: cfg.budget.global_usd_per_day,
                budget_window_seconds: cfg.budget.window_seconds,
                publishes_scores: !cfg.ipfs.resolved_targets().is_empty(),
                verifies_score_readback: !cfg.ipfs.resolved_targets().is_empty(),
                publication_target_count: cfg.ipfs.resolved_targets().len(),
                publication_min_success: cfg.ipfs.required_successes(),
                publication_retry_seconds: cfg.ipfs.retry_seconds,
                weighted_manifest_mirror_count: cfg.weighted_manifests.mirrors.len(),
                weighted_manifest_cache_max_versions: cfg.weighted_manifests.max_versions,
                weighted_manifest_cache_max_bytes: cfg.weighted_manifests.max_bytes,
                weighted_manifest_retry_seconds: cfg.weighted_manifests.retry_seconds,
                submit_failure_threshold: cfg.ops.submit_failure_threshold,
                signer_sync_enabled: cfg.signer_sync.enabled,
                signer_confirmations: cfg.signer_sync.confirmations,
                signer_track_block_hash: cfg.signer_sync.track_block_hash,
                signer_per_instance_usd_per_day: cfg.signer_sync.per_instance_usd_per_day,
                signer_global_usd_per_day: cfg.signer_sync.global_usd_per_day,
                signer_budget_window_seconds: cfg.signer_sync.budget_window_seconds,
            },
            unresolved: journal.unresolved().iter().map(|k| format!("{k:?}")).collect(),
            alerts: alerts_raised,
        },
    )?;
    Ok(())
}

/// Assemble the facts `plan` needs. Every field is a chain read or a journal read; nothing here
/// decides anything.
#[allow(clippy::too_many_arguments)]
fn build_state(
    rpc: &Rpc,
    cfg: &Config,
    chain_id: u64,
    program: Program,
    entry: &CatalogEntry,
    head: u64,
    basefee: u128,
    journal: &mut Journal,
    our_vkey: Option<B256>,
    seen_anchors: &mut BTreeMap<(B256, u64), Anchor>,
) -> Result<InstanceState> {
    let (view, module_paused) = if program == Program::Signer {
        read_signer_view(rpc, entry, chain_id)?
    } else {
        (read_snapshot(rpc, entry.snapshot)?, false)
    };

    // The domain the contract will rebuild, checked against our own derivation. A mismatch means
    // this binary and the chain disagree about what `instanceDomain` is, which would waste every
    // proof it produced.
    let expected = expected_instance_domain(entry.submit_to, chain_id);
    if view.instance_domain != expected {
        bail!(
            "snapshot {:#x} reports instanceDomain {:#x}, we derive {expected:#x}",
            entry.snapshot,
            view.instance_domain
        );
    }

    // Reorg safety. `plan` does the depth arithmetic; what it cannot do is notice that the block
    // it counted from was replaced. An equal-depth reorg leaves the NUMBER intact and swaps the
    // contents, so a confirmations-only check would call a vanished checkpoint final.
    //
    // M-9 (2026-08-13 audit): the anchor hash must be the one recorded when the checkpoint was
    // FIRST observed — the pre-fix code built the anchor from the live hash and then compared it
    // to itself, so `Reorged` could never fire. `seen_anchors` is that first observation.
    let mut checkpoints = view.checkpoints.clone();
    if cfg.tracks_block_hash_for(program) {
        for c in &mut checkpoints {
            let live = rpc.block_hash(c.block_number)?;
            let anchor = *seen_anchors.entry((entry.instance_id, c.id)).or_insert(Anchor {
                block_number: c.block_number,
                block_hash: live.unwrap_or(B256::ZERO),
            });
            // A checkpoint that moved to a different block, or whose observed block hash no
            // longer matches the canonical chain, was reorged.
            let reorged = anchor.block_number != c.block_number
                || matches!(
                    anchor.finality(head, cfg.finality.confirmations, live),
                    Finality::Reorged { .. }
                );
            if reorged {
                // The block we would prove against no longer exists. Drop the checkpoint from
                // this tick's view rather than spending on it, and forget the stale observation
                // so the next tick re-anchors against the new canonical block.
                c.pinned_params_hash = None;
                seen_anchors.remove(&(entry.instance_id, c.id));
            }
        }
    }

    // Parameter rotations are recoverable from typed controller history. The planner compares a
    // frozen checkpoint with the tuple we can actually reconstruct, so use that historical tuple
    // here rather than making a paid, already-pinned checkpoint look permanently mismatched.
    let proving_checkpoint = checkpoints
        .iter()
        .filter(|checkpoint| view.last_applied.is_none_or(|last| checkpoint.id > last))
        .max_by_key(|checkpoint| checkpoint.id);
    let proving_entry = proving_checkpoint
        .and_then(|checkpoint| checkpoint.pinned_params_hash)
        .map(|pinned| entry_at_params_hash(rpc, entry, pinned, head))
        .transpose()?
        .unwrap_or_else(|| entry.clone());
    let reconstructed_params_hash = proving_entry.reconstructed_params_hash;
    let proof_leaf_count = proving_checkpoint
        .map_or(view.live.leaf_count, |checkpoint| checkpoint.commitments.leaf_count);
    let proof_anchor_work =
        proving_checkpoint.map_or(view.live_anchor_work, |checkpoint| checkpoint.work_count);
    let live_input_work = view.live.leaf_count.saturating_add(view.live_anchor_work);

    // In-flight work, from the journal rather than from memory: a restart must re-attach rather
    // than pay again.
    let newest = checkpoints
        .iter()
        .filter(|c| view.last_applied.is_none_or(|last| c.id > last))
        .map(|c| c.id)
        .max();
    let authenticated_cycles = if program == Program::Composition {
        let should_recover = newest.is_none_or(|id| {
            let key = WorkKey { chain_id, instance_id: entry.instance_id, checkpoint_id: id };
            matches!(journal.status(&key), Status::Untouched)
        });
        if should_recover {
            let checkpoint = newest;
            if let Some(retry) =
                journal.composition_availability_retry(chain_id, entry.instance_id, checkpoint)
            {
                let retry_at = retry.last_at.saturating_add(cfg.ipfs.retry_seconds);
                if now() < retry_at {
                    bail!(
                        "composition source recovery is in durable backoff until {retry_at}: {}",
                        retry.error
                    );
                }
            }
            match crate::composition::prepare(cfg, rpc, &proving_entry, checkpoint, cfg.recipient())
            {
                Ok(prepared) => Some(prepared.work.measured_cycles),
                Err(error) => {
                    journal.append(Record::CompositionAvailabilityAttempt {
                        chain_id,
                        instance_id: entry.instance_id,
                        checkpoint_id: checkpoint,
                        error: error.to_string(),
                        at: now(),
                    })?;
                    return Err(error)
                        .context("composition source availability/validation preflight");
                }
            }
        } else {
            // Already-paid work was validated before its journal intent. Retained input/held files
            // drive restart, publication and submission; do not make a later gateway outage erase
            // that progress. Use the conservative measured maximum for the planner's cheap gate.
            Some(crate::composition::BAND_4_CYCLES)
        }
    } else if program == Program::NostrWorkspace {
        let manifest = proving_entry.manifest.as_ref().ok_or_else(|| {
            anyhow::anyhow!("nostr-workspace {} has no operator manifest", proving_entry.name)
        })?;
        let params: nostr_workspace_core::params::Params = serde_json::from_str(
            &std::fs::read_to_string(&manifest.params)
                .with_context(|| format!("reading Nostr params preimage {}", manifest.params))?,
        )?;
        params.validate().map_err(|error| anyhow::anyhow!("invalid Nostr params: {error:?}"))?;
        let reconstructed = nostr_workspace_core::params_hash(&params);
        anyhow::ensure!(
            reconstructed == reconstructed_params_hash,
            "Nostr params file hashes to {reconstructed:#x}, checkpoint/catalog pins {reconstructed_params_hash:#x}"
        );
        // `max_estimated_pgu` is consensus-authenticated and intentionally conservative. Exact
        // archive bytes/counts/signatures are revalidated by assemble before the journal Intent.
        Some(params.max_estimated_pgu)
    } else {
        None
    };
    let abandoned_checkpoints = checkpoints
        .iter()
        .filter_map(|c| {
            let key = WorkKey { chain_id, instance_id: entry.instance_id, checkpoint_id: c.id };
            matches!(journal.status(&key), Status::Abandoned { .. }).then_some(c.id)
        })
        .collect();
    let in_flight = if let Some(id) = newest {
        let key = WorkKey { chain_id, instance_id: entry.instance_id, checkpoint_id: id };
        match journal.status(&key) {
            Status::Untouched | Status::Settled(_) | Status::Abandoned { .. } => None,
            Status::InFlight { request_id } => {
                // The journal says a request is ours; the DISK says whether the proof came back.
                // A held proof is submit-ready only after its exact publication policy is
                // durably satisfied. Failed attempts survive restart and produce a quiet
                // backoff state until their retry time.
                let flight_state = if handlers::has_held_proof(entry, id) {
                    if program == Program::Signer || cfg.ipfs.required_successes() == 0 {
                        InFlightState::Ready
                    } else {
                        let held = handlers::load_proof(entry, id)?;
                        let policy_hash = cfg.ipfs.policy_hash();
                        if journal.publication_satisfied(&key, &held.cid, policy_hash) {
                            InFlightState::Ready
                        } else if let Some(retry) =
                            journal.publication_retry(&key, &held.cid, policy_hash)
                        {
                            let retry_at = retry.last_at.saturating_add(cfg.ipfs.retry_seconds);
                            if now() < retry_at {
                                InFlightState::PublicationBackoff {
                                    attempts: retry.attempts,
                                    retry_at,
                                }
                            } else {
                                InFlightState::AwaitingPublication
                            }
                        } else {
                            InFlightState::AwaitingPublication
                        }
                    }
                } else {
                    InFlightState::Proving
                };
                Some(InFlight {
                    checkpoint_id: id,
                    request_id: Some(request_id),
                    state: flight_state,
                })
            }
            Status::OutcomeUnknown { .. } => Some(InFlight {
                checkpoint_id: id,
                request_id: None,
                state: InFlightState::OutcomeUnknown,
            }),
        }
    } else {
        None
    };

    let mut vault = match (program, cfg.paid.enabled, cfg.paid.vault) {
        (Program::Signer, _, _) => None,
        (_, true, Some(vault)) => newest.and_then(|checkpoint_id| {
            handlers::vault_quote(rpc, vault, entry.instance_id, checkpoint_id).ok()
        }),
        _ => None,
    };
    if program == Program::Composition {
        if let (Some(cycles), Some(quote)) = (authenticated_cycles, vault.as_mut()) {
            if !composition_quote_covers_proving(
                *quote,
                cycles,
                cfg.budget.cents_per_billion_cycles,
            ) {
                quote.eligible = false;
                // Operator-local reason outside the on-chain enum: authenticated composition work
                // exceeds the available quote. It is surfaced as an ordinary funded hold.
                quote.reason = u8::MAX;
            }
        }
    }

    Ok(InstanceState {
        instance_id: entry.instance_id,
        program,
        snapshot: entry.snapshot,
        head_block: head,
        basefee_wei: basefee,
        epoch_length: view.epoch_length,
        last_trigger_block: view.last_trigger_block,
        checkpoints,
        abandoned_checkpoints,
        last_applied_checkpoint: view.last_applied,
        params_hash: view.params_hash,
        reconstructed_params_hash,
        zk_verifier: view.zk_verifier,
        // Equal when the deployed verifier is pinned to the vkey our guest produces, and
        // deliberately unequal otherwise — that inequality is what makes `plan` hold instead of
        // paying for a proof no verifier on this chain will accept.
        expected_zk_verifier: match our_vkey {
            Some(ours) if verifier_vkey(rpc, view.zk_verifier).is_ok_and(|d| d == ours) => {
                view.zk_verifier
            }
            Some(_) => Address::ZERO,
            None => view.zk_verifier,
        },
        paused: module_paused,
        rotation_pending: false,
        live_commitments: view.live,
        size: InstanceSize {
            leaf_count: proof_leaf_count,
            anchor_count: proof_anchor_work,
            authenticated_cycles,
        },
        live_input_work,
        input_capacity: view.input_capacity.unwrap_or(operator_core::policy::MAX_PRICED_INPUTS),
        in_flight,
        vault,
    })
}

fn composition_required_usd_1e8(cycles: u64, cents_per_billion_cycles: u64) -> u128 {
    let required_cents =
        cycles.saturating_mul(cents_per_billion_cycles).div_ceil(1_000_000_000).max(1);
    u128::from(required_cents).saturating_mul(1_000_000)
}

fn composition_quote_covers_proving(
    quote: operator_core::types::VaultView,
    cycles: u64,
    cents_per_billion_cycles: u64,
) -> bool {
    quote.fee_usd >= composition_required_usd_1e8(cycles, cents_per_billion_cycles)
}

/// Do the one thing the plan said. Nothing here reinterprets it.
#[allow(clippy::too_many_arguments)]
fn act(
    cfg: &Config,
    rpc: &Rpc,
    chain_id: u64,
    sender: Option<&Sender>,
    journal: &mut Journal,
    pending_settles: &mut BTreeMap<WorkKey, PendingSettle>,
    logger: &Logger,
    entry: &CatalogEntry,
    state: &InstanceState,
    action: &Action,
    prepared_input: Option<&handlers::Built>,
) -> Result<()> {
    let Some(sender) = sender else { return Ok(()) };
    let max_fee = cfg.gas.max_basefee_gwei as u128 * 1_000_000_000 * 2;

    match action {
        Action::Trigger => {
            if entry.program == Program::Signer {
                bail!(
                    "derived signer program attempted to trigger its score source; it must only follow landed score checkpoints"
                );
            }
            let trigger_gas = if entry.program == Program::Composition {
                // Eight authenticated source reads plus durable TGCM storage measured 1,916,283
                // gas in the optimized contract profile. Keep explicit headroom without granting
                // a block-sized ceiling to every legacy trigger.
                2_500_000
            } else {
                400_000
            };
            let (tx, r) = sender.send_watched(
                rpc,
                entry.snapshot,
                crate::chain::trigger_calldata(),
                trigger_gas,
                max_fee,
                cfg.gas.simulate_before_send,
                cfg.gas.replacement_after_s,
                600,
            )?;
            if !r.success {
                bail!("trigger {tx:#x} reverted on chain at block {}", r.block_number);
            }
            logger.event(
                "triggered",
                json!({
                    "instance": format!("{:#x}", entry.instance_id),
                    "tx": format!("{tx:#x}"),
                    "block": r.block_number,
                    "gas_used": r.gas_used,
                }),
            );
        }

        Action::Prove { checkpoint_id } => {
            let key =
                WorkKey { chain_id, instance_id: entry.instance_id, checkpoint_id: *checkpoint_id };
            if !journal.may_request(&key) {
                // The journal is the authority on whether this was already paid for. `plan` should
                // have produced a Hold, so reaching here means the two disagree — refuse, and say
                // which of the four possible disagreements this is. `plan` cannot see a settled
                // record (it maps to "no work in flight"), so on a chain whose history no longer
                // matches the journal it will re-plan the same doomed Prove every tick.
                bail!("{}", journal.refusal(&key, state.last_applied_checkpoint));
            }

            let pinned_params_hash = state
                .checkpoints
                .iter()
                .find(|checkpoint| checkpoint.id == *checkpoint_id)
                .and_then(|checkpoint| checkpoint.pinned_params_hash)
                .ok_or_else(|| {
                    anyhow::anyhow!(
                        "checkpoint {checkpoint_id} has no pinned params hash and cannot be proven safely"
                    )
                })?;
            let proving_entry =
                entry_at_params_hash(rpc, entry, pinned_params_hash, state.head_block)?;
            let owned_built;
            let built = if let Some(prepared) = prepared_input {
                prepared
            } else {
                owned_built = handlers::build_input(
                    cfg,
                    rpc,
                    &proving_entry,
                    *checkpoint_id,
                    cfg.recipient(),
                )?;
                &owned_built
            };

            // fsync the intent BEFORE the request. Everything after this line is money at risk,
            // and a buffered intent that a crash loses turns "did I already pay?" into "no".
            // What this is about to cost us, priced from the size we are about to prove. Recorded
            // now because it is only knowable now — by the next tick the graph has moved.
            let cost_cents = estimated_cost_cents(cfg, state);
            journal.append(Record::Intent {
                key,
                public_values_hash: built.public_values_hash,
                vk_hash: built.vk_hash,
                at: now(),
                cost_cents,
            })?;

            let proof = handlers::prove(cfg, &built)?;
            journal.append(Record::Requested { key, request_id: proof.request_id, at: now() })?;

            // Persist both the proof and its canonical score bytes before publication. A crash
            // after this point resumes the cheap, idempotent publish rather than buying a proof
            // again. Submission remains unreachable until publication satisfies policy.
            handlers::save_held(entry, *checkpoint_id, &built, &proof)?;
            logger.event(
                "proved",
                json!({
                    "instance": format!("{:#x}", entry.instance_id),
                    "checkpoint": checkpoint_id,
                    "output_root": format!("{:#x}", proof.output_root),
                }),
            );
            if entry.program != Program::Signer {
                attempt_publication(cfg, journal, logger, entry, key, &built.cid, &built.blob)?;
            }
        }

        Action::Publish { checkpoint_id } => {
            anyhow::ensure!(
                entry.program != Program::Signer,
                "signer proof unexpectedly entered the score publication state"
            );
            let key =
                WorkKey { chain_id, instance_id: entry.instance_id, checkpoint_id: *checkpoint_id };
            let (held, score_blob) = handlers::load_publication_blob(entry, *checkpoint_id)?;
            attempt_publication(cfg, journal, logger, entry, key, &held.cid, &score_blob)?;
        }

        Action::Submit { checkpoint_id } => {
            let key =
                WorkKey { chain_id, instance_id: entry.instance_id, checkpoint_id: *checkpoint_id };

            // Upgrade legacy three-strike journals (or a crash between the Nth failure and its
            // Abandoned append) before attempting another submit. Abandonment is terminal for
            // this immutable checkpoint, but not for the instance: next tick the planner can
            // freeze a newer checkpoint after inputs move.
            let (attempts, latest_class) = journal.submit_failures(&key);
            if attempts >= cfg.ops.submit_failure_threshold {
                abandon_checkpoint(
                    cfg,
                    journal,
                    logger,
                    entry,
                    key,
                    latest_class.unwrap_or(SubmitFailureClass::ReceiptRevert),
                    attempts,
                )?;
                return Ok(());
            }

            let held = handlers::load_proof(entry, *checkpoint_id)?;

            // The claim policy. A curated instance is proven on us and lands through plain
            // `submitProof`, drawing no vault; everything else goes through the vault so the
            // bounty is actually collected. Which one an instance is was already decided by
            // `policy.curated`; this is only where that decision becomes calldata.
            let curated = entry.program == Program::Signer
                || cfg.curated.instances.contains(&entry.instance_id);
            let (target, data) = if entry.program == Program::Signer {
                (
                    entry.submit_to,
                    crate::chain::submit_signer_calldata(
                        *checkpoint_id,
                        held.signers.clone(),
                        held.target_threshold,
                        held.blob.clone(),
                    ),
                )
            } else if curated || !cfg.paid.enabled {
                (
                    entry.submit_to,
                    crate::chain::submit_calldata(
                        *checkpoint_id,
                        held.output_root,
                        held.ipfs_hash,
                        held.cid.clone(),
                        held.total_value,
                        held.skipped_digest,
                        held.recipient,
                        held.blob.clone(),
                    ),
                )
            } else {
                let vault = cfg
                    .paid
                    .vault
                    .ok_or_else(|| anyhow::anyhow!("[paid] is on but no vault is configured"))?;
                // Ask for at least what the quote promised. `plan` already refused to prove an
                // ineligible instance, so a zero here would mean the terms changed underneath us
                // — exactly the case that must revert rather than hand over a free root.
                let min_payout =
                    state.vault.map(|v| min_payout_usd(v.offered_usd())).unwrap_or(U256::ZERO);
                (
                    vault,
                    crate::chain::submit_and_claim_calldata(
                        entry.instance_id,
                        *checkpoint_id,
                        held.output_root,
                        held.ipfs_hash,
                        held.cid.clone(),
                        held.total_value,
                        held.skipped_digest,
                        held.recipient,
                        held.blob.clone(),
                        min_payout,
                    ),
                )
            };

            match sender.send_watched(
                rpc,
                target,
                data,
                1_500_000,
                max_fee,
                cfg.gas.simulate_before_send,
                cfg.gas.replacement_after_s,
                cfg.prover.timeout_s.min(600),
            ) {
                Ok((tx, r)) => {
                    // H-3: whatever the outcome, the gas is spent — book it into the same
                    // rolling budget as proving cost, and a revert counts a strike.
                    journal.append(Record::SubmitGas {
                        key,
                        reverted: !r.success,
                        cost_cents: crate::tx::gas_cost_cents(
                            r.gas_used,
                            r.effective_gas_price,
                            cfg.budget.eth_usd,
                        ),
                        at: now(),
                    })?;
                    if !r.success {
                        let (attempts, _) = journal.submit_failures(&key);
                        if attempts >= cfg.ops.submit_failure_threshold {
                            abandon_checkpoint(
                                cfg,
                                journal,
                                logger,
                                entry,
                                key,
                                SubmitFailureClass::ReceiptRevert,
                                attempts,
                            )?;
                            return Ok(());
                        }
                        bail!(
                            "submit {tx:#x} reverted on chain at block {} (deterministic attempt \
                             {} of {})",
                            r.block_number,
                            attempts,
                            cfg.ops.submit_failure_threshold
                        );
                    }
                    // M-9: `Settled{Landed}` is journaled only after N confirmations (the
                    // pending-settle pass at the top of `tick`), so a reorged-out submit
                    // re-plans instead of wedging the journal.
                    let confirmations_required = if entry.program == Program::Signer {
                        cfg.signer_sync.confirmations
                    } else {
                        cfg.finality.confirmations
                    };
                    pending_settles.insert(
                        key,
                        PendingSettle {
                            anchor: Anchor {
                                block_number: r.block_number,
                                block_hash: rpc.block_hash(r.block_number)?.unwrap_or(B256::ZERO),
                            },
                            confirmations: confirmations_required,
                        },
                    );
                    logger.event(
                        "submitted",
                        json!({
                            "instance": format!("{:#x}", entry.instance_id),
                            "checkpoint": checkpoint_id,
                            "tx": format!("{tx:#x}"),
                            "block": r.block_number,
                            "gas_used": r.gas_used,
                            "confirmations_required": confirmations_required,
                        }),
                    );
                }
                Err(e) if is_stale_checkpoint(&e) => {
                    // Someone landed a newer root. This is SUCCESS: monotonic `submitProof` plus
                    // input-freeze-block filing is exactly what makes N operators compose.
                    journal.append(Record::Settled {
                        key,
                        outcome: Outcome::Superseded,
                        at: now(),
                    })?;
                    logger.event(
                        "superseded",
                        json!({
                            "instance": format!("{:#x}", entry.instance_id),
                            "checkpoint": checkpoint_id,
                        }),
                    );
                }
                Err(e) => {
                    if let Some(class) = e.deterministic_class() {
                        journal.append(Record::SubmitFailure { key, class, at: now() })?;
                        let (attempts, _) = journal.submit_failures(&key);
                        if attempts >= cfg.ops.submit_failure_threshold {
                            abandon_checkpoint(cfg, journal, logger, entry, key, class, attempts)?;
                            return Ok(());
                        }
                        bail!(
                            "submit preflight deterministically reverted ({class:?}, attempt {} \
                             of {}): {e}",
                            attempts,
                            cfg.ops.submit_failure_threshold
                        );
                    }
                    // Provider transport, fee/nonce, broadcast, receipt timeout, and all other
                    // non-execution failures stay retryable and consume no deterministic attempt.
                    return Err(e.into());
                }
            }
        }

        // Everything else is a decision not to act. `plan` already logged why.
        _ => {}
    }
    Ok(())
}

/// Attempt every configured publication target and make the result restart-safe.
///
/// A failed minimum is ordinary queued work, not a failed tick: it is journaled, logged every
/// time, and alerted only on attempt 1 and powers of two. That preserves escalation without a
/// webhook every daemon cadence while the same provider remains down.
fn attempt_publication(
    cfg: &Config,
    journal: &mut Journal,
    logger: &Logger,
    entry: &CatalogEntry,
    key: WorkKey,
    cid: &str,
    score_blob: &[u8],
) -> Result<bool> {
    let report = handlers::publish(cfg, cid, score_blob);
    let policy_hash = cfg.ipfs.policy_hash();
    let at = now();
    let successes = u32::try_from(report.successes.len()).unwrap_or(u32::MAX);
    let required = u32::try_from(report.required).unwrap_or(u32::MAX);

    if report.satisfied() {
        journal.append(Record::Published {
            key,
            cid: cid.to_string(),
            policy_hash,
            successes,
            required,
            at,
        })?;
        logger.event(
            "published",
            json!({
                "instance": format!("{:#x}", entry.instance_id),
                "checkpoint": key.checkpoint_id,
                "cid": cid,
                "targets": report.successes,
                "successes": successes,
                "required": required,
            }),
        );
        return Ok(true);
    }

    let failures = report.failure_strings();
    journal.append(Record::PublicationAttempt {
        key,
        cid: cid.to_string(),
        policy_hash,
        successes,
        required,
        failures: failures.clone(),
        at,
    })?;
    let attempts =
        journal.publication_retry(&key, cid, policy_hash).map_or(1, |retry| retry.attempts);
    let retry_at = at.saturating_add(cfg.ipfs.retry_seconds);
    logger.event(
        "publication_failed",
        json!({
            "instance": format!("{:#x}", entry.instance_id),
            "checkpoint": key.checkpoint_id,
            "cid": cid,
            "attempt": attempts,
            "successes": successes,
            "required": required,
            "failures": failures,
            "retry_at": retry_at,
        }),
    );
    if attempts == 1 || attempts.is_power_of_two() {
        alert(
            logger,
            cfg.ops.alert_webhook.as_deref(),
            &format!(
                "{}: publication policy failed for checkpoint {} (attempt {attempts}, \
                 {successes}/{required} targets); submission is blocked and retry is queued for \
                 unix time {retry_at}: {}",
                entry.name,
                key.checkpoint_id,
                failures.join("; ")
            ),
        );
    }
    Ok(false)
}

/// Persist terminal abandonment and emit the one alert that explains both the failure and the
/// automatic recovery. Repeated ticks cannot flood this alert because `build_state` projects the
/// terminal status into `abandoned_checkpoints`, so this key is never planned as Submit again.
fn abandon_checkpoint(
    cfg: &Config,
    journal: &mut Journal,
    logger: &Logger,
    entry: &CatalogEntry,
    key: WorkKey,
    class: SubmitFailureClass,
    attempts: u32,
) -> Result<()> {
    if matches!(journal.status(&key), Status::Abandoned { .. }) {
        return Ok(());
    }
    journal.append(Record::Abandoned { key, class, attempts, at: now() })?;
    let recovery =
        "exclude this immutable checkpoint and trigger/prove a newer checkpoint after inputs move";
    logger.event(
        "checkpoint_abandoned",
        json!({
            "instance": format!("{:#x}", entry.instance_id),
            "checkpoint": key.checkpoint_id,
            "failure_class": serde_json::to_value(class).unwrap_or(json!(null)),
            "attempts": attempts,
            "recovery": recovery,
        }),
    );
    alert(
        logger,
        cfg.ops.alert_webhook.as_deref(),
        &format!(
            "{}: checkpoint {} abandoned after {} deterministic submit failures \
             (failure_class={class:?}); recovery: {recovery}",
            entry.name, key.checkpoint_id, attempts
        ),
    );
    Ok(())
}

/// The `minPayoutUsd` guard for a funded submit: demand the FULL quoted payout, floored at 1.
///
/// M-6 (2026-08-13 audit): this was `.min(1)`, which CAPS the guard at 1 — a vault that slashed
/// its policy between quote and submit still collected a valid root for ~nothing. `.max(1)`
/// makes `submitAndClaim` revert unless it pays what the quote promised.
fn min_payout_usd(payable_usd: u128) -> U256 {
    U256::from(payable_usd.max(1))
}

/// A `StaleCheckpoint` revert, however the node phrased it.
fn is_stale_checkpoint(e: &impl std::fmt::Display) -> bool {
    let s = e.to_string();
    // 0x2e1bc45f = keccak("StaleCheckpoint(uint256,uint256)")[0..4]
    s.contains("StaleCheckpoint") || s.contains("0x2e1bc45f")
}

fn now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// M-6 regression: an underpaying vault is REJECTED, not accepted. The pre-fix `.min(1)`
    /// turned a $500 quote into a `minPayoutUsd` of 1.
    #[test]
    fn m6_min_payout_demands_the_full_quote() {
        assert_eq!(min_payout_usd(500), U256::from(500u64), "the quoted claim, not 1");
        assert_eq!(min_payout_usd(1), U256::from(1u64));
        // Zero would disable the guard entirely; the floor keeps it armed.
        assert_eq!(min_payout_usd(0), U256::from(1u64));
    }

    #[test]
    fn composition_cost_uses_authenticated_cycles_in_vault_usd_units() {
        assert_eq!(composition_required_usd_1e8(2_616_399, 100), 1_000_000);
        assert_eq!(composition_required_usd_1e8(222_311_301, 100), 23_000_000);
        assert!(
            composition_required_usd_1e8(222_311_301, 100)
                > composition_required_usd_1e8(2_616_399, 100)
        );
        let large_tank_tiny_fee = operator_core::types::VaultView {
            eligible: true,
            fee_usd: 1_000_000,
            gas_usd: 2_000_000,
            payable_usd: 100_000_000_000,
            reason: 0,
        };
        assert!(!composition_quote_covers_proving(
            large_tank_tiny_fee,
            crate::composition::BAND_4_CYCLES,
            100
        ));
        assert_eq!(large_tank_tiny_fee.offered_usd(), 3_000_000);
    }
}

/// The vkey each of this binary's guests produces. Derived once per run: it is a function of the
/// ELF, which cannot change while the process is alive.
fn guest_vkeys() -> Result<BTreeMap<Program, B256>> {
    let mut out = BTreeMap::new();
    for (program, vk) in [
        (Program::Trustgraphs, trustgraph_prover::programs::trust_graph::elf()),
        (Program::Contributions, trustgraph_prover::programs::contributions::elf()),
        (Program::Weighted, trustgraph_prover::programs::weighted::elf()),
        (Program::Composition, trustgraph_prover::programs::composition::elf()),
        (Program::NostrWorkspace, trustgraph_prover::programs::nostr_workspace::elf()),
        (Program::Signer, trustgraph_prover::programs::signer::elf()),
    ] {
        let s = trustgraph_prover::common::vkey(vk)?;
        let b = hex::decode(s.trim().trim_start_matches("0x"))?;
        anyhow::ensure!(b.len() == 32, "vkey for {} was not 32 bytes", program.name());
        out.insert(program, B256::from_slice(&b));
    }
    Ok(out)
}
