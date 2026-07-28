//! Top-level canonical computation for the contributions program: trust edges + contribution
//! records + params → journal + artifacts. The single function the SP1 guest, the host, and
//! the TS display recompute all call. Two-stage scoring per CONTRIBUTION_FUNDING.md §4:
//!
//! **Stage 1 — reputation.** `pagerank-core`'s Trust-Aware PageRank over the vouch graph,
//! algorithm untouched (imported, never forked), producing `rep(r)` normalized to sum = S.
//!
//! **Stage 2 — rep-weighted budgeted valuation.** After the §5 eligibility filters:
//! `σ_r(c) = s_{r,c} / Σ_{c'} s_{r,c'}` (the rater's budget), `S(c) = Σ_r rep(r) · σ_r(c) ·
//! collabMult(r,c)`, `P(a) = Σ_c S(c) · attribShare(a,c) · consentMult(a,c)`. The collaborator
//! discount applies AFTER budget normalization — applied before, a rater whose eligible ratings
//! were all discounted would renormalize the discount away, making the conflict rule a no-op
//! for exactly the rings it targets.
//!
//! **Carve-out (§6.6).** β = `evaluator_carveout_bps`/10000 of the pool goes to participating
//! raters pro-rata rep; contributors share 1 − β pro-rata P. Each side is normalized over its
//! own mass, so the split is exact (up to `distribute_points_generic` quantization). If one
//! side has zero mass the other absorbs the pool (deterministic; e.g. no eligible valuations +
//! no participating raters ⇒ nobody is paid).

use crate::reconcile::{consent_mult_fp, reconcile, LiveState};
use crate::{params, Params};
use alloy_primitives::{keccak256, Address, B256, U256};
use pagerank_core::{cid, distribute, encode, merkle, pagerank, reconcile as trust_reconcile};
use pagerank_core::{Binding, ComputeResult, Journal, RawEdge};
use std::collections::{BTreeMap, BTreeSet};
use zk_core::fixed::{fp_mul, mul_div};

/// The complete input the contributions guest receives.
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct GuestInput {
    /// Trust (vouch) edges in TRUST-accumulator fold order — journal slot A.
    pub trust_edges: Vec<RawEdge>,
    /// Contribution records in CONTRIBUTION-accumulator fold order — journal slot B.
    /// Kinds per INTERFACES.md §2 (0–5).
    pub records: Vec<RawEdge>,
    pub params: Params,
    /// Journal-v3 pass-through commitments (payee + instance domain), identical in every program.
    #[serde(default)]
    pub binding: Binding,
}

/// Stage-1 reputation: the trust program's exact pipeline (reconcile → Trust-Aware PageRank),
/// driven by the mirrored rep params. Returns normalized scores (sum ≈ S) for every node.
pub fn reputation(trust_edges: &[RawEdge], p: &Params) -> BTreeMap<Address, U256> {
    let tp = trust_params(p);
    let graph = trust_reconcile::build_graph(trust_edges, &tp);
    pagerank::calculate(&graph, &tp)
}

/// The `pagerank-core::Params` twin driving stage 1 (only the fields the trust pipeline
/// reads; the trust program's own params-hash fields are irrelevant here — the contributions
/// program pins its OWN 21-word `paramsHash`).
fn trust_params(p: &Params) -> pagerank_core::Params {
    pagerank_core::Params {
        damping_fp: p.damping_fp,
        tolerance_fp: p.tolerance_fp,
        max_iterations: p.max_iterations,
        min_weight_fp: p.min_weight_fp,
        max_weight_fp: p.max_weight_fp,
        trust_multiplier_fp: p.trust_multiplier_fp,
        trust_share_fp: p.trust_share_fp,
        trust_decay_fp: p.trust_decay_fp,
        trusted_seeds: p.trusted_seeds.clone(),
        total_pool: p.total_pool,
        precision_scale: p.precision_scale,
        schema_uid: B256::ZERO,
        weight_field_index: p.weight_field_index,
        envelope0_domain_separators: Vec::new(),
        lane2_max_head_age: 0,
        // Params-schema v2 domain separation is the trust program's; this twin only drives the
        // stage-1 pipeline and never hashes, so both fields stay zero (see the doc comment above).
        accumulator: Address::ZERO,
        chain_id: 0,
    }
}

/// One rater's eligible valuation of one claim, after every §5 filter, with the post-budget
/// discount. Exposed for the indexer's audit view (M3) — the guest and the display recompute
/// share this exact eligibility logic.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EligibleValuation {
    pub claim_uid: B256,
    pub rater: Address,
    pub score: u8,
    /// S (no conflict) or `collaborator_mult_fp` (rater co-claims with a contributor).
    pub discount_fp: U256,
}

/// Why a live valuation was excluded from scoring (the indexer's honest-UI audit surface).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SkipReason {
    /// Rater is the claim's attester or one of its contributors.
    SelfValuation,
    /// Rater's stage-1 reputation is below `min_rater_rep_fp`.
    BelowMinRep,
}

/// The full stage-2 eligibility partition of the live valuation set.
#[derive(Clone, Debug, Default)]
pub struct Eligibility {
    pub eligible: Vec<EligibleValuation>,
    pub skipped: Vec<(B256, Address, SkipReason)>,
    /// Raters with ≥ 1 eligible valuation (the carve-out's "participated" set).
    pub participants: BTreeSet<Address>,
}

/// Apply the §5.2 filters to the live valuations.
pub fn eligibility(state: &LiveState, rep: &BTreeMap<Address, U256>, p: &Params) -> Eligibility {
    // Same-round co-claim sets: a ↔ b iff both are contributors of some live in-window claim.
    // (If the shared claim is the rated claim itself, the rater is one of its contributors and
    // the self-valuation rule already drops the record.)
    let mut co_claim: BTreeMap<Address, BTreeSet<Address>> = BTreeMap::new();
    for claim in state.claims.values() {
        for a in claim.shares.keys() {
            for b in claim.shares.keys() {
                if a != b {
                    co_claim.entry(*a).or_default().insert(*b);
                }
            }
        }
    }

    let mut out = Eligibility::default();
    for ((claim_uid, rater), score) in &state.valuations {
        let claim = &state.claims[claim_uid];

        // Self-valuation: rater is a contributor or the claim's attester.
        if claim.shares.contains_key(rater) || *rater == claim.attester {
            out.skipped.push((*claim_uid, *rater, SkipReason::SelfValuation));
            continue;
        }
        // Minimum rater reputation (dust-spam pruning).
        let rater_rep = rep.get(rater).copied().unwrap_or(U256::ZERO);
        if rater_rep < p.min_rater_rep_fp {
            out.skipped.push((*claim_uid, *rater, SkipReason::BelowMinRep));
            continue;
        }
        // Collaborator discount: the rater co-claims (same round) with any contributor.
        let conflicted = co_claim
            .get(rater)
            .map(|peers| claim.shares.keys().any(|a| peers.contains(a)))
            .unwrap_or(false);
        let discount_fp = if conflicted { p.collaborator_mult_fp } else { p.precision_scale };

        out.participants.insert(*rater);
        out.eligible.push(EligibleValuation {
            claim_uid: *claim_uid,
            rater: *rater,
            score: *score,
            discount_fp,
        });
    }
    out
}

/// Stage-2 result before quantization, all fixed point (scale S).
#[derive(Clone, Debug, Default)]
pub struct Stage2 {
    /// S(c): rep-weighted budgeted score per claim.
    pub claim_scores: BTreeMap<B256, U256>,
    /// P(a): contributor payout weight (pre carve-out scaling).
    pub contributor_weights: BTreeMap<Address, U256>,
    /// Final combined weight per address: (1−β)·P(a)/ΣP + β·rep(r)/Σrep over participants.
    pub combined_weights: BTreeMap<Address, U256>,
}

/// Run stage 2 over the reconciled live state (CONTRIBUTION_FUNDING.md §4 + §6.6).
pub fn stage2(
    state: &LiveState,
    rep: &BTreeMap<Address, U256>,
    elig: &Eligibility,
    p: &Params,
) -> Stage2 {
    let s = p.precision_scale;

    // Per-rater budgets: Σ of eligible scores (integer domain — scores are 0..=100).
    let mut budgets: BTreeMap<Address, u64> = BTreeMap::new();
    for v in &elig.eligible {
        *budgets.entry(v.rater).or_default() += v.score as u64;
    }

    // S(c) = Σ_r rep(r) · σ_r(c) · discount(r,c). A rater whose eligible scores sum to zero
    // has no budget to allocate (their zero-scores still count as participation).
    let mut claim_scores: BTreeMap<B256, U256> = BTreeMap::new();
    for v in &elig.eligible {
        let budget = budgets[&v.rater];
        if budget == 0 {
            continue;
        }
        let rater_rep = rep.get(&v.rater).copied().unwrap_or(U256::ZERO);
        // σ_r(c) in fp: score · S / budget.
        let sigma = mul_div(U256::from(v.score), s, U256::from(budget));
        let contribution = fp_mul(fp_mul(rater_rep, sigma, s), v.discount_fp, s);
        *claim_scores.entry(v.claim_uid).or_default() += contribution;
    }

    // P(a) = Σ_c S(c) · attribShare(a,c) · consentMult(a,c).
    let mut contributor_weights: BTreeMap<Address, U256> = BTreeMap::new();
    for (uid, score) in &claim_scores {
        if score.is_zero() {
            continue;
        }
        let claim = &state.claims[uid];
        for (a, share) in &claim.shares {
            let attrib = mul_div(U256::from(*share), s, U256::from(claim.total_shares));
            let consent = consent_mult_fp(state, claim, *a, p);
            let w = fp_mul(fp_mul(*score, attrib, s), consent, s);
            if !w.is_zero() {
                *contributor_weights.entry(*a).or_default() += w;
            }
        }
    }

    // Combine: contributors get 1−β of the pool pro-rata P(a); participating raters get β
    // pro-rata rep. Each side normalized over its own mass so the split is exact.
    let beta_bps = U256::from(p.evaluator_carveout_bps);
    let bps = U256::from(10_000u64);
    let beta_fp = mul_div(s, beta_bps, bps);
    let one_minus_beta_fp = s - beta_fp;

    let total_p: U256 = contributor_weights.values().copied().fold(U256::ZERO, |a, b| a + b);
    let participant_rep: BTreeMap<Address, U256> =
        elig.participants.iter().map(|r| (*r, rep.get(r).copied().unwrap_or(U256::ZERO))).collect();
    let total_rep: U256 = participant_rep.values().copied().fold(U256::ZERO, |a, b| a + b);

    let mut combined: BTreeMap<Address, U256> = BTreeMap::new();
    if !total_p.is_zero() {
        for (a, w) in &contributor_weights {
            let share = mul_div(*w, one_minus_beta_fp, total_p);
            if !share.is_zero() {
                *combined.entry(*a).or_default() += share;
            }
        }
    }
    if !beta_fp.is_zero() && !total_rep.is_zero() {
        for (r, rr) in &participant_rep {
            let share = mul_div(*rr, beta_fp, total_rep);
            if !share.is_zero() {
                *combined.entry(*r).or_default() += share;
            }
        }
    }

    Stage2 { claim_scores, contributor_weights, combined_weights: combined }
}

/// Run the full pipeline. Deterministic and float-free.
pub fn compute(input: &GuestInput) -> ComputeResult {
    // 1. Reproduce both chain-pinned input commitments (identical leaf/fold ABI).
    let (acc, leaf_count) = encode::accumulate(&input.trust_edges); // slot A: trust
    let (anchor_acc, anchor_count) = encode::accumulate(&input.records); // slot B: contributions

    // 2. The governance-pinned params commitment (21-word tuple).
    let params_hash = params::params_hash(&input.params);

    // 3. Stage 1: reputation over the vouch graph (trust pipeline, untouched).
    let rep = reputation(&input.trust_edges, &input.params);

    // 4. Reconcile the record log and apply the eligibility filters.
    let state = reconcile(&input.records, &input.params);
    let elig = eligibility(&state, &rep, &input.params);

    // 5. Stage 2: budgeted rep-weighted valuation + carve-out.
    let st2 = stage2(&state, &rep, &elig, &input.params);
    let weights: Vec<(Address, U256)> =
        st2.combined_weights.into_iter().filter(|(_, v)| !v.is_zero()).collect();

    // 6. Quantize to the integer pool allocation; sort ascending by address for the
    //    blob + tree determinism.
    let (mut assigned, total_value) = distribute::distribute_points_generic(
        &weights,
        input.params.precision_scale,
        input.params.total_pool,
    );
    assigned.sort_by(|a, b| a.0.cmp(&b.0));

    // 7. Output root (OZ standard tree, address-domain leaves) + canonical blob + CID.
    let leaves: Vec<B256> = assigned.iter().map(|(a, v)| merkle::output_leaf(*a, *v)).collect();
    let output_root = merkle::merkle_root(leaves);
    let blob = cid::canonical_blob(&assigned);
    let digest = cid::sha256(&blob);
    let ipfs_hash = B256::from(digest);
    let cid_str = cid::cid_v1_raw(&digest);
    let cid_digest = keccak256(cid_str.as_bytes());

    // Journal v3 reused unmodified: slot A = trust, slot B = contributions;
    // skippedDigest = 0 in v1 (skips are derivable from committed inputs — INTERFACES.md §4);
    // the two v3 bindings pass straight through from the witness.
    let journal = Journal {
        acc,
        leaf_count,
        anchor_acc,
        anchor_count,
        params_hash,
        output_root,
        ipfs_hash,
        cid_digest,
        total_value,
        skipped_digest: B256::ZERO,
        recipient: input.binding.recipient,
        instance_domain: input.binding.instance_domain,
    };
    ComputeResult { journal, scores: assigned, blob, cid: cid_str }
}

/// The journal digest the on-chain verifier binds.
pub fn journal_digest(j: &Journal) -> B256 {
    encode::journal_digest(j)
}
