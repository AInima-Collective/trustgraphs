use alloy_primitives::{Address, B256, U256};
use pagerank_core::signer::{compute_signers, fold_activity};
use pagerank_core::{
    ActivityCheckpoint, Params, RawEdge, SelectionParams, SignerActivity, SignerInput,
};
fn addr(b: u8) -> Address {
    Address::from([b; 20])
}
#[test]
fn no_op_can_strand_singleton_bootstrap() {
    let s = U256::from(1_000_000_000_000_000_000u64);
    let params = Params {
        damping_fp: s * U256::from(85) / U256::from(100),
        tolerance_fp: s / U256::from(1_000_000),
        max_iterations: 100,
        min_weight_fp: U256::ZERO,
        max_weight_fp: s * U256::from(100),
        trust_share_fp: s,
        trust_decay_fp: s * U256::from(80) / U256::from(100),
        trusted_seeds: vec![addr(1)],
        total_pool: s * U256::from(1_000_000),
        precision_scale: s,
        schema_uid: B256::from([0xab; 32]),
        weight_field_index: 1,
        envelope0_domain_separators: vec![],
        lane2_max_head_age: 0,
        accumulator: addr(0xac),
        chain_id: 31337,
    };
    let mut data = vec![0; 64];
    data[32..].copy_from_slice(&U256::from(50).to_be_bytes::<32>());
    let edges = vec![RawEdge {
        kind: 0,
        attester: addr(1),
        recipient: addr(2),
        uid: B256::from([1; 32]),
        block_timestamp: 100,
        data,
    }];
    let first = SignerActivity { account: addr(1), proposal_id: U256::from(1), block_number: 1000 };
    let mut input = SignerInput {
        edges,
        params,
        selection: SelectionParams {
            top_n: 5,
            min_threshold: 2,
            target_threshold_bps: 5000,
            max_inactive_blocks: 151200,
            min_activity_witnesses: 2,
        },
        activity: vec![first],
        activity_checkpoint: ActivityCheckpoint {
            acc: fold_activity(B256::ZERO, 1, &first),
            count: 1,
            block_number: 1000,
        },
        activity_checkpoint_id: 0,
        current_signers: vec![addr(1)],
        current_threshold: U256::from(1),
        was_initialized: false,
        instance_domain: B256::from([0x99; 32]),
    };
    let first_result = compute_signers(&input);
    assert!(!first_result.activity_applied);
    assert_eq!(first_result.signers, vec![addr(1)]);
    println!(
        "first valid guest result: applied={}, owner_count={}, threshold={}",
        first_result.activity_applied,
        first_result.signers.len(),
        first_result.target_threshold
    );
    let second =
        SignerActivity { account: addr(2), proposal_id: U256::from(1), block_number: 1001 };
    input.activity.push(second);
    input.activity_checkpoint = ActivityCheckpoint {
        acc: fold_activity(input.activity_checkpoint.acc, 2, &second),
        count: 2,
        block_number: 1001,
    };
    let before = compute_signers(&input);
    assert!(before.activity_applied);
    assert_eq!(before.signers.len(), 2);
    input.was_initialized = true;
    let after = compute_signers(&input);
    assert!(!after.activity_applied);
    assert_eq!(after.signers, vec![addr(1)]);
    println!("two live positive-score members: uninitialized applied={} owners={}; after no-op initialization applied={} owners={}",before.activity_applied,before.signers.len(),after.activity_applied,after.signers.len());
}
