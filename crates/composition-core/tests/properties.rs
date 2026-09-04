use composition_core::{fixture::mixed_input, hamilton::apportion};
use proptest::prelude::*;

proptest! {
    #[test]
    fn hamilton_conserves_pool_and_is_order_independent(
        a in 1u64..1_000_000,
        b in 1u64..1_000_000,
        c in 1u64..1_000_000,
        pool in 0u64..10_000_000,
    ) {
        let denominator = a as u128 + b as u128 + c as u128;
        let forward = apportion(
            pool as u128,
            denominator,
            &[(1u8, a as u128), (2u8, b as u128), (3u8, c as u128)],
        ).unwrap();
        let reversed = apportion(
            pool as u128,
            denominator,
            &[(3u8, c as u128), (2u8, b as u128), (1u8, a as u128)],
        ).unwrap();
        prop_assert_eq!(&forward, &reversed);
        prop_assert_eq!(
            forward.iter().map(|item| item.allocation).sum::<u128>(),
            pool as u128,
        );
    }
}

#[test]
fn allocating_a_source_its_total_reproduces_every_value() {
    let input = mixed_input();
    let manifest = composition_core::codec::parse_capture_manifest(&input.manifest, 10).unwrap();
    for (source, preimage) in manifest.sources.iter().zip(&input.source_preimages) {
        let entries = composition_core::blob::decode_canonical_score_blob(&preimage.blob).unwrap();
        let result = apportion(source.total_value, source.total_value, &entries).unwrap();
        assert_eq!(
            result.into_iter().map(|item| (item.key, item.allocation)).collect::<Vec<_>>(),
            entries
        );
    }
}
