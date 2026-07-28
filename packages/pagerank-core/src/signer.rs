//! Safe signer-sync selection: derive the Safe owner set + threshold from the governance weights.
//!
//! This is the signer-sync analogue of [`crate::compute`]: it runs the exact same fixed-point
//! Trust-Aware PageRank (so the selection is bound to the same `(acc, leafCount, paramsHash)`
//! commitment as the root producer), then applies a deterministic top-N selection rule. It is
//! float-free and deterministic so the SP1 guest, host, and browser all agree byte-for-byte.

use crate::{compute, encode, merkle};
use crate::{GuestInput, SelectionParams, SignerComputeResult, SignerInput, SignerJournal};
use alloy_primitives::{Address, U256};

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

/// Run the full signer-sync pipeline: folded edges + params + selection → signer journal + owner set.
/// Deterministic and float-free.
pub fn compute_signers(input: &SignerInput) -> SignerComputeResult {
    // Reuse the canonical root computation so the scores (and acc/leafCount/paramsHash) are
    // byte-identical to what the root producer proves for the same checkpoint.
    let base = compute::compute(&GuestInput {
        edges: input.edges.clone(),
        params: input.params.clone(),
        // The signer journal has no lane-2 fields to bind, so signer selection is lane-1-only
        // until its journal shape deliberately grows (a vkey + module event, not a default).
        lane2: None,
        // Nor does it carry the v3 bindings: `SignerSyncZkModule` pays no bounty and there is
        // exactly one module per trust instance, so the recipient/domain words have nothing to
        // bind to. The base computation only supplies `acc`/`leafCount`/`paramsHash` here, all
        // three independent of the binding, so the default is not a silent hole.
        binding: Default::default(),
    });

    let selection_params_hash = encode::selection_params_hash(&input.selection);
    let (signers, target_threshold) = select_signers(&base.scores, &input.selection);
    let signer_set_root = signer_set_root(&signers);

    let journal = SignerJournal {
        acc: base.journal.acc,
        leaf_count: base.journal.leaf_count,
        params_hash: base.journal.params_hash,
        selection_params_hash,
        signer_set_root,
        target_threshold,
    };
    SignerComputeResult { journal, signers, target_threshold }
}

/// The signer journal digest the on-chain `SignerSyncZkModule` binds.
pub fn signer_journal_digest(j: &SignerJournal) -> alloy_primitives::B256 {
    encode::signer_journal_digest(j)
}

#[cfg(test)]
mod tests {
    use super::*;
    use alloy_primitives::U256;

    fn addr(b: u8) -> Address {
        Address::from([b; 20])
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
        let sp = SelectionParams { top_n: 3, min_threshold: 1, target_threshold_bps: 5000 };
        let (signers, threshold) = select_signers(&scores, &sp);
        assert_eq!(signers, vec![addr(0x22), addr(0x33), addr(0x44)]);
        // ceil(5000*3/10000) = ceil(1.5) = 2
        assert_eq!(threshold, U256::from(2u64));
    }

    #[test]
    fn tie_break_is_address_ascending() {
        // a and b both have value 10; top_n 1 must pick the lower address deterministically.
        let scores = vec![(addr(0x44), U256::from(10u64)), (addr(0x11), U256::from(10u64))];
        let sp = SelectionParams { top_n: 1, min_threshold: 1, target_threshold_bps: 5000 };
        let (signers, _) = select_signers(&scores, &sp);
        assert_eq!(signers, vec![addr(0x11)]);
    }

    #[test]
    fn threshold_clamped_to_min_and_count() {
        let scores = vec![(addr(0x11), U256::from(10u64)), (addr(0x22), U256::from(20u64))];
        // target 10% of 2 = 0.2 → ceil 1, but min_threshold 2 → clamp up to 2 (== n).
        let sp = SelectionParams { top_n: 5, min_threshold: 2, target_threshold_bps: 1000 };
        let (signers, threshold) = select_signers(&scores, &sp);
        assert_eq!(signers.len(), 2);
        assert_eq!(threshold, U256::from(2u64));

        // min_threshold larger than count clamps down to count.
        let sp2 = SelectionParams { top_n: 5, min_threshold: 9, target_threshold_bps: 1000 };
        let (_, threshold2) = select_signers(&scores, &sp2);
        assert_eq!(threshold2, U256::from(2u64));
    }

    #[test]
    fn empty_scores_yields_empty_set_zero_threshold() {
        let sp = SelectionParams { top_n: 5, min_threshold: 1, target_threshold_bps: 5000 };
        let (signers, threshold) = select_signers(&[], &sp);
        assert!(signers.is_empty());
        assert_eq!(threshold, U256::ZERO);
    }

    #[test]
    fn fewer_accounts_than_top_n() {
        let scores = vec![(addr(0x11), U256::from(10u64))];
        let sp = SelectionParams { top_n: 5, min_threshold: 1, target_threshold_bps: 6000 };
        let (signers, threshold) = select_signers(&scores, &sp);
        assert_eq!(signers, vec![addr(0x11)]);
        // ceil(6000*1/10000)=1, clamp [1,1] = 1
        assert_eq!(threshold, U256::from(1u64));
    }
}
