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
use operator_core::journal::{Journal, Outcome, Record, Status, WorkKey};
use operator_core::plan;
use operator_core::types::{Action, InFlight, InFlightState, InstanceSize, InstanceState, Program};
use serde_json::json;
use std::collections::{BTreeMap, BTreeSet};
use std::path::PathBuf;

use crate::chain::{
    expected_instance_domain, read_snapshot, verifier_vkey, RegistryScan, Rpc, RpcCatalog,
};
use crate::config::Config;
use crate::handlers;
use crate::ops::{
    alert, write_status, InstanceStatus, Logger, PublicSettings, Status as OpsStatus,
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
    BTreeSet::from([Program::Trustgraphs, Program::Contributions, Program::Signer])
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
    let mut pending_settles: BTreeMap<WorkKey, Anchor> = BTreeMap::new();

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

#[allow(clippy::too_many_arguments)]
fn tick(
    cfg: &Config,
    rpc: &Rpc,
    chain_id: u64,
    sender: Option<&Sender>,
    journal: &mut Journal,
    scan: &mut RegistryScan,
    seen_anchors: &mut BTreeMap<(B256, u64), Anchor>,
    pending_settles: &mut BTreeMap<WorkKey, Anchor>,
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
    for (key, anchor) in pending_settles.iter() {
        let live = rpc.block_hash(anchor.block_number).ok().flatten();
        match anchor.finality(head, cfg.finality.confirmations, live) {
            Finality::Final => {
                journal.append(Record::Settled { key: *key, outcome: Outcome::Landed, at: now() })?;
                logger.event(
                    "submit_confirmed",
                    json!({
                        "instance": format!("{:#x}", key.instance_id),
                        "checkpoint": key.checkpoint_id,
                        "block": anchor.block_number,
                        "confirmations": cfg.finality.confirmations,
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

    for program in supported() {
        let catalog = catalog_scan(&reader, program, &manifest)?;

        // Say what was skipped. A silently shorter list is indistinguishable from a healthy one.
        for s in &catalog.skipped {
            let reason = s.reason.to_string();
            logger.event(
                "instance_skipped",
                json!({
                    "instance": format!("{:#x}", s.instance_id),
                    "program": program.name(),
                    "reason": reason.clone(),
                }),
            );
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
            // The vkey check, per instance. `expected_zk_verifier` in the state is what makes
            // `plan` produce a `VerifierRotated` hold, so it has to reflect reality rather than
            // being copied from the chain read.
            let ours = vkeys.get(&program).copied();
            let state = match build_state(
                rpc, cfg, chain_id, program, entry, head, basefee, journal, ours, seen_anchors,
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

            // H-4 (2026-08-13 audit): the accumulator only ever grows — attestations AND
            // revocations both append a leaf, anchors append forever, and the chained hash
            // cannot be trimmed. Past MAX_PRICED_INPUTS the root is unprovable (cycle refusal)
            // and unpaid (vault band 0) PERMANENTLY, so approaching the cliff must be a loud
            // operational event long before it is a fact. 80% is the alarm line.
            let inputs = state.size.leaf_count.saturating_add(state.size.anchor_count);
            let ceiling = operator_core::policy::MAX_PRICED_INPUTS;
            if inputs >= ceiling.saturating_mul(8) / 10 {
                let text = format!(
                    "{} ({}): {inputs} of {ceiling} accumulator inputs ({}%) — the H-4 ceiling \
                     is PERMANENT (leaves cannot be trimmed; past it the root is unprovable and \
                     unpaid). Act now: gate/price ingress, or plan the constitutional \
                     setAccumulator re-seed (docs/build/production.md, 'The accumulator \
                     ceiling').",
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

            let policy = cfg.policy_for(entry.instance_id, supported());
            // Rolling spend, from the journal. This is what makes `LossBudget` reachable at all:
            // it was `Spend::default()` here, so the budget could never fire and "unpreventable
            // spend is budgeted" was a property of the library rather than of the daemon.
            let spend = journal.spend(entry.instance_id, now(), cfg.budget.window_seconds);
            let action = plan(&state, &policy, spend);
            logger.action(&format!("{:#x}", entry.instance_id), &action);

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

            statuses.push(InstanceStatus {
                instance_id: format!("{:#x}", entry.instance_id),
                name: entry.name.clone(),
                program: program.name().to_string(),
                snapshot: format!("{:#x}", entry.snapshot),
                curated: policy.curated,
                action,
                blocks_since_root: state
                    .last_applied_checkpoint
                    .and_then(|id| state.checkpoints.iter().find(|c| c.id == id))
                    .map(|c| head.saturating_sub(c.block_number)),
            });
        }
    }

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
                publishes_scores: cfg.ipfs.api.is_some(),
                verifies_score_readback: cfg.ipfs.gateway.is_some(),
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
    journal: &Journal,
    our_vkey: Option<B256>,
    seen_anchors: &mut BTreeMap<(B256, u64), Anchor>,
) -> Result<InstanceState> {
    let view = read_snapshot(rpc, entry.snapshot)?;

    // The domain the contract will rebuild, checked against our own derivation. A mismatch means
    // this binary and the chain disagree about what `instanceDomain` is, which would waste every
    // proof it produced.
    let expected = expected_instance_domain(entry.snapshot, chain_id);
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
    if cfg.finality.track_block_hash {
        for c in &mut checkpoints {
            let live = rpc.block_hash(c.block_number)?;
            let anchor = *seen_anchors
                .entry((entry.instance_id, c.id))
                .or_insert(Anchor { block_number: c.block_number, block_hash: live.unwrap_or(B256::ZERO) });
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

    // In-flight work, from the journal rather than from memory: a restart must re-attach rather
    // than pay again.
    let newest = checkpoints
        .iter()
        .filter(|c| view.last_applied.is_none_or(|last| c.id > last))
        .map(|c| c.id)
        .max();
    let in_flight = newest.and_then(|id| {
        let key = WorkKey { chain_id, instance_id: entry.instance_id, checkpoint_id: id };
        match journal.status(&key) {
            Status::Untouched | Status::Settled(_) => None,
            Status::InFlight { request_id } => Some(InFlight {
                checkpoint_id: id,
                request_id: Some(request_id),
                // The journal says a request is ours; the DISK says whether the proof came back.
                // Reading only the journal left the daemon reporting `Proving` forever on a proof
                // it was already holding — it proved, then sat on the result.
                state: if handlers::has_held_proof(entry, id) {
                    InFlightState::Ready
                } else {
                    InFlightState::Proving
                },
            }),
            Status::OutcomeUnknown { .. } => Some(InFlight {
                checkpoint_id: id,
                request_id: None,
                state: InFlightState::OutcomeUnknown,
            }),
        }
    });

    let vault = match (cfg.paid.enabled, cfg.paid.vault) {
        (true, Some(vault)) => newest.and_then(|checkpoint_id| {
            handlers::vault_quote(rpc, vault, entry.instance_id, checkpoint_id).ok()
        }),
        _ => None,
    };

    Ok(InstanceState {
        instance_id: entry.instance_id,
        program,
        snapshot: entry.snapshot,
        head_block: head,
        basefee_wei: basefee,
        epoch_length: view.epoch_length,
        last_trigger_block: view.last_trigger_block,
        checkpoints,
        last_applied_checkpoint: view.last_applied,
        params_hash: view.params_hash,
        reconstructed_params_hash: entry.reconstructed_params_hash,
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
        paused: false,
        rotation_pending: false,
        live_commitments: view.live,
        size: InstanceSize {
            leaf_count: view.live.leaf_count,
            anchor_count: view.live.anchor_count,
        },
        in_flight,
        vault,
    })
}

/// Do the one thing the plan said. Nothing here reinterprets it.
#[allow(clippy::too_many_arguments)]
fn act(
    cfg: &Config,
    rpc: &Rpc,
    chain_id: u64,
    sender: Option<&Sender>,
    journal: &mut Journal,
    pending_settles: &mut BTreeMap<WorkKey, Anchor>,
    logger: &Logger,
    entry: &CatalogEntry,
    state: &InstanceState,
    action: &Action,
) -> Result<()> {
    let Some(sender) = sender else { return Ok(()) };
    let max_fee = cfg.gas.max_basefee_gwei as u128 * 1_000_000_000 * 2;

    match action {
        Action::Trigger => {
            let (tx, r) = sender.send_watched(
                rpc,
                entry.snapshot,
                crate::chain::trigger_calldata(),
                400_000,
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

            let built = handlers::build_input(cfg, rpc, entry, state, *checkpoint_id)?;

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

            // Publish the scores BEFORE the root lands, so nothing ever observes a root whose
            // data cannot be fetched. Best-effort: a failed pin must not stop a valid proof from
            // being submitted, so it alerts and carries on.
            match handlers::pin(cfg, &built) {
                Ok(cid) => logger.event(
                    "pinned",
                    json!({ "instance": format!("{:#x}", entry.instance_id), "cid": cid }),
                ),
                Err(e) => {
                    let text = format!(
                        "{}: could not publish the score blob ({e}). The root is still valid, but \
                         until these bytes are on IPFS the indexer cannot build a member list and \
                         the network page will render empty.",
                        entry.name
                    );
                    logger.event(
                        "pin_failed",
                        json!({ "instance": format!("{:#x}", entry.instance_id), "error": e.to_string() }),
                    );
                    alert(logger, cfg.ops.alert_webhook.as_deref(), &text);
                }
            }

            handlers::save_held(entry, *checkpoint_id, &built, &proof)?;
            logger.event(
                "proved",
                json!({
                    "instance": format!("{:#x}", entry.instance_id),
                    "checkpoint": checkpoint_id,
                    "output_root": format!("{:#x}", proof.output_root),
                }),
            );
        }

        Action::Submit { checkpoint_id } => {
            let key =
                WorkKey { chain_id, instance_id: entry.instance_id, checkpoint_id: *checkpoint_id };

            // H-3 circuit breaker: a submit that keeps reverting re-plans every tick forever —
            // each attempt burning its full gas — because a failed submit never journals
            // `Settled`. Three on-chain reverts for one WorkKey is a human problem (paused
            // instance? rotated verifier the preflight missed? malformed proof?), not a retry
            // problem. The hold stands until someone appends a `Resolved` record for the key.
            let strikes = journal.submit_strikes(&key);
            if strikes >= 3 {
                bail!(
                    "submit for checkpoint {} has reverted on-chain {strikes} times; held for a \
                     human (append a Resolved record for this key to clear the strikes)",
                    checkpoint_id
                );
            }

            let held = handlers::load_proof(entry, *checkpoint_id)?;

            // The claim policy. A curated instance is proven on us and lands through plain
            // `submitProof`, drawing no vault; everything else goes through the vault so the
            // bounty is actually collected. Which one an instance is was already decided by
            // `policy.curated`; this is only where that decision becomes calldata.
            let curated = cfg.curated.instances.contains(&entry.instance_id);
            let (target, data) = if curated || !cfg.paid.enabled {
                (
                    entry.snapshot,
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
                let min_payout = state.vault.map(|v| min_payout_usd(v.payable_usd)).unwrap_or(U256::ZERO);
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
                        bail!(
                            "submit {tx:#x} reverted on chain at block {} (strike {} of 3)",
                            r.block_number,
                            journal.submit_strikes(&key)
                        );
                    }
                    // M-9: `Settled{Landed}` is journaled only after N confirmations (the
                    // pending-settle pass at the top of `tick`), so a reorged-out submit
                    // re-plans instead of wedging the journal.
                    pending_settles.insert(
                        key,
                        Anchor {
                            block_number: r.block_number,
                            block_hash: rpc
                                .block_hash(r.block_number)?
                                .unwrap_or(B256::ZERO),
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
                            "confirmations_required": cfg.finality.confirmations,
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
                Err(e) => return Err(e),
            }
        }

        // Everything else is a decision not to act. `plan` already logged why.
        _ => {}
    }
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
fn is_stale_checkpoint(e: &anyhow::Error) -> bool {
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
        assert_eq!(min_payout_usd(500), U256::from(500u64), "the full quote, not 1");
        assert_eq!(min_payout_usd(1), U256::from(1u64));
        // Zero would disable the guard entirely; the floor keeps it armed.
        assert_eq!(min_payout_usd(0), U256::from(1u64));
    }
}

/// The vkey each of this binary's guests produces. Derived once per run: it is a function of the
/// ELF, which cannot change while the process is alive.
fn guest_vkeys() -> Result<BTreeMap<Program, B256>> {
    let mut out = BTreeMap::new();
    for (program, vk) in [
        (Program::Trustgraphs, trustgraph_prover::programs::trust_graph::elf()),
        (Program::Contributions, trustgraph_prover::programs::contributions::elf()),
        (Program::Signer, trustgraph_prover::programs::signer::elf()),
    ] {
        let s = trustgraph_prover::common::vkey(vk)?;
        let b = hex::decode(s.trim().trim_start_matches("0x"))?;
        anyhow::ensure!(b.len() == 32, "vkey for {} was not 32 bytes", program.name());
        out.insert(program, B256::from_slice(&b));
    }
    Ok(out)
}
