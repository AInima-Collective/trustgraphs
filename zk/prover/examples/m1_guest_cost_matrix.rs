//! Reproducible M1 calibration gate for the five PageRank-bearing production guests.
//!
//! Every row executes the freshly built SP1 ELF, byte-compares its public values with the native
//! computation, and prints the named cost-model terms. The process fails if any estimate is below
//! the measured global instruction clock.

use alloy_primitives::{Address, B256, U256};
use anyhow::{bail, Result};
use operator_core::types::Program;
use operator_core::work::{CostEstimate, WorkProfile};
use pagerank_core::encode;
use serde::Serialize;
use trustgraph_core::{Binding, GuestInput, RawEdge};
use trustgraph_prover::{common, programs};

fn count(value: usize) -> u64 {
    u64::try_from(value).unwrap_or(u64::MAX)
}

fn witness_bytes<T: Serialize>(input: &T) -> u64 {
    count(serde_json::to_vec_pretty(input).expect("serialize benchmark input").len())
}

fn print_row(label: &str, work: WorkProfile, cost: CostEstimate, cycles: u64) {
    println!(
        "{label}|{}|{}|{}|{}|{}|{}|{}|{}|{}|{}|{}|{}|{}|{}|{}|{}|{}",
        work.program.name(),
        work.raw_records,
        work.live_edges,
        work.unique_nodes,
        work.max_out_degree,
        work.witness_bytes,
        work.signature_checks,
        work.max_iterations,
        work.iterations_run,
        cost.base,
        cost.decode_authenticate,
        cost.reconcile,
        cost.graph_build,
        cost.rank,
        cost.output_and_merkle,
        cycles,
        cost.total,
    );
}

fn execute<T: Serialize>(
    label: &str,
    elf: sp1_sdk::Elf,
    input: &T,
    native_public_values: &[u8],
    work: WorkProfile,
) -> Result<bool> {
    let execution = common::execute_values_untraced(elf, input, native_public_values)?;
    let cost = work.estimate();
    print_row(label, work, cost, execution.cycles);
    Ok(cost.total >= execution.cycles)
}

fn address(index: usize) -> Address {
    let mut bytes = [0u8; 20];
    bytes[12..].copy_from_slice(&(index as u64).to_be_bytes());
    Address::from(bytes)
}

fn uid(index: u64) -> B256 {
    let mut bytes = [0u8; 32];
    bytes[24..].copy_from_slice(&index.to_be_bytes());
    B256::from(bytes)
}

fn edge(from: usize, to: usize, index: u64, scale: U256) -> RawEdge {
    let mut data = vec![0u8; 64];
    data[32..].copy_from_slice(&scale.to_be_bytes::<32>());
    RawEdge {
        kind: 0,
        attester: address(from),
        recipient: address(to),
        uid: uid(index),
        block_timestamp: index.saturating_add(1),
        data,
    }
}

/// Deterministic graph with an optional disconnected tail. Degrees vary from one to `max_degree`
/// to avoid the instantly-stable symmetry of a regular ring while retaining a reproducible shape.
fn graph_input(
    nodes: usize,
    max_degree: usize,
    disconnected_tail: usize,
    max_iterations: u32,
    tolerance_fp: U256,
) -> GuestInput {
    assert!(nodes > disconnected_tail);
    let mut input = programs::trust_graph::sample_input();
    input.edges.clear();
    input.lane2 = None;
    input.params.envelope0_domain_separators.clear();
    input.params.lane2_max_head_age = 0;
    input.params.trusted_seeds = vec![address(1)];
    input.params.max_iterations = max_iterations;
    input.params.tolerance_fp = tolerance_fp;
    input.binding = Binding::default();

    let connected = nodes - disconnected_tail;
    let components = if disconnected_tail == 0 {
        vec![(1usize, nodes + 1)]
    } else {
        vec![(1usize, connected + 1), (connected + 1, nodes + 1)]
    };
    let mut edge_index = 0u64;
    for (start, end) in components {
        let width = end - start;
        if width < 2 {
            continue;
        }
        for from in start..end {
            let degree = (1 + ((from * 7) % max_degree)).min(width - 1);
            for offset in 1..=degree {
                let to = start + ((from - start + offset) % width);
                input.edges.push(edge(from, to, edge_index, input.params.precision_scale));
                edge_index = edge_index.saturating_add(1);
            }
        }
    }
    input
}

fn trust_row(label: &str, input: GuestInput) -> Result<bool> {
    let native = trustgraph_core::compute::compute(&input);
    let anchors = input.lane2.as_ref().map_or(0, |lane| count(lane.anchors.len()));
    let work = WorkProfile::ranked(
        Program::Trustgraphs,
        count(input.edges.len()).saturating_add(anchors),
        witness_bytes(&input),
        anchors,
        native.signature_checks,
        count(native.scores.len()),
        native.rank,
    );
    execute(
        label,
        programs::trust_graph::elf(),
        &input,
        &encode::journal_encoded(&native.journal),
        work,
    )
}

fn main() -> Result<()> {
    println!("case|program|raw|edges|nodes|max_degree|witness_bytes|signatures|max_iterations|iterations_run|base|decode_authenticate|reconcile|graph_build|rank|output_merkle|measured|estimate");
    let mut all_one_sided = true;

    let trust = programs::trust_graph::sample_input();
    all_one_sided &= trust_row("sample-trust", trust)?;

    let signer = programs::signer::sample_signer_input();
    let signer_native = pagerank_core::signer::compute_signers(&signer);
    let signer_work = WorkProfile::ranked(
        Program::Signer,
        count(signer.edges.len()).saturating_add(count(signer.activity.len())),
        witness_bytes(&signer),
        0,
        0,
        count(signer_native.signers.len()),
        signer_native.rank,
    );
    all_one_sided &= execute(
        "sample-signer",
        programs::signer::elf(),
        &signer,
        &encode::signer_journal_encoded(&signer_native.journal),
        signer_work,
    )?;

    let contributions = programs::contributions::sample_input();
    let contributions_native = contributions_core::compute::compute(&contributions);
    let contributions_work = WorkProfile::ranked(
        Program::Contributions,
        count(contributions.trust_edges.len()).saturating_add(count(contributions.records.len())),
        witness_bytes(&contributions),
        0,
        contributions_native.signature_checks,
        count(contributions_native.scores.len()),
        contributions_native.rank,
    );
    all_one_sided &= execute(
        "sample-contributions",
        programs::contributions::elf(),
        &contributions,
        &encode::journal_encoded(&contributions_native.journal),
        contributions_work,
    )?;

    let hypercerts = programs::hypercerts::sample_input();
    let hypercerts_native = hypercerts_core::compute::compute(&hypercerts);
    // One PLC signature per operation plus the commit signature. Add one more per selected head
    // for the permitted provisional-key fallback; this is a safe call bound for valid witnesses.
    let hypercert_signatures = hypercerts.witnesses.iter().fold(0u64, |total, witness| {
        total.saturating_add(count(witness.plc_ops.len())).saturating_add(2)
    });
    let hypercerts_work = WorkProfile::ranked(
        Program::Hypercerts,
        count(hypercerts.anchors.len()).saturating_add(hypercerts_native.rank.live_edges),
        witness_bytes(&hypercerts),
        count(hypercerts.anchors.len()),
        hypercert_signatures,
        count(hypercerts_native.scores.len())
            .saturating_add(count(hypercerts_native.bindings.len())),
        hypercerts_native.rank,
    );
    all_one_sided &= execute(
        "sample-hypercerts",
        programs::hypercerts::elf(),
        &hypercerts,
        &encode::journal_encoded(&hypercerts_native.journal),
        hypercerts_work,
    )?;

    let nostr = programs::nostr_workspace::sample_input();
    let nostr_native = nostr_workspace_core::compute::compute(&nostr)
        .map_err(|error| anyhow::anyhow!("native Nostr sample failed: {error:?}"))?;
    let nostr_work = WorkProfile::ranked(
        Program::NostrWorkspace,
        count(nostr_native.events.len()),
        witness_bytes(&nostr),
        count(nostr.anchors.len()),
        nostr_native.signature_checks,
        count(nostr_native.scores.len()).saturating_add(count(nostr_native.bindings.len())),
        nostr_native.rank,
    );
    all_one_sided &= execute(
        "sample-nostr",
        programs::nostr_workspace::elf(),
        &nostr,
        &encode::journal_encoded(&nostr_native.journal),
        nostr_work,
    )?;

    let scale = U256::from(1_000_000_000_000_000_000u64);
    for (label, input) in [
        ("connected-v25-d2-i1", graph_input(25, 2, 0, 1, scale / U256::from(1_000_000u64))),
        ("connected-v100-d4", graph_input(100, 4, 0, 100, U256::ONE)),
        ("connected-v200-d8", graph_input(200, 8, 0, 100, U256::ONE)),
        ("unreachable-v200-d4-tail80", graph_input(200, 4, 80, 100, U256::ONE)),
        ("connected-v400-d8", graph_input(400, 8, 0, 100, U256::ONE)),
    ] {
        all_one_sided &= trust_row(label, input)?;
    }

    if !all_one_sided {
        bail!("cost model underestimated at least one measured guest row");
    }
    Ok(())
}
