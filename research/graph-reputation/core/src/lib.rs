//! Deterministic advisory graph-reputation core.
//!
//! Referrals propagate a caller-supplied sparse trusted-root prior. Missing referral budget and
//! dangling rows return to that prior. The computation is integer-only, bounded, canonically
//! ordered, and never changes a composition policy or an on-chain value.

use std::collections::{BTreeMap, BTreeSet};

use alloy_primitives::{keccak256, Address, B256};

pub const VERSION: u16 = 1;
pub const SCALE: u64 = 1_000_000_000_000_000_000;
pub const DAMPING: u64 = 850_000_000_000_000_000;
pub const ITERATIONS: usize = 128;
// 2e18 * 0.85^128 < 1.848e9; the remaining margin covers bounded Hamilton dust.
pub const ERROR_BOUND: u64 = 2_000_000_000;
pub const MAX_ROOTS: usize = 16;
pub const MAX_NODES: usize = 256;
pub const MAX_EDGES: usize = 4_096;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Root {
    pub lineage_id: B256,
    pub weight: u64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Node {
    pub lineage_id: B256,
    pub configuration_id: B256,
    pub epoch_id: B256,
    pub family_id: B256,
    pub method_id: B256,
    pub controller: Address,
    pub authority: Address,
    pub created_at: u64,
    pub epoch_accepted_block: u64,
    pub epoch_published_block: u64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Edge {
    pub endorsement_id: B256,
    pub issuer_lineage_id: B256,
    pub subject_lineage_id: B256,
    pub issuer_configuration_id: B256,
    pub subject_configuration_id: B256,
    pub scope_hash: B256,
    pub weight: u64,
    pub valid_from: u64,
    pub valid_until: u64,
    pub issued_block: u64,
    pub evidence_digest: B256,
    pub revoked_at: Option<u64>,
    pub superseded_by: Option<B256>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Input {
    pub version: u16,
    pub chain_id: u64,
    pub registry: Address,
    pub scope_hash: B256,
    pub cutoff_block: u64,
    pub finalized_block: u64,
    pub cutoff_timestamp: u64,
    pub roots: Vec<Root>,
    pub nodes: Vec<Node>,
    pub edges: Vec<Edge>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RootIngress {
    pub root_lineage_id: B256,
    pub mass: u64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Score {
    pub lineage_id: B256,
    pub score: u64,
    pub rank: u32,
    pub family_id: B256,
    pub family_mass: u64,
    pub root_ingress: Vec<RootIngress>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FamilyMass {
    pub family_id: B256,
    pub mass: u64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MatrixReferral {
    pub endorsement_id: B256,
    pub subject_lineage_id: B256,
    pub weight: u64,
    pub valid_until: u64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MatrixRow {
    pub issuer_lineage_id: B256,
    pub spent: u64,
    pub unused: u64,
    pub referrals: Vec<MatrixReferral>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ReputationResult {
    pub input_commitment: B256,
    pub result_commitment: B256,
    pub iterations: u16,
    pub residual: u64,
    pub converged: bool,
    pub scores: Vec<Score>,
    pub families: Vec<FamilyMass>,
    pub matrix: Vec<MatrixRow>,
}

#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
pub enum Error {
    #[error("unsupported version")]
    UnsupportedVersion,
    #[error("invalid chain, registry, scope, or cutoff")]
    InvalidDomain,
    #[error("invalid graph bounds")]
    InvalidBounds,
    #[error("invalid or unavailable previous-epoch node")]
    InvalidNode,
    #[error("invalid sparse trusted-root prior")]
    InvalidRoots,
    #[error("inactive, mismatched, or duplicate referral")]
    InvalidEdge,
    #[error("referral budget exceeds one")]
    BudgetExceeded,
    #[error("integer overflow")]
    Overflow,
    #[error("mass was not conserved")]
    MassNotConserved,
}

#[derive(Clone)]
struct Allocation<T> {
    key: Vec<u8>,
    data: T,
    allocation: u64,
    remainder: u128,
}

fn hamilton<T: Clone>(
    total: u64,
    entries: Vec<(Vec<u8>, u64, T)>,
) -> Result<Vec<Allocation<T>>, Error> {
    if entries.is_empty() {
        return Err(Error::InvalidBounds);
    }
    let denominator = entries
        .iter()
        .try_fold(0_u64, |sum, (_, weight, _)| sum.checked_add(*weight).ok_or(Error::Overflow))?;
    if denominator == 0 {
        return Err(Error::InvalidBounds);
    }
    let mut seen = BTreeSet::new();
    let mut rows = Vec::with_capacity(entries.len());
    for (key, weight, data) in entries {
        if !seen.insert(key.clone()) {
            return Err(Error::InvalidBounds);
        }
        let product = (total as u128) * (weight as u128);
        rows.push(Allocation {
            key,
            data,
            allocation: (product / denominator as u128) as u64,
            remainder: product % denominator as u128,
        });
    }
    let allocated = rows
        .iter()
        .try_fold(0_u64, |sum, row| sum.checked_add(row.allocation).ok_or(Error::Overflow))?;
    let mut unallocated = total.checked_sub(allocated).ok_or(Error::Overflow)?;
    let mut order: Vec<usize> = (0..rows.len()).collect();
    order.sort_by(|left, right| {
        rows[*right]
            .remainder
            .cmp(&rows[*left].remainder)
            .then_with(|| rows[*left].key.cmp(&rows[*right].key))
    });
    for index in order {
        if unallocated == 0 {
            break;
        }
        rows[index].allocation += 1;
        unallocated -= 1;
    }
    if unallocated != 0 {
        return Err(Error::Overflow);
    }
    Ok(rows)
}

fn canonical(mut input: Input) -> Input {
    input.roots.sort_by_key(|root| root.lineage_id);
    input.nodes.sort_by_key(|node| node.lineage_id);
    input
        .edges
        .sort_by_key(|edge| (edge.issuer_lineage_id, edge.subject_lineage_id, edge.endorsement_id));
    input
}

fn validate(input: &Input) -> Result<(), Error> {
    if input.version != VERSION {
        return Err(Error::UnsupportedVersion);
    }
    if input.chain_id == 0
        || input.registry == Address::ZERO
        || input.scope_hash == B256::ZERO
        || input.cutoff_block == 0
        || input.cutoff_timestamp == 0
        || input.cutoff_block > input.finalized_block
    {
        return Err(Error::InvalidDomain);
    }
    if input.roots.is_empty()
        || input.roots.len() > MAX_ROOTS
        || input.nodes.is_empty()
        || input.nodes.len() > MAX_NODES
        || input.edges.len() > MAX_EDGES
    {
        return Err(Error::InvalidBounds);
    }
    let mut nodes = BTreeMap::new();
    for node in &input.nodes {
        if node.lineage_id == B256::ZERO
            || node.configuration_id == B256::ZERO
            || node.epoch_id == B256::ZERO
            || node.family_id == B256::ZERO
            || node.method_id == B256::ZERO
            || node.controller == Address::ZERO
            || node.authority == Address::ZERO
            || node.created_at > input.cutoff_timestamp
            || node.epoch_accepted_block >= input.cutoff_block
            || node.epoch_published_block >= input.cutoff_block
            || nodes.insert(node.lineage_id, node).is_some()
        {
            return Err(Error::InvalidNode);
        }
    }
    let mut roots = BTreeSet::new();
    let mut root_mass = 0_u64;
    for root in &input.roots {
        if !nodes.contains_key(&root.lineage_id)
            || root.weight == 0
            || root.weight > SCALE
            || !roots.insert(root.lineage_id)
        {
            return Err(Error::InvalidRoots);
        }
        root_mass = root_mass.checked_add(root.weight).ok_or(Error::Overflow)?;
    }
    if root_mass != SCALE {
        return Err(Error::InvalidRoots);
    }
    let mut edge_ids = BTreeSet::new();
    let mut pairs = BTreeSet::new();
    let mut budgets = BTreeMap::<B256, u64>::new();
    for edge in &input.edges {
        let Some(issuer) = nodes.get(&edge.issuer_lineage_id) else {
            return Err(Error::InvalidEdge);
        };
        let Some(subject) = nodes.get(&edge.subject_lineage_id) else {
            return Err(Error::InvalidEdge);
        };
        if edge.endorsement_id == B256::ZERO
            || !edge_ids.insert(edge.endorsement_id)
            || !pairs.insert((edge.issuer_lineage_id, edge.subject_lineage_id))
            || edge.issuer_lineage_id == edge.subject_lineage_id
            || edge.issuer_configuration_id != issuer.configuration_id
            || edge.subject_configuration_id != subject.configuration_id
            || edge.scope_hash != input.scope_hash
            || edge.weight == 0
            || edge.weight > SCALE
            || edge.issued_block >= input.cutoff_block
            || edge.valid_from > input.cutoff_timestamp
            || edge.valid_until <= input.cutoff_timestamp
            || edge.revoked_at.is_some()
            || edge.superseded_by.is_some()
        {
            return Err(Error::InvalidEdge);
        }
        let budget = budgets.entry(edge.issuer_lineage_id).or_default();
        *budget = budget.checked_add(edge.weight).ok_or(Error::Overflow)?;
        if *budget > SCALE {
            return Err(Error::BudgetExceeded);
        }
    }
    Ok(())
}

struct Writer(Vec<u8>);

impl Writer {
    fn ascii(&mut self, value: &[u8]) {
        self.0.extend_from_slice(value);
    }

    fn bytes(&mut self, value: &[u8]) {
        self.0.extend_from_slice(value);
    }

    fn uint(&mut self, value: u64, bytes: usize) -> Result<(), Error> {
        if bytes < 8 && value >= (1_u64 << (bytes * 8)) {
            return Err(Error::Overflow);
        }
        self.0.extend_from_slice(&value.to_be_bytes()[8 - bytes..]);
        Ok(())
    }
}

pub fn encode_input(raw: &Input) -> Result<Vec<u8>, Error> {
    let input = canonical(raw.clone());
    validate(&input)?;
    let mut writer = Writer(Vec::new());
    writer.ascii(b"TGRP");
    writer.uint(VERSION as u64, 2)?;
    writer.uint(SCALE, 8)?;
    writer.uint(DAMPING, 8)?;
    writer.uint(ITERATIONS as u64, 2)?;
    writer.uint(input.chain_id, 8)?;
    writer.bytes(input.registry.as_slice());
    writer.bytes(input.scope_hash.as_slice());
    writer.uint(input.cutoff_block, 8)?;
    writer.uint(input.finalized_block, 8)?;
    writer.uint(input.cutoff_timestamp, 8)?;
    writer.uint(input.roots.len() as u64, 2)?;
    writer.uint(input.nodes.len() as u64, 2)?;
    writer.uint(input.edges.len() as u64, 4)?;
    for root in &input.roots {
        writer.bytes(root.lineage_id.as_slice());
        writer.uint(root.weight, 8)?;
    }
    for node in &input.nodes {
        writer.bytes(node.lineage_id.as_slice());
        writer.bytes(node.configuration_id.as_slice());
        writer.bytes(node.epoch_id.as_slice());
        writer.bytes(node.family_id.as_slice());
        writer.bytes(node.method_id.as_slice());
        writer.bytes(node.controller.as_slice());
        writer.bytes(node.authority.as_slice());
        writer.uint(node.created_at, 8)?;
        writer.uint(node.epoch_accepted_block, 8)?;
        writer.uint(node.epoch_published_block, 8)?;
    }
    for edge in &input.edges {
        writer.bytes(edge.endorsement_id.as_slice());
        writer.bytes(edge.issuer_lineage_id.as_slice());
        writer.bytes(edge.subject_lineage_id.as_slice());
        writer.bytes(edge.issuer_configuration_id.as_slice());
        writer.bytes(edge.subject_configuration_id.as_slice());
        writer.bytes(edge.scope_hash.as_slice());
        writer.uint(edge.weight, 8)?;
        writer.uint(edge.valid_from, 8)?;
        writer.uint(edge.valid_until, 8)?;
        writer.uint(edge.issued_block, 8)?;
        writer.bytes(edge.evidence_digest.as_slice());
        writer.uint(edge.revoked_at.unwrap_or(0), 8)?;
        writer.bytes(edge.superseded_by.unwrap_or(B256::ZERO).as_slice());
    }
    Ok(writer.0)
}

#[derive(Clone)]
enum Route {
    Edge(usize),
    Prior,
}

pub fn compute(raw: &Input) -> Result<ReputationResult, Error> {
    let input = canonical(raw.clone());
    let input_commitment = keccak256(encode_input(&input)?);
    let node_index: BTreeMap<B256, usize> =
        input.nodes.iter().enumerate().map(|(index, node)| (node.lineage_id, index)).collect();
    let root_index: BTreeMap<B256, usize> =
        input.roots.iter().enumerate().map(|(index, root)| (root.lineage_id, index)).collect();
    let mut outgoing = vec![Vec::<(&Edge, usize)>::new(); input.nodes.len()];
    let mut spent = BTreeMap::<B256, u64>::new();
    for edge in &input.edges {
        outgoing[node_index[&edge.issuer_lineage_id]]
            .push((edge, node_index[&edge.subject_lineage_id]));
        *spent.entry(edge.issuer_lineage_id).or_default() += edge.weight;
    }
    let mut state = vec![vec![0_u64; input.roots.len()]; input.nodes.len()];
    for root in &input.roots {
        state[node_index[&root.lineage_id]][root_index[&root.lineage_id]] = root.weight;
    }
    let prior_entries = || {
        input
            .roots
            .iter()
            .enumerate()
            .map(|(index, root)| (root.lineage_id.as_slice().to_vec(), root.weight, index))
            .collect()
    };
    let teleport = hamilton(SCALE - DAMPING, prior_entries())?;
    let mut residual = SCALE;
    for _ in 0..ITERATIONS {
        let mut next = vec![vec![0_u64; input.roots.len()]; input.nodes.len()];
        for allocation in &teleport {
            let root = &input.roots[allocation.data];
            next[node_index[&root.lineage_id]][allocation.data] += allocation.allocation;
        }
        let mut cells = Vec::new();
        for (node, row) in state.iter().enumerate() {
            for (root, weight) in row.iter().copied().enumerate() {
                if weight > 0 {
                    let mut key = input.nodes[node].lineage_id.as_slice().to_vec();
                    key.extend_from_slice(input.roots[root].lineage_id.as_slice());
                    cells.push((key, weight, (node, root)));
                }
            }
        }
        for cell in hamilton(DAMPING, cells)? {
            let row = &outgoing[cell.data.0];
            let row_spend = row.iter().try_fold(0_u64, |sum, (edge, _)| {
                sum.checked_add(edge.weight).ok_or(Error::Overflow)
            })?;
            let mut routes = Vec::new();
            for (edge, to) in row {
                let mut key = b"e:".to_vec();
                key.extend_from_slice(edge.subject_lineage_id.as_slice());
                key.push(b':');
                key.extend_from_slice(edge.endorsement_id.as_slice());
                routes.push((key, edge.weight, Route::Edge(*to)));
            }
            if row_spend < SCALE {
                routes.push((b"p".to_vec(), SCALE - row_spend, Route::Prior));
            }
            for routed in hamilton(cell.allocation, routes)? {
                match routed.data {
                    Route::Edge(to) => {
                        next[to][cell.data.1] = next[to][cell.data.1]
                            .checked_add(routed.allocation)
                            .ok_or(Error::Overflow)?;
                    }
                    Route::Prior if routed.allocation > 0 => {
                        for returned in hamilton(routed.allocation, prior_entries())? {
                            let root = &input.roots[returned.data];
                            let slot = &mut next[node_index[&root.lineage_id]][returned.data];
                            *slot = slot.checked_add(returned.allocation).ok_or(Error::Overflow)?;
                        }
                    }
                    Route::Prior => {}
                }
            }
        }
        residual = state
            .iter()
            .zip(&next)
            .map(|(before, after)| {
                let before: u64 = before.iter().sum();
                let after: u64 = after.iter().sum();
                before.abs_diff(after)
            })
            .sum();
        state = next;
    }
    let node_scores: Vec<u64> = state.iter().map(|row| row.iter().sum()).collect();
    if node_scores.iter().sum::<u64>() != SCALE {
        return Err(Error::MassNotConserved);
    }
    let mut ranked: Vec<usize> = (0..input.nodes.len()).collect();
    ranked.sort_by(|left, right| {
        node_scores[*right]
            .cmp(&node_scores[*left])
            .then_with(|| input.nodes[*left].lineage_id.cmp(&input.nodes[*right].lineage_id))
    });
    let rank_by_index: BTreeMap<usize, u32> =
        ranked.into_iter().enumerate().map(|(rank, index)| (index, rank as u32 + 1)).collect();
    let mut family_mass = BTreeMap::<B256, u64>::new();
    for (index, node) in input.nodes.iter().enumerate() {
        *family_mass.entry(node.family_id).or_default() += node_scores[index];
    }
    let families: Vec<FamilyMass> = family_mass
        .iter()
        .map(|(family_id, mass)| FamilyMass { family_id: *family_id, mass: *mass })
        .collect();
    let scores: Vec<Score> = input
        .nodes
        .iter()
        .enumerate()
        .map(|(index, node)| Score {
            lineage_id: node.lineage_id,
            score: node_scores[index],
            rank: rank_by_index[&index],
            family_id: node.family_id,
            family_mass: family_mass[&node.family_id],
            root_ingress: input
                .roots
                .iter()
                .enumerate()
                .map(|(root, value)| RootIngress {
                    root_lineage_id: value.lineage_id,
                    mass: state[index][root],
                })
                .collect(),
        })
        .collect();
    let matrix: Vec<MatrixRow> = input
        .nodes
        .iter()
        .enumerate()
        .map(|(index, node)| {
            let row_spend = spent.get(&node.lineage_id).copied().unwrap_or(0);
            MatrixRow {
                issuer_lineage_id: node.lineage_id,
                spent: row_spend,
                unused: SCALE - row_spend,
                referrals: outgoing[index]
                    .iter()
                    .map(|(edge, _)| MatrixReferral {
                        endorsement_id: edge.endorsement_id,
                        subject_lineage_id: edge.subject_lineage_id,
                        weight: edge.weight,
                        valid_until: edge.valid_until,
                    })
                    .collect(),
            }
        })
        .collect();
    let mut writer = Writer(Vec::new());
    writer.ascii(b"TGRR");
    writer.uint(VERSION as u64, 2)?;
    writer.bytes(input_commitment.as_slice());
    writer.uint(ITERATIONS as u64, 2)?;
    writer.uint(residual, 8)?;
    writer.uint(u64::from(residual <= ERROR_BOUND), 1)?;
    writer.uint(scores.len() as u64, 2)?;
    writer.uint(input.roots.len() as u64, 2)?;
    writer.uint(families.len() as u64, 2)?;
    for score in &scores {
        writer.bytes(score.lineage_id.as_slice());
        writer.uint(score.score, 8)?;
        writer.uint(score.rank as u64, 4)?;
        writer.bytes(score.family_id.as_slice());
        writer.uint(score.family_mass, 8)?;
        for ingress in &score.root_ingress {
            writer.uint(ingress.mass, 8)?;
        }
    }
    for family in &families {
        writer.bytes(family.family_id.as_slice());
        writer.uint(family.mass, 8)?;
    }
    Ok(ReputationResult {
        input_commitment,
        result_commitment: keccak256(writer.0),
        iterations: ITERATIONS as u16,
        residual,
        converged: residual <= ERROR_BOUND,
        scores,
        families,
        matrix,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    fn word(value: u32) -> B256 {
        let mut bytes = [0_u8; 32];
        bytes[28..].copy_from_slice(&value.to_be_bytes());
        B256::from(bytes)
    }

    fn address(value: u32) -> Address {
        let mut bytes = [0_u8; 20];
        bytes[16..].copy_from_slice(&value.to_be_bytes());
        Address::from(bytes)
    }

    fn fixture(ingress: bool) -> Input {
        let nodes: Vec<Node> = (0..6)
            .map(|index| Node {
                lineage_id: word(index + 1),
                configuration_id: word(index + 101),
                epoch_id: word(index + 201),
                family_id: word(if index < 3 { index + 301 } else { 399 }),
                method_id: word(if index < 3 { index + 401 } else { 499 }),
                controller: address(if index < 3 { index + 1 } else { 99 }),
                authority: address(if index < 3 { index + 11 } else { 88 }),
                created_at: 100,
                epoch_accepted_block: 900,
                epoch_published_block: 901,
            })
            .collect();
        let referrals: Vec<(usize, usize, u64)> = if ingress {
            vec![
                (0, 1, 900_000_000_000_000_000),
                (0, 3, 100_000_000_000_000_000),
                (1, 2, SCALE),
                (2, 0, SCALE),
                (3, 4, SCALE),
                (4, 5, SCALE),
                (5, 3, SCALE),
            ]
        } else {
            vec![
                (0, 1, SCALE),
                (1, 2, SCALE),
                (2, 0, SCALE),
                (3, 4, SCALE),
                (4, 5, SCALE),
                (5, 3, SCALE),
            ]
        };
        Input {
            version: VERSION,
            chain_id: 10,
            registry: address(500),
            scope_hash: word(500),
            cutoff_block: 1_000,
            finalized_block: 1_010,
            cutoff_timestamp: 2_000,
            roots: vec![
                Root { lineage_id: nodes[0].lineage_id, weight: 340_000_000_000_000_000 },
                Root { lineage_id: nodes[1].lineage_id, weight: 330_000_000_000_000_000 },
                Root { lineage_id: nodes[2].lineage_id, weight: 330_000_000_000_000_000 },
            ],
            edges: referrals
                .into_iter()
                .enumerate()
                .map(|(index, (from, to, weight))| Edge {
                    endorsement_id: word(600 + index as u32),
                    issuer_lineage_id: nodes[from].lineage_id,
                    subject_lineage_id: nodes[to].lineage_id,
                    issuer_configuration_id: nodes[from].configuration_id,
                    subject_configuration_id: nodes[to].configuration_id,
                    scope_hash: word(500),
                    weight,
                    valid_from: 1_000,
                    valid_until: 3_000,
                    issued_block: 800,
                    evidence_digest: if index == 0 { B256::ZERO } else { word(700 + index as u32) },
                    revoked_at: None,
                    superseded_by: None,
                })
                .collect(),
            nodes,
        }
    }

    #[test]
    fn rust_matches_the_frozen_typescript_golden_vectors() {
        let golden: Value =
            serde_json::from_str(include_str!("../../golden/graph-reputation.json")).unwrap();
        for case in golden["cases"].as_array().unwrap() {
            let mode = case["mode"].as_str().unwrap();
            let mut input = fixture(mode == "ingress");
            if mode == "dangling" {
                input.edges.retain(|edge| edge.issuer_lineage_id == input.nodes[0].lineage_id);
                input.edges[0].weight = 100_000_000_000_000_000;
            }
            let result = compute(&input).unwrap();
            assert_eq!(
                format!("{:#x}", result.input_commitment),
                case["inputCommitment"].as_str().unwrap()
            );
            assert_eq!(
                format!("{:#x}", result.result_commitment),
                case["resultCommitment"].as_str().unwrap()
            );
            assert_eq!(result.residual.to_string(), case["residual"]);
            let expected_scores: Vec<&str> = case["scores"]
                .as_array()
                .unwrap()
                .iter()
                .map(|score| score.as_str().unwrap())
                .collect();
            assert_eq!(
                result.scores.iter().map(|score| score.score.to_string()).collect::<Vec<_>>(),
                expected_scores
            );
            assert_eq!(result.families.last().unwrap().mass.to_string(), case["cartelMass"]);
            if let Some(expected_matrix) = case.get("matrix") {
                assert_eq!(result.matrix.len(), expected_matrix.as_array().unwrap().len());
                for (row, expected) in result.matrix.iter().zip(expected_matrix.as_array().unwrap())
                {
                    assert_eq!(row.spent.to_string(), expected["spent"]);
                    assert_eq!(row.unused.to_string(), expected["unused"]);
                    let referrals = expected["referrals"].as_array().unwrap();
                    assert_eq!(row.referrals.len(), referrals.len());
                    for (referral, expected_referral) in row.referrals.iter().zip(referrals) {
                        assert_eq!(
                            format!("{:#x}", referral.endorsement_id),
                            expected_referral["endorsementId"]
                        );
                        assert_eq!(
                            format!("{:#x}", referral.subject_lineage_id),
                            expected_referral["subjectLineageId"]
                        );
                        assert_eq!(referral.weight.to_string(), expected_referral["weight"]);
                        assert_eq!(
                            referral.valid_until.to_string(),
                            expected_referral["validUntil"]
                        );
                    }
                }
            }
        }
    }

    #[test]
    fn fail_closed_validation_rejects_same_epoch_and_wrong_scope() {
        let mut input = fixture(true);
        input.nodes[0].epoch_accepted_block = input.cutoff_block;
        assert_eq!(compute(&input), Err(Error::InvalidNode));
        let mut input = fixture(true);
        input.edges[0].scope_hash = word(999);
        assert_eq!(compute(&input), Err(Error::InvalidEdge));
    }
}
