//! Safe signer-sync selection: derive the Safe owner set + threshold from the governance weights.
//!
//! This is the signer-sync analogue of [`crate::compute`]: it runs the exact same fixed-point
//! Trust-Aware PageRank (so the selection is bound to the same `(acc, leafCount, paramsHash)`
//! commitment as the root producer), then applies a deterministic top-N selection rule. It is
//! float-free and deterministic so the SP1 guest, host, and browser all agree byte-for-byte.

use crate::{compute, encode, merkle};
use crate::{
    GuestInput, SelectionParams, SignerActivity, SignerComputeResult, SignerInput, SignerJournal,
};
use alloy_primitives::{keccak256, Address, B256, U256};
use std::collections::{BTreeMap, BTreeSet};

/// `ceil(a / b)` for `b > 0`.
#[inline]
fn ceil_div(a: u64, b: u64) -> u64 {
    (a + b - 1) / b
}

/// Deterministically select the Safe owner set and threshold from the scored accounts.
///
/// `scores` is the distributed `{account -> value}` set (the same `ComputeResult::scores` the root
/// producer emits: only `value > 0`, in any order — we re-sort here). Selection is total and unique:
///   1. rank by **value descending, then address ascending** (a total order — no prover choice on ties),
///   2. take the top `top_n`,
///   3. return the chosen addresses **sorted ascending** (the canonical order committed by the root),
///   4. `threshold = clamp(ceil(target_bps * n / 10000), min_threshold, n)`, floored at 1, where
///      `n` is the actual number chosen (which may be < `top_n` if fewer accounts have a score).
///
/// If no account has a positive score the set is empty and the threshold is 0; the on-chain module
/// rejects such a proof (a Safe must keep >= 1 owner).
pub fn select_signers(scores: &[(Address, U256)], sp: &SelectionParams) -> (Vec<Address>, U256) {
    let mut ranked: Vec<(Address, U256)> =
        scores.iter().filter(|(_, v)| !v.is_zero()).cloned().collect();
    // value desc, then address asc.
    ranked.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
    ranked.truncate(sp.top_n as usize);

    let mut chosen: Vec<Address> = ranked.into_iter().map(|(a, _)| a).collect();
    chosen.sort();

    let n = chosen.len() as u64;
    if n == 0 {
        return (chosen, U256::ZERO);
    }
    let mut threshold = ceil_div((sp.target_threshold_bps as u64) * n, 10_000);
    if threshold < sp.min_threshold as u64 {
        threshold = sp.min_threshold as u64;
    }
    if threshold > n {
        threshold = n;
    }
    if threshold < 1 {
        threshold = 1;
    }
    (chosen, U256::from(threshold))
}

/// The `signerSetRoot`: an OZ StandardMerkleTree over the sorted signer set (leaf =
/// `keccak256(abi.encode(address))`) — byte-identical to [`merkle::seed_set_root`].
pub fn signer_set_root(sorted_signers: &[Address]) -> alloy_primitives::B256 {
    merkle::seed_set_root(sorted_signers)
}

/// Fold one authenticated direct-governance activity record. Mirrors
/// `MerkleGovModule._recordDirectActivity` exactly.
pub fn fold_activity(previous: B256, sequence: u64, record: &SignerActivity) -> B256 {
    let mut encoded = Vec::with_capacity(32 * 5);
    encoded.extend_from_slice(previous.as_slice());
    encoded.extend_from_slice(&encode::word_u64(sequence));
    encoded.extend_from_slice(&encode::word_addr(record.account));
    encoded.extend_from_slice(&encode::word_u256(record.proposal_id));
    encoded.extend_from_slice(&encode::word_u64(record.block_number));
    keccak256(encoded)
}

fn activity_selection(
    scores: &[(Address, U256)],
    input: &SignerInput,
) -> (Vec<Address>, U256, bool) {
    let mut acc = B256::ZERO;
    let mut latest = BTreeMap::<Address, u64>::new();
    for (index, record) in input.activity.iter().enumerate() {
        let sequence = u64::try_from(index + 1).expect("activity witness length exceeds u64");
        assert!(
            record.block_number <= input.activity_checkpoint.block_number,
            "activity record after checkpoint"
        );
        acc = fold_activity(acc, sequence, record);
        latest
            .entry(record.account)
            .and_modify(|block| *block = (*block).max(record.block_number))
            .or_insert(record.block_number);
    }
    assert_eq!(
        input.activity_checkpoint.count,
        u64::try_from(input.activity.len()).expect("activity witness length exceeds u64"),
        "activity count mismatch"
    );
    assert_eq!(input.activity_checkpoint.acc, acc, "activity accumulator mismatch");

    let mut current = input.current_signers.clone();
    current.sort();
    current.dedup();
    assert!(!current.is_empty(), "current Safe owner set is empty");
    assert_eq!(current.len(), input.current_signers.len(), "duplicate current Safe owner");
    assert!(
        input.current_threshold >= U256::from(1u8)
            && input.current_threshold <= U256::from(current.len()),
        "invalid current Safe threshold"
    );

    // An empty chain is absence, not evidence of inactivity. Return the exact pre-rotation state.
    if input.activity_checkpoint.count == 0 {
        return (current, input.current_threshold, false);
    }

    let cutoff =
        input.activity_checkpoint.block_number.saturating_sub(input.selection.max_inactive_blocks);
    let fresh = latest
        .iter()
        .filter_map(|(account, block)| (*block >= cutoff).then_some(*account))
        .collect::<BTreeSet<_>>();
    let positive_scores = scores
        .iter()
        .filter_map(|(account, value)| (*value != U256::ZERO).then_some(*account))
        .collect::<BTreeSet<_>>();
    let witness_count = if input.was_initialized {
        current.iter().filter(|account| fresh.contains(*account)).count()
    } else {
        fresh.intersection(&positive_scores).count()
    };
    let minimum = input.selection.min_activity_witnesses as usize;
    if minimum < 2 || witness_count < minimum {
        return (current, input.current_threshold, false);
    }

    let active_scores =
        scores.iter().copied().filter(|(account, _)| fresh.contains(account)).collect::<Vec<_>>();
    let (signers, threshold) = select_signers(&active_scores, &input.selection);
    if signers.len() < minimum {
        return (current, input.current_threshold, false);
    }
    (signers, threshold, true)
}

/// Run the full signer-sync pipeline: folded edges + params + selection → signer journal + owner set.
/// Deterministic and float-free.
pub fn compute_signers(input: &SignerInput) -> SignerComputeResult {
    // Reuse the canonical root computation so the scores (and acc/leafCount/paramsHash) are
    // byte-identical to what the root producer proves for the same checkpoint.
    let base = compute::compute(&GuestInput {
        edges: input.edges.clone(),
        params: input.params.clone(),
        // The base computation carries no bounty recipient (`SignerSyncZkModule` pays none); its
        // binding words are unused here — the signer journal commits its OWN `instance_domain`
        // below (audit M-3), which `submitSignerProof` rebuilds from `address(this)` +
        // `block.chainid`. The base outputs consumed (`acc`/`leafCount`/`paramsHash`) are all
        // independent of the binding, so the default is not a silent hole.
        binding: Default::default(),
    });

    let selection_params_hash = encode::selection_params_hash(&input.selection);
    let (signers, target_threshold, activity_applied) = activity_selection(&base.scores, input);
    let current_signer_set_root = signer_set_root(&input.current_signers);
    let signer_set_root = signer_set_root(&signers);

    let journal = SignerJournal {
        acc: base.journal.acc,
        leaf_count: base.journal.leaf_count,
        params_hash: base.journal.params_hash,
        selection_params_hash,
        activity_acc: input.activity_checkpoint.acc,
        activity_count: input.activity_checkpoint.count,
        activity_block: input.activity_checkpoint.block_number,
        was_initialized: input.was_initialized,
        current_signer_set_root,
        current_threshold: input.current_threshold,
        signer_set_root,
        target_threshold,
        instance_domain: input.instance_domain,
    };
    SignerComputeResult { journal, signers, target_threshold, activity_applied, rank: base.rank }
}

/// The signer journal digest the on-chain `SignerSyncZkModule` binds.
pub fn signer_journal_digest(j: &SignerJournal) -> alloy_primitives::B256 {
    encode::signer_journal_digest(j)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{ActivityCheckpoint, SignerActivity};
    use alloy_primitives::U256;

    fn addr(b: u8) -> Address {
        Address::from([b; 20])
    }

    fn selection(top_n: u32, min_threshold: u32, target_threshold_bps: u32) -> SelectionParams {
        SelectionParams {
            top_n,
            min_threshold,
            target_threshold_bps,
            max_inactive_blocks: 151_200,
            min_activity_witnesses: 2,
        }
    }

    fn liveness_input(
        current_signers: Vec<Address>,
        current_threshold: u64,
        was_initialized: bool,
        activity: Vec<SignerActivity>,
        checkpoint_block: u64,
    ) -> SignerInput {
        let acc = activity.iter().enumerate().fold(B256::ZERO, |head, (index, record)| {
            fold_activity(head, (index + 1) as u64, record)
        });
        SignerInput {
            edges: Vec::new(),
            params: crate::tests::default_params(),
            selection: selection(5, 2, 5000),
            activity_checkpoint: ActivityCheckpoint {
                acc,
                count: activity.len() as u64,
                block_number: checkpoint_block,
            },
            activity_checkpoint_id: 0,
            activity,
            current_signers,
            current_threshold: U256::from(current_threshold),
            was_initialized,
            instance_domain: B256::ZERO,
        }
    }

    #[test]
    fn selects_top_n_by_value_desc_then_sorts_ascending() {
        // values: a=10, b=50, c=30, d=20 → top-3 by value = b,c,d → sorted asc = b(0x22),c(0x33),d(0x44)
        let scores = vec![
            (addr(0x11), U256::from(10u64)),
            (addr(0x22), U256::from(50u64)),
            (addr(0x33), U256::from(30u64)),
            (addr(0x44), U256::from(20u64)),
        ];
        let sp = selection(3, 1, 5000);
        let (signers, threshold) = select_signers(&scores, &sp);
        assert_eq!(signers, vec![addr(0x22), addr(0x33), addr(0x44)]);
        // ceil(5000*3/10000) = ceil(1.5) = 2
        assert_eq!(threshold, U256::from(2u64));
    }

    #[test]
    fn tie_break_is_address_ascending() {
        // a and b both have value 10; top_n 1 must pick the lower address deterministically.
        let scores = vec![(addr(0x44), U256::from(10u64)), (addr(0x11), U256::from(10u64))];
        let sp = selection(1, 1, 5000);
        let (signers, _) = select_signers(&scores, &sp);
        assert_eq!(signers, vec![addr(0x11)]);
    }

    #[test]
    fn threshold_clamped_to_min_and_count() {
        let scores = vec![(addr(0x11), U256::from(10u64)), (addr(0x22), U256::from(20u64))];
        // target 10% of 2 = 0.2 → ceil 1, but min_threshold 2 → clamp up to 2 (== n).
        let sp = selection(5, 2, 1000);
        let (signers, threshold) = select_signers(&scores, &sp);
        assert_eq!(signers.len(), 2);
        assert_eq!(threshold, U256::from(2u64));

        // min_threshold larger than count clamps down to count.
        let sp2 = selection(5, 9, 1000);
        let (_, threshold2) = select_signers(&scores, &sp2);
        assert_eq!(threshold2, U256::from(2u64));
    }

    #[test]
    fn empty_scores_yields_empty_set_zero_threshold() {
        let sp = selection(5, 1, 5000);
        let (signers, threshold) = select_signers(&[], &sp);
        assert!(signers.is_empty());
        assert_eq!(threshold, U256::ZERO);
    }

    #[test]
    fn fewer_accounts_than_top_n() {
        let scores = vec![(addr(0x11), U256::from(10u64))];
        let sp = selection(5, 1, 6000);
        let (signers, threshold) = select_signers(&scores, &sp);
        assert_eq!(signers, vec![addr(0x11)]);
        // ceil(6000*1/10000)=1, clamp [1,1] = 1
        assert_eq!(threshold, U256::from(1u64));
    }

    #[test]
    fn absent_activity_preserves_exact_safe_state() {
        let input = liveness_input(vec![addr(1), addr(2), addr(3)], 2, true, Vec::new(), 1_000);
        let scores = vec![(addr(4), U256::from(100)), (addr(5), U256::from(90))];
        let (signers, threshold, applied) = activity_selection(&scores, &input);
        assert_eq!(signers, vec![addr(1), addr(2), addr(3)]);
        assert_eq!(threshold, U256::from(2));
        assert!(!applied);
    }

    #[test]
    fn one_current_owner_cannot_activate_removals() {
        let activity = vec![
            SignerActivity { account: addr(1), proposal_id: U256::from(1), block_number: 1_000 },
            SignerActivity { account: addr(9), proposal_id: U256::from(1), block_number: 1_000 },
        ];
        let input = liveness_input(vec![addr(1), addr(2), addr(3)], 2, true, activity, 1_000);
        let scores = vec![(addr(1), U256::from(100)), (addr(9), U256::from(90))];
        let (signers, threshold, applied) = activity_selection(&scores, &input);
        assert_eq!(signers, vec![addr(1), addr(2), addr(3)]);
        assert_eq!(threshold, U256::from(2));
        assert!(!applied);
    }

    #[test]
    fn two_live_owners_replace_three_dead_with_lower_ranked_active_member() {
        let activity = vec![
            SignerActivity { account: addr(1), proposal_id: U256::from(7), block_number: 999 },
            SignerActivity { account: addr(2), proposal_id: U256::from(7), block_number: 1_000 },
            SignerActivity { account: addr(6), proposal_id: U256::from(7), block_number: 1_000 },
        ];
        let input = liveness_input(
            vec![addr(1), addr(2), addr(3), addr(4), addr(5)],
            3,
            true,
            activity,
            1_000,
        );
        let scores = vec![
            (addr(1), U256::from(100)),
            (addr(2), U256::from(90)),
            (addr(3), U256::from(80)),
            (addr(4), U256::from(70)),
            (addr(5), U256::from(60)),
            (addr(6), U256::from(10)),
        ];
        let (signers, threshold, applied) = activity_selection(&scores, &input);
        assert_eq!(signers, vec![addr(1), addr(2), addr(6)]);
        assert_eq!(threshold, U256::from(2));
        assert!(applied);
    }

    #[test]
    #[should_panic(expected = "activity accumulator mismatch")]
    fn omitted_activity_record_cannot_manufacture_absence() {
        let activity = vec![SignerActivity {
            account: addr(1),
            proposal_id: U256::from(1),
            block_number: 1_000,
        }];
        let mut input = liveness_input(vec![addr(1), addr(2)], 2, true, activity, 1_000);
        input.activity_checkpoint.acc = B256::from([0x55; 32]);
        let _ = activity_selection(&[(addr(1), U256::from(1))], &input);
    }
}
