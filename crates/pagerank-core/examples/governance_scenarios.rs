//! Reproducible M2 governance-power scenarios for the default 40-member topology.
//!
//! Run with:
//! `cargo run -p pagerank-core --example governance_scenarios`

use alloy_primitives::U256;
use pagerank_core::pagerank::{calculate_generic, RankConfig};
use std::collections::{BTreeMap, BTreeSet};

const MEMBERS: u16 = 40;
const FABRICATED: u16 = 160;

fn scale() -> U256 {
    U256::from(10u64).pow(U256::from(18u64))
}

fn percent(value: U256) -> String {
    let hundredths = (value * U256::from(10_000u64) / scale()).to::<u64>();
    format!("{}.{:02}%", hundredths / 100, hundredths % 100)
}

fn scenario(
    founder_count: u16,
    include_fabricated: bool,
) -> (BTreeSet<u16>, Vec<u16>, Vec<u16>, BTreeMap<u16, U256>) {
    let founders: BTreeSet<_> = (1..=founder_count).collect();
    let members: Vec<_> = (100..100 + MEMBERS).collect();
    let fabricated: Vec<_> = (1_000..1_000 + FABRICATED).collect();
    let mut nodes: BTreeSet<_> = founders.iter().copied().chain(members.iter().copied()).collect();
    let mut outgoing = BTreeMap::<u16, BTreeMap<u16, U256>>::new();

    for (offset, founder) in founders.iter().enumerate() {
        outgoing.entry(*founder).or_default().insert(members[offset], U256::from(50u64));
    }
    for (offset, member) in members.iter().enumerate() {
        outgoing.entry(*member).or_default().extend([
            (members[(offset + 1) % members.len()], U256::from(50u64)),
            (members[(offset + 2) % members.len()], U256::from(50u64)),
        ]);
    }

    if include_fabricated {
        nodes.extend(fabricated.iter().copied());
        for (offset, account) in fabricated.iter().enumerate() {
            outgoing
                .entry(*account)
                .or_default()
                .insert(fabricated[(offset + 1) % fabricated.len()], U256::from(50u64));
        }
    }

    let cfg = RankConfig {
        damping_fp: scale() * U256::from(85u64) / U256::from(100u64),
        tolerance_fp: U256::from(1_000_000u64),
        max_iterations: 100,
        trust_share_fp: scale(),
        trust_decay_fp: scale() * U256::from(80u64) / U256::from(100u64),
        scale: scale(),
        seeds: founders.clone(),
    };
    let scores = calculate_generic(&nodes.into_iter().collect::<Vec<_>>(), &outgoing, &cfg);
    (founders, members, fabricated, scores)
}

fn main() {
    println!(
        "founders | max founder | all founders | fabricated bloc | top 1 / 3 / 5 / 10 ordinary"
    );
    for founder_count in [1u16, 3, 5] {
        let (founders, members, _, baseline) = scenario(founder_count, false);
        let (_, _, fabricated, attacked) = scenario(founder_count, true);
        for account in baseline.keys() {
            assert_eq!(baseline[account], attacked[account]);
        }
        assert_eq!(attacked.values().copied().sum::<U256>(), scale());

        let founder_scores: Vec<_> = founders.iter().map(|account| baseline[account]).collect();
        let mut ordinary_scores: Vec<_> = members.iter().map(|account| baseline[account]).collect();
        ordinary_scores.sort_by(|a, b| b.cmp(a));
        let coalition = |count: usize| ordinary_scores.iter().take(count).copied().sum::<U256>();
        let fabricated_total = fabricated.iter().map(|account| attacked[account]).sum::<U256>();

        println!(
            "{:>8} | {:>11} | {:>12} | {:>15} | {} / {} / {} / {}",
            founder_count,
            percent(founder_scores.iter().copied().max().unwrap()),
            percent(founder_scores.iter().copied().sum()),
            percent(fabricated_total),
            percent(coalition(1)),
            percent(coalition(3)),
            percent(coalition(5)),
            percent(coalition(10)),
        );
    }
}
