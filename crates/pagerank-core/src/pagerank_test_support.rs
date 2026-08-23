//! Deterministic graph corpus shared by the M1 differential and benchmark tests.

use crate::pagerank::RankConfig;
use alloy_primitives::U256;
use std::collections::{BTreeMap, BTreeSet};

pub(crate) const DIFFERENTIAL_SEEDS: [u64; 10] = [
    0x243f_6a88_85a3_08d3,
    0x1319_8a2e_0370_7344,
    0xa409_3822_299f_31d0,
    0x082e_fa98_ec4e_6c89,
    0x4528_21e6_38d0_1377,
    0xbe54_66cf_34e9_0c6c,
    0xc0ac_29b7_c97c_50dd,
    0x3f84_d5b5_b547_0917,
    0x9216_d5d9_8979_fb1b,
    0xd131_0ba6_98df_b5ac,
];

#[derive(Clone, Debug)]
pub(crate) struct GeneratedCase {
    pub nodes: Vec<u32>,
    pub outgoing: BTreeMap<u32, BTreeMap<u32, U256>>,
    pub config: RankConfig<u32>,
}

struct Lcg(u64);

impl Lcg {
    fn next(&mut self) -> u64 {
        self.0 =
            self.0.wrapping_mul(6_364_136_223_846_793_005).wrapping_add(1_442_695_040_888_963_407);
        self.0
    }

    fn bounded(&mut self, bound: usize) -> usize {
        if bound == 0 {
            return 0;
        }
        ((self.next() >> 32) as usize) % bound
    }
}

/// Build a closed graph. `unreachable_tail` reserves a suffix with edges only within that suffix,
/// making it unreachable from the trusted seeds in the prefix.
pub(crate) fn generated_case(
    seed: u64,
    node_count: usize,
    max_out_degree: usize,
    seed_count: usize,
    unreachable_tail: usize,
) -> GeneratedCase {
    assert!(node_count > 0);
    assert!(seed_count <= node_count.saturating_sub(unreachable_tail));
    assert!(unreachable_tail <= node_count);

    let scale = U256::from(10u64).pow(U256::from(18u64));
    let nodes: Vec<u32> = (0..node_count as u32).collect();
    let trusted: BTreeSet<u32> = nodes.iter().copied().take(seed_count).collect();
    let reachable_end = node_count - unreachable_tail;
    let mut random = Lcg(seed);
    let mut outgoing = BTreeMap::new();

    for source in 0..node_count {
        let degree = 1 + random.bounded(max_out_degree.max(1));
        let (start, width) = if source < reachable_end {
            (0usize, reachable_end)
        } else {
            (reachable_end, unreachable_tail)
        };
        let mut row = BTreeMap::new();
        for _ in 0..degree {
            let target = start + random.bounded(width);
            // Include zeroes and self-loops in the corpus; both are ignored by the kernel.
            let weight = U256::from(random.bounded(101) as u64);
            row.insert(target as u32, weight);
        }
        outgoing.insert(source as u32, row);
    }

    GeneratedCase {
        nodes,
        outgoing,
        config: RankConfig {
            damping_fp: scale * U256::from(85u64) / U256::from(100u64),
            tolerance_fp: scale / U256::from(1_000_000u64),
            max_iterations: 40,
            trust_share_fp: if seed_count == 0 {
                U256::ZERO
            } else {
                scale * U256::from(15 + random.bounded(86) as u64) / U256::from(100u64)
            },
            trust_decay_fp: scale * U256::from(60 + random.bounded(41) as u64) / U256::from(100u64),
            scale,
            seeds: trusted,
        },
    }
}

#[test]
fn generated_corpus_is_closed_and_reproducible() {
    for (index, seed) in DIFFERENTIAL_SEEDS.into_iter().enumerate() {
        let a = generated_case(seed, 12 + index, 5, 2, index % 4);
        let b = generated_case(seed, 12 + index, 5, 2, index % 4);
        assert_eq!(a.nodes, b.nodes);
        assert_eq!(a.outgoing, b.outgoing);
        assert_eq!(a.config.trust_share_fp, b.config.trust_share_fp);

        let node_set: BTreeSet<_> = a.nodes.iter().copied().collect();
        for (source, row) in &a.outgoing {
            assert!(node_set.contains(source));
            assert!(row.keys().all(|target| node_set.contains(target)));
        }
    }
}

/// Reproducible native timing harness for the M1 review boundary. It is ignored in ordinary CI
/// because the frozen pull oracle intentionally becomes slow at the largest sizes.
#[test]
#[ignore = "benchmark: run with cargo test -p pagerank-core --release m1_native_push_benchmark -- --ignored --nocapture"]
fn m1_native_push_benchmark() {
    use crate::{pagerank, pagerank_oracle};
    use std::hint::black_box;
    use std::time::Instant;

    let connected = [
        (100usize, 6usize, 0usize),
        (200, 4, 0),
        (400, 8, 0),
        (800, 6, 0),
        (1_600, 6, 0),
        (3_200, 6, 0),
    ];
    let unreachable = [(100usize, 6usize, 40usize), (400, 6, 160), (800, 6, 320), (1_600, 6, 640)];

    println!("kind,nodes,max_degree,unreachable,seed,pull_us,push_us,speedup");
    for (index, (nodes, degree, tail)) in connected.into_iter().chain(unreachable).enumerate() {
        let seed = DIFFERENTIAL_SEEDS[index % DIFFERENTIAL_SEEDS.len()];
        let case = generated_case(seed, nodes, degree, 2, tail);

        let started = Instant::now();
        let expected = black_box(pagerank_oracle::calculate(
            black_box(&case.nodes),
            black_box(&case.outgoing),
            black_box(&case.config),
        ));
        let pull = started.elapsed();

        let started = Instant::now();
        let actual = black_box(pagerank::calculate_generic(
            black_box(&case.nodes),
            black_box(&case.outgoing),
            black_box(&case.config),
        ));
        let push = started.elapsed();
        assert_eq!(actual, expected, "benchmark output changed for seed {seed:#018x}");

        let speedup = pull.as_secs_f64() / push.as_secs_f64();
        println!(
            "{},{nodes},{degree},{tail},{seed:#018x},{},{},{speedup:.2}",
            if tail == 0 { "connected" } else { "unreachable" },
            pull.as_micros(),
            push.as_micros(),
        );
    }
}
