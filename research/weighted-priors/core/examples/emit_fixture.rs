use alloy_primitives::Address;
use weighted_prior_research::{
    canonical_manifest, manifest_digest, normalize, prior_leaf, prior_root, RawPriorEntry,
};

fn main() {
    let raw = vec![
        RawPriorEntry { account: Address::from([0x11; 20]), weight: "10".into() },
        RawPriorEntry { account: Address::from([0x22; 20]), weight: "2.5".into() },
        RawPriorEntry { account: Address::from([0x33; 20]), weight: "1".into() },
    ];
    let normalized = normalize(&raw).unwrap();
    let manifest = canonical_manifest(10, &normalized).unwrap();
    println!("normalized={normalized:?}");
    println!(
        "leaves={:?}",
        normalized.iter().map(|entry| format!("{:#x}", prior_leaf(entry))).collect::<Vec<_>>()
    );
    println!("root={:#x}", prior_root(&normalized).unwrap());
    println!("manifest=0x{}", hex::encode(&manifest));
    println!("digest=0x{}", hex::encode(manifest_digest(&manifest)));
}
