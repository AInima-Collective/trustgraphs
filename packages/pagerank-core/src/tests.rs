//! Shared test helpers + end-to-end determinism / invariant tests.

use crate::compute::compute;
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
        min_weight_fp: U256::ZERO,                 // 0
        max_weight_fp: U256::from(100u64) * s,     // 100
        trust_multiplier_fp: U256::from(2u64) * s, // unused when no seeds
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
        trust_multiplier_fp: U256::from(2u64) * s, // 2.0
        trust_share_fp: fp(15, 100),               // 0.15
        trust_decay_fp: fp(80, 100),               // 0.8
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
    GuestInput { edges, params: default_params(), lane2: None, binding: Default::default() }
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
fn trust_boosts_seed_neighbour() {
    // Alice (seed) -> Bob, Bob -> Charlie, Charlie -> Alice.
    let edges = vec![edge(1, 2, 1, 100, 1), edge(2, 3, 2, 101, 1), edge(3, 1, 3, 102, 1)];
    let input = GuestInput {
        edges,
        params: trust_params(vec![addr(1)]),
        lane2: None,
        binding: Default::default(),
    };
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
        lane2: None,
        binding: Default::default(),
    });
    let b = compute(&GuestInput {
        edges,
        params: instance_b,
        lane2: None,
        binding: Default::default(),
    });
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
    let input = GuestInput {
        edges: vec![],
        params: default_params(),
        lane2: None,
        binding: Default::default(),
    };
    let r = compute(&input);
    assert_eq!(r.journal.leaf_count, 0);
    assert_eq!(r.journal.acc, B256::ZERO);
    assert_eq!(r.journal.output_root, B256::ZERO);
    assert_eq!(r.journal.total_value, U256::ZERO);
    assert_eq!(r.scores.len(), 0);
    // empty blob is "{}"
    assert_eq!(r.blob, b"{}");
}

// ---------------------------------------------------------------------------
// Two-lane compute: a real envelope-0 fixture through the FULL pipeline, plus
// the withholding path (GOAL M2 exit: anchored head, data withheld → rule Φ,
// skip recorded, root still lands).
// ---------------------------------------------------------------------------

mod lane2_compute {
    use super::*;
    use crate::{skip_reason, AnchorRecord, Lane2Witness};
    use alloy_primitives::keccak256;
    use envelopes::eas_offchain::{
        self, attest_struct_hash, eip712_digest, head_payload, offchain_uid_v2, Envelope0Witness,
        LogEntry, OffchainAttestation, ENTRY_ATTEST,
    };
    use envelopes::ecdsa::eip191_digest32;
    use k256::ecdsa::SigningKey;
    use zk_core::anchor::{skip_leaf, skipped_digest, SkipEntry};
    use zk_core::fold::fold;

    fn sign_prehash(sk: &SigningKey, prehash: &B256) -> Vec<u8> {
        let (sig, _) = sk.sign_prehash_recoverable(prehash.as_slice()).unwrap();
        let sig = sig.normalize_s().unwrap_or(sig);
        for v in 0u8..=1 {
            let rid = k256::ecdsa::RecoveryId::from_byte(v).unwrap();
            if let Ok(vk) =
                k256::ecdsa::VerifyingKey::recover_from_prehash(prehash.as_slice(), &sig, rid)
            {
                if vk == *sk.verifying_key() {
                    let mut out = sig.to_bytes().to_vec();
                    out.push(v);
                    return out;
                }
            }
        }
        unreachable!("one recovery id must match");
    }

    fn eth_addr(sk: &SigningKey) -> Address {
        let unc = sk.verifying_key().to_encoded_point(false);
        let h = keccak256(&unc.as_bytes()[1..]);
        Address::from_slice(&h[12..])
    }

    fn lane2_params(ds: B256) -> Params {
        let mut p = default_params();
        p.envelope0_domain_separators = vec![ds];
        p.lane2_max_head_age = 10_000;
        p
    }

    /// Build a signed one-attestation envelope-0 log for `sk`, returning (witness, head).
    fn one_edge_log(
        sk: &SigningKey,
        ds: B256,
        schema: B256,
        to: u8,
        conf: u64,
    ) -> (Envelope0Witness, B256) {
        let mut data = vec![0u8; 64];
        data[32..].copy_from_slice(&U256::from(conf).to_be_bytes::<32>());
        let mut a = OffchainAttestation {
            version: 2,
            schema,
            recipient: addr(to),
            time: 500,
            expiration_time: 0,
            revocable: true,
            ref_uid: B256::ZERO,
            data,
            salt: B256::from([0x77; 32]),
            signature: vec![],
        };
        a.signature = sign_prehash(sk, &eip712_digest(ds, attest_struct_hash(&a)));
        let uid = offchain_uid_v2(&a);
        let entries = vec![LogEntry { kind: ENTRY_ATTEST, uid }];
        let head = eas_offchain::log_head(&entries);
        let head_signature =
            sign_prehash(sk, &eip191_digest32(&head_payload(head, entries.len() as u64)));
        (
            Envelope0Witness {
                owner: eth_addr(sk),
                entries,
                attestations: vec![a],
                head_signature,
            },
            head,
        )
    }

    #[test]
    fn two_lane_compute_merges_lanes_and_commits_anchor_acc() {
        let ds = keccak256(b"test-domain");
        let params = lane2_params(ds);
        let sk = SigningKey::from_slice(&[0x42u8; 32]).unwrap();
        let owner = eth_addr(&sk);
        let (w, head) = one_edge_log(&sk, ds, params.schema_uid, 9, 60);

        // Lane 1: one edge 1 -> 2. Lane 2: owner -> 0x09.
        let input = GuestInput {
            edges: vec![edge(1, 2, 1, 100, 50)],
            params,
            lane2: Some(Lane2Witness {
                anchors: vec![AnchorRecord {
                    node_id: eas_offchain::address_node_id(owner),
                    envelope_kind: 0,
                    head,
                    // H-5: the anchored count must equal the log length the owner co-signed.
                    count: 1,
                    data_commitment: B256::ZERO,
                    block_timestamp: 1000,
                }],
                envelopes: vec![w],
            }),
            binding: Default::default(),
        };
        let r = compute(&input);

        // Both lanes committed: lane 1 acc as usual, lane 2 anchor fold nonzero, no skips.
        assert_eq!(r.journal.leaf_count, 1);
        assert_eq!(r.journal.anchor_count, 1);
        assert_ne!(r.journal.anchor_acc, B256::ZERO);
        assert_eq!(r.journal.skipped_digest, B256::ZERO);
        // The lane-2 attester + recipient are scored nodes (graph merged both lanes).
        let scored: Vec<Address> = r.scores.iter().map(|(a, _)| *a).collect();
        assert!(scored.contains(&owner), "lane-2 attester missing from scores");
        assert!(scored.contains(&addr(9)), "lane-2 recipient missing from scores");
        assert!(scored.contains(&addr(2)), "lane-1 recipient missing from scores");
    }

    #[test]
    fn withheld_head_degrades_and_root_still_lands() {
        let ds = keccak256(b"test-domain");
        let params = lane2_params(ds);
        let node = B256::from([0x33; 32]);

        // Anchored head, data withheld (no envelope witness).
        let input = GuestInput {
            edges: vec![edge(1, 2, 1, 100, 50)],
            params,
            lane2: Some(Lane2Witness {
                anchors: vec![AnchorRecord {
                    node_id: node,
                    envelope_kind: 0,
                    head: B256::from([0x44; 32]),
                    count: 0,
                    data_commitment: B256::ZERO,
                    block_timestamp: 1000,
                }],
                envelopes: vec![],
            }),
            binding: Default::default(),
        };
        let r = compute(&input);

        // The epoch did NOT abort: lane 1 scored, root landed.
        assert_ne!(r.journal.output_root, B256::ZERO);
        assert_eq!(r.journal.anchor_count, 1);
        // The skip is publicly committed with the exact expected preimage.
        let expected = skipped_digest(&[SkipEntry {
            node_id: node,
            reason: skip_reason::DROPPED,
            epoch_observed: 1000,
        }]);
        assert_eq!(r.journal.skipped_digest, expected);
        assert_ne!(r.journal.skipped_digest, B256::ZERO);
        // And the digest is reproducible from first principles (fold of one skip leaf).
        let leaf = skip_leaf(&SkipEntry { node_id: node, reason: 2, epoch_observed: 1000 });
        assert_eq!(r.journal.skipped_digest, fold(B256::ZERO, leaf));
    }

    /// Build a signed envelope-0 witness for an arbitrary entry list (each ATTEST gets a real
    /// EIP-712-signed attestation; the head signature covers the exact log length).
    fn signed_log(
        sk: &SigningKey,
        ds: B256,
        schema: B256,
        specs: &[(u8, u8, u64)], // (kind, recipient-or-attest-index, confidence)
    ) -> (Envelope0Witness, B256, u64) {
        use envelopes::eas_offchain::ENTRY_REVOKE;
        let mut entries: Vec<LogEntry> = Vec::new();
        let mut attestations: Vec<OffchainAttestation> = Vec::new();
        let mut uids: Vec<B256> = Vec::new();
        for (i, (kind, arg, conf)) in specs.iter().enumerate() {
            if *kind == ENTRY_ATTEST {
                let mut data = vec![0u8; 64];
                data[32..].copy_from_slice(&U256::from(*conf).to_be_bytes::<32>());
                let mut a = OffchainAttestation {
                    version: 2,
                    schema,
                    recipient: addr(*arg),
                    time: 500 + i as u64,
                    expiration_time: 0,
                    revocable: true,
                    ref_uid: B256::ZERO,
                    data,
                    salt: B256::from([i as u8 + 1; 32]),
                    signature: vec![],
                };
                a.signature = sign_prehash(sk, &eip712_digest(ds, attest_struct_hash(&a)));
                let uid = offchain_uid_v2(&a);
                entries.push(LogEntry { kind: ENTRY_ATTEST, uid });
                uids.push(uid);
                attestations.push(a);
            } else {
                entries.push(LogEntry { kind: ENTRY_REVOKE, uid: uids[*arg as usize] });
            }
        }
        let head = eas_offchain::log_head(&entries);
        let count = entries.len() as u64;
        let head_signature = sign_prehash(sk, &eip191_digest32(&head_payload(head, count)));
        (
            Envelope0Witness { owner: eth_addr(sk), entries, attestations, head_signature },
            head,
            count,
        )
    }

    /// H-5 regression: a third party re-anchors the victim's STALE pre-revocation head (whose
    /// signature is still valid) AFTER the post-revocation head. Pre-fix, rule Φ ranked by
    /// anchor order and the stale head became "newest" — resurrecting the revoked edge with no
    /// skip recorded. Post-fix, heads rank by their owner-signed count: the stale head is never
    /// consumable, the revoked edge stays dead, and a prover withholding the newest head's data
    /// fails closed to a DROPPED skip.
    #[test]
    fn h5_reanchored_stale_head_cannot_resurrect_revoked_edges() {
        use envelopes::eas_offchain::ENTRY_REVOKE;
        let ds = keccak256(b"test-domain");
        let params = lane2_params(ds);
        let sk = SigningKey::from_slice(&[0x42u8; 32]).unwrap();
        let owner = eth_addr(&sk);
        let node_id = eas_offchain::address_node_id(owner);

        // The owner's real history: attest → attest → revoke the first. The pre-revocation
        // prefix (count 2) is a head the owner genuinely signed earlier.
        let (w_stale, head_stale, count_stale) =
            signed_log(&sk, ds, params.schema_uid, &[(ENTRY_ATTEST, 8, 50), (ENTRY_ATTEST, 9, 60)]);
        let (w_current, head_current, count_current) = signed_log(
            &sk,
            ds,
            params.schema_uid,
            &[(ENTRY_ATTEST, 8, 50), (ENTRY_ATTEST, 9, 60), (ENTRY_REVOKE, 0, 0)],
        );
        assert_eq!(count_stale, 2);
        assert_eq!(count_current, 3);

        // Anchor log: the current head first, then the ATTACKER re-anchors the stale head
        // LATER (higher fold index + newer timestamp = pre-fix "newest").
        let anchors = vec![
            AnchorRecord {
                node_id,
                envelope_kind: 0,
                head: head_current,
                count: count_current,
                data_commitment: B256::ZERO,
                block_timestamp: 1000,
            },
            AnchorRecord {
                node_id,
                envelope_kind: 0,
                head: head_stale,
                count: count_stale,
                data_commitment: B256::ZERO,
                block_timestamp: 2000,
            },
        ];

        // Case 1: honest prover supplies the CURRENT head's witness. The stale re-anchor is
        // ignored (below-max count), the current head is consumed with no skip, and the
        // revoked edge (owner -> 0x08) stays dead.
        let r = compute(&GuestInput {
            edges: vec![edge(1, 2, 1, 100, 50)],
            params: params.clone(),
            lane2: Some(Lane2Witness { anchors: anchors.clone(), envelopes: vec![w_current] }),
            binding: Default::default(),
        });
        let scored: Vec<Address> = r.scores.iter().map(|(a, _)| *a).collect();
        assert!(scored.contains(&addr(9)), "surviving lane-2 edge must score its recipient");
        assert!(
            !scored.contains(&addr(8)),
            "REGRESSION: revoked edge resurrected by a re-anchored stale head"
        );
        assert_eq!(r.journal.skipped_digest, B256::ZERO, "newest-by-count consumed: no skip");

        // Case 2: adversarial prover supplies ONLY the stale head's witness (withholding the
        // current one). The stale head is still not consumable — the node fails closed to a
        // DROPPED skip instead of resurrecting the pre-revocation set.
        let r2 = compute(&GuestInput {
            edges: vec![edge(1, 2, 1, 100, 50)],
            params,
            lane2: Some(Lane2Witness { anchors, envelopes: vec![w_stale] }),
            binding: Default::default(),
        });
        let scored2: Vec<Address> = r2.scores.iter().map(|(a, _)| *a).collect();
        assert!(
            !scored2.contains(&addr(8)) && !scored2.contains(&addr(9)),
            "REGRESSION: stale head consumed under withholding"
        );
        let expected = skipped_digest(&[SkipEntry {
            node_id,
            reason: skip_reason::DROPPED,
            // Bookkept at the newest MAX-COUNT anchor's timestamp (the head that should have
            // been consumed), not the attacker's re-anchor timestamp.
            epoch_observed: 1000,
        }]);
        assert_eq!(r2.journal.skipped_digest, expected, "withheld newest must be a DROPPED skip");
    }
}
