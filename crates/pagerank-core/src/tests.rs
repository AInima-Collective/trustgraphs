//! Shared test helpers + end-to-end determinism / invariant tests.

use crate::compute::compute;
use crate::pagerank;
use crate::pagerank_oracle;
use crate::pagerank_test_support::{generated_case, DIFFERENTIAL_SEEDS};
use crate::{GuestInput, Params, RawEdge};
use alloy_primitives::{Address, B256, U256};

/// S = 1e18.
pub(crate) fn scale() -> U256 {
    U256::from(10u64).pow(U256::from(18u64))
}

/// A fixed-point fraction `num/den * S`.
fn fp(num: u64, den: u64) -> U256 {
    scale() * U256::from(num) / U256::from(den)
}

/// Default params (no trust), mirroring `PageRankConfig::default()`.
pub(crate) fn default_params() -> Params {
    let s = scale();
    Params {
        damping_fp: fp(85, 100),                    // 0.85
        tolerance_fp: s / U256::from(1_000_000u64), // 1e-6
        max_iterations: 100,
        min_weight_fp: U256::ZERO,             // 0
        max_weight_fp: U256::from(100u64) * s, // 100
        trust_share_fp: U256::ZERO,
        trust_decay_fp: U256::ZERO,
        trusted_seeds: vec![],
        total_pool: U256::from(1_000_000_000_000_000_000_000_000u128), // 1e24
        precision_scale: s,
        schema_uid: B256::ZERO,
        weight_field_index: 1,
        envelope0_domain_separators: vec![],
        lane2_max_head_age: 0,
        // Params-schema v2 domain separation; the compute pipeline ignores both fields (they only
        // enter `params_hash`), so the default helper leaves them zero. Tests that care about
        // separation set them explicitly (see `params_hash_domain_separates_instances`).
        accumulator: Address::ZERO,
        chain_id: 0,
    }
}

/// Params with a trust configuration (mirrors `TrustConfig::new`).
pub(crate) fn trust_params(seeds: Vec<Address>) -> Params {
    let s = scale();
    Params {
        trust_share_fp: s,           // 1.0
        trust_decay_fp: fp(80, 100), // 0.8
        trusted_seeds: seeds,
        ..default_params()
    }
}

fn addr(b: u8) -> Address {
    Address::from([b; 20])
}

/// Build an edge with a given confidence (weight) in ABI head slot 1.
fn edge(from: u8, to: u8, uid: u8, ts: u64, weight: u64) -> RawEdge {
    let mut data = vec![0u8; 64];
    data[32..64].copy_from_slice(&U256::from(weight).to_be_bytes::<32>());
    RawEdge {
        kind: 0,
        attester: addr(from),
        recipient: addr(to),
        uid: B256::from([uid; 32]),
        block_timestamp: ts,
        data,
    }
}

fn sample_input() -> GuestInput {
    // Alice -> Bob -> Charlie -> Alice, symmetric ring, all weight 1.
    let edges = vec![edge(1, 2, 1, 100, 1), edge(2, 3, 2, 101, 1), edge(3, 1, 3, 102, 1)];
    GuestInput { edges, params: default_params(), binding: Default::default() }
}

#[test]
fn compute_is_deterministic() {
    let input = sample_input();
    let a = compute(&input);
    let b = compute(&input);
    assert_eq!(a.journal, b.journal);
    assert_eq!(a.scores, b.scores);
    assert_eq!(a.cid, b.cid);
}

#[test]
fn symmetric_ring_scores_are_equal_and_pool_conserved() {
    let input = sample_input();
    let r = compute(&input);
    // Three nodes, symmetric ⇒ near-equal values; total equals the pool.
    assert_eq!(r.scores.len(), 3);
    assert_eq!(r.journal.total_value, input.params.total_pool);
    let vals: Vec<U256> = r.scores.iter().map(|(_, v)| *v).collect();
    // pairwise within 0.1% (rounding + last-absorbs-remainder)
    let max = vals.iter().copied().max().unwrap();
    let min = vals.iter().copied().min().unwrap();
    let tol = input.params.total_pool / U256::from(1000u64);
    assert!(max - min <= tol, "ring scores should be ~equal: {min} vs {max}");
}

#[test]
fn journal_binds_inputs() {
    let input = sample_input();
    let r = compute(&input);
    // leafCount matches edge count; acc is non-zero for non-empty input.
    assert_eq!(r.journal.leaf_count, 3);
    assert_ne!(r.journal.acc, B256::ZERO);
    assert_ne!(r.journal.output_root, B256::ZERO);
    assert!(r.cid.starts_with("bafkrei"));
}

#[test]
fn seeded_cycle_distributes_the_full_pool() {
    // Alice (seed) -> Bob, Bob -> Charlie, Charlie -> Alice.
    let edges = vec![edge(1, 2, 1, 100, 1), edge(2, 3, 2, 101, 1), edge(3, 1, 3, 102, 1)];
    let input =
        GuestInput { edges, params: trust_params(vec![addr(1)]), binding: Default::default() };
    let r = compute(&input);
    assert_eq!(r.journal.total_value, input.params.total_pool);
    // Everyone is reachable; pool fully distributed among 3.
    assert_eq!(r.scores.len(), 3);
}

/// Params-schema v2 domain separation (INSTANCE_FACTORY §6.1). Two factory clones with identical
/// seeds, identical params, and identical (empty-genesis) edge sets used to produce the identical
/// journal digest, so either could submit the other's proof. Binding the accumulator address and
/// the chain id into `params_hash` — which `MerkleSnapshot.submitProof` folds into the digest it
/// verifies — makes the two journals disjoint. The compute pipeline must stay indifferent to both
/// fields: they separate domains, they do not change scores.
#[test]
fn params_hash_domain_separates_instances() {
    let base = default_params();

    let mut instance_a = base.clone();
    instance_a.accumulator = addr(0xA1);
    instance_a.chain_id = 1;

    let mut instance_b = base.clone();
    instance_b.accumulator = addr(0xB2);
    instance_b.chain_id = 1;

    // Same instance, mirrored onto another chain.
    let mut mirror_a = instance_a.clone();
    mirror_a.chain_id = 10;

    let h = crate::encode::params_hash;
    assert_ne!(h(&instance_a), h(&instance_b), "clones must not share a paramsHash");
    assert_ne!(h(&instance_a), h(&mirror_a), "chains must not share a paramsHash");
    assert_ne!(h(&base), h(&instance_a), "v2 fields must be part of the hash");

    // ...and the separation is hash-only: identical edge sets still score identically.
    let edges = vec![edge(1, 2, 1, 100, 1), edge(2, 3, 2, 101, 1)];
    let a = compute(&GuestInput {
        edges: edges.clone(),
        params: instance_a,
        binding: Default::default(),
    });
    let b = compute(&GuestInput { edges, params: instance_b, binding: Default::default() });
    assert_eq!(a.journal.output_root, b.journal.output_root);
    assert_ne!(a.journal.params_hash, b.journal.params_hash);
    assert_ne!(
        crate::encode::journal_digest(&a.journal),
        crate::encode::journal_digest(&b.journal),
        "a proof for one instance must not verify against the other's snapshot"
    );
}

#[test]
fn empty_input_is_valid() {
    let input = GuestInput { edges: vec![], params: default_params(), binding: Default::default() };
    let r = compute(&input);
    assert_eq!(r.journal.leaf_count, 0);
    assert_eq!(r.journal.acc, B256::ZERO);
    assert_eq!(r.journal.output_root, B256::ZERO);
    assert_eq!(r.journal.total_value, U256::ZERO);
    assert_eq!(r.scores.len(), 0);
    // empty blob is "{}"
    assert_eq!(r.blob, b"{}");
}

#[test]
fn current_fixed_point_kernel_matches_frozen_pull_oracle() {
    for (index, seed) in DIFFERENTIAL_SEEDS.into_iter().enumerate() {
        let case = generated_case(seed, 8 + index * 3, 2 + index % 5, 2, index % 4);
        let expected = pagerank_oracle::calculate(&case.nodes, &case.outgoing, &case.config);
        let actual = pagerank::calculate_generic(&case.nodes, &case.outgoing, &case.config);
        assert_eq!(actual, expected, "fixed-point oracle mismatch for seed {seed:#018x}");
    }
}

/// The retired floating-point implementation's deterministic seed-0 input remains frozen here.
/// M2 intentionally rotates its output: seed-only starting mass and the reachability gate remove
/// one disconnected account. Keep both expectations so that change remains explicit.
#[test]
fn legacy_float_fixture_records_intentional_m2_rotation() {
    struct Lcg(u64);
    impl Lcg {
        fn next(&mut self, bound: u64) -> u64 {
            self.0 = self
                .0
                .wrapping_mul(6_364_136_223_846_793_005)
                .wrapping_add(1_442_695_040_888_963_407);
            (self.0 >> 33) % bound
        }
    }

    let mut lcg = Lcg(0x9E37_79B9_7F4A_7C15);
    let edges = (0u8..30)
        .map(|uid| {
            let from = lcg.next(12) as u8 + 1;
            let to = lcg.next(12) as u8 + 1;
            let weight = lcg.next(100) + 1;
            edge(from, to, uid + 1, 1_000 + u64::from(uid), weight)
        })
        .collect();
    let input = GuestInput {
        edges,
        params: trust_params(vec![addr(1), addr(2)]),
        binding: Default::default(),
    };
    let actual: Vec<U256> = compute(&input).scores.into_iter().map(|(_, value)| value).collect();
    let legacy: Vec<U256> = [
        68_526_411_158_466_950_801_704u128,
        65_071_390_428_342_570_055_420,
        88_060_528_363_170_179_021_074,
        75_088_450_530_703_184_219_105,
        81_277_487_664_925_989_555_937,
        116_681_700_090_200_541_203_247,
        19_794_118_764_712_588_275_534,
        98_072_588_435_530_613_183_679,
        67_148_402_890_417_342_504_055,
        107_211_643_269_859_619_157_714,
        158_324_949_949_699_698_198_189,
        54_742_328_453_970_723_824_342,
    ]
    .into_iter()
    .map(U256::from)
    .collect();

    let expected_m2: Vec<U256> = [
        185_701_928_509_642_548_212_741u128,
        169_625_848_129_240_646_203_231,
        40_975_204_876_024_380_121_900,
        66_185_330_926_654_633_273_166,
        83_308_416_542_082_710_413_552,
        70_906_354_531_772_658_863_294,
        72_675_363_376_816_884_084_420,
        39_868_199_340_996_704_983_529,
        79_469_397_346_986_734_933_674,
        143_929_719_648_598_242_991_214,
        47_354_236_771_183_855_919_279,
    ]
    .into_iter()
    .map(U256::from)
    .collect();

    assert_ne!(actual, legacy);
    assert_eq!(actual, expected_m2);
}
