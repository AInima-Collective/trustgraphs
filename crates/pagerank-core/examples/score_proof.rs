//! Print one account's score and OZ-compatible membership proof from a serialized guest input.
//!
//! This small host utility is used by the live-chain E2E to cast authenticated governance votes
//! against the root it just proved. It deliberately recomputes the canonical score set from the
//! same input instead of trusting an uncommitted side file.

use alloy_primitives::Address;
use pagerank_core::{compute, merkle, GuestInput};
use serde_json::json;
use std::{error::Error, str::FromStr};

fn main() -> Result<(), Box<dyn Error>> {
    let mut args = std::env::args().skip(1);
    let input_path = args.next().ok_or("usage: score_proof <input.json> <account>")?;
    let account =
        Address::from_str(&args.next().ok_or("usage: score_proof <input.json> <account>")?)?;
    if args.next().is_some() {
        return Err("usage: score_proof <input.json> <account>".into());
    }

    let input: GuestInput = serde_json::from_str(&std::fs::read_to_string(input_path)?)?;
    let result = compute::compute(&input);
    let value = result
        .scores
        .iter()
        .find_map(|(candidate, value)| (*candidate == account).then_some(*value))
        .ok_or("account has no positive score")?;
    let leaves = result
        .scores
        .iter()
        .map(|(candidate, score)| merkle::output_leaf(*candidate, *score))
        .collect::<Vec<_>>();
    let tree = merkle::build_tree(leaves);
    let proof = merkle::proof_for(&tree, merkle::output_leaf(account, value))
        .ok_or("score leaf is missing from computed tree")?;

    println!(
        "{}",
        serde_json::to_string(&json!({
            "account": format!("{account:#x}"),
            "value": value.to_string(),
            "proof": proof.iter().map(|node| format!("{node:#x}")).collect::<Vec<_>>(),
        }))?
    );
    Ok(())
}
