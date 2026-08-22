use std::collections::BTreeSet;
use std::path::Path;

use alloy_primitives::{keccak256, Address, B256, U256};
use k256::ecdsa::SigningKey;
use nostr_envelope::nostr::event::{lowercase_hex, NostrEvent};
use nostr_envelope::nostr::tgnw;
use nostr_envelope::nostr::{EventDisposition, NostrLimits, SkipReason};
use nostr_workspace_core::binding;
use nostr_workspace_core::params::{output_domain, Params, PARAMS_VERSION};
use nostr_workspace_core::semantics::{self, derive, Provenance, SemanticEvent};

const CHANNEL: &str = "01915f7a-6b4c-7d2e-8f10-665544332211";
const COMMIT: &str = "0123456789abcdef0123456789abcdef01234567";

fn scale() -> U256 {
    U256::from(1_000_000_000_000_000_000u64)
}

fn fp(numerator: u64, denominator: u64) -> U256 {
    scale() * U256::from(numerator) / U256::from(denominator)
}

fn params() -> Params {
    Params {
        version: PARAMS_VERSION,
        output_domain: output_domain(),
        damping_fp: fp(85, 100),
        tolerance_fp: scale() / U256::from(1_000_000u64),
        max_iterations: 100,
        trust_multiplier_fp: scale() * U256::from(2),
        trust_share_fp: fp(15, 100),
        trust_decay_fp: fp(80, 100),
        precision_scale: scale(),
        total_pool: U256::from(1_000_000_000_000_000_000_000_000u128),
        trusted_seed_pubkeys: vec![[1; 32]],
        community_id: [0x11; 16],
        instance_domain: [0x42; 32],
        relay_pubkey: [0x21; 32],
        chain_id: 31_337,
        allowed_variants: 0b11,
        w_vouch_fp: scale(),
        w_merge_fp: fp(8, 10),
        w_job_fp: fp(1, 10),
        w_forum_fp: fp(5, 100),
        relay_attested_weight_fp: fp(25, 100),
        forum_pair_cap: 3,
        job_pair_cap: 2,
        lane2_max_head_age: 1_000,
        max_anchor_records: 200_000,
        max_estimated_pgu: 400_000_000,
        limits: NostrLimits::PILOT,
    }
}

fn tag(parts: &[&str]) -> Vec<String> {
    parts.iter().map(|part| (*part).to_owned()).collect()
}

fn event(
    id: u8,
    author: [u8; 32],
    kind: u16,
    tags: Vec<Vec<String>>,
    content: &str,
    order: u32,
) -> SemanticEvent {
    SemanticEvent {
        event: NostrEvent {
            id: [id; 32],
            pubkey: author,
            created_at: u64::from(order),
            kind,
            tags,
            content: content.to_owned(),
            sig: vec![0; 64],
        },
        oa_owner: None,
        disposition: EventDisposition::Accepted,
        provenance: Provenance::SelfCommitted,
        order: (0, order),
        observed_at: 100 + u64::from(order),
    }
}

fn node(pubkey: [u8; 32]) -> B256 {
    nostr_envelope::nostr::nostr_node_id(&pubkey)
}

fn edge(graph: &semantics::DerivedGraph, source: [u8; 32], target: [u8; 32]) -> U256 {
    graph
        .outgoing
        .get(&node(source))
        .and_then(|edges| edges.get(&node(target)))
        .copied()
        .unwrap_or_default()
}

fn has_skip(graph: &semantics::DerivedGraph, evidence: &SemanticEvent, reason: u8) -> bool {
    graph
        .skips
        .iter()
        .any(|skip| skip.node_id == B256::from(evidence.event.id) && skip.reason == reason)
}

fn signed_binding(
    id: u8,
    author: [u8; 32],
    evm_secret: u8,
    timestamp: u64,
    nonce: u64,
    order: u32,
) -> (SemanticEvent, Address) {
    let wallet = SigningKey::from_slice(&[evm_secret; 32]).unwrap();
    let uncompressed = wallet.verifying_key().to_encoded_point(false);
    let wallet_hash = keccak256(&uncompressed.as_bytes()[1..]);
    let address = Address::from_slice(&wallet_hash[12..]);
    let address_hex = format!("0x{}", hex::encode(address));
    let did = format!("did:nostr:{}", lowercase_hex(&author));
    let digest = binding::binding_digest(
        &did,
        address,
        U256::from(31_337),
        U256::from(timestamp),
        U256::from(nonce),
    );
    let (signature, recovery_id) = wallet.sign_prehash_recoverable(digest.as_slice()).unwrap();
    let mut signature_bytes = signature.to_bytes().to_vec();
    signature_bytes.push(recovery_id.to_byte());
    let content = format!(
        "{{\"address\":\"{address_hex}\",\"chainId\":\"31337\",\"timestamp\":\"{timestamp}\",\"nonce\":\"{nonce}\",\"signature\":\"0x{}\"}}",
        hex::encode(signature_bytes)
    );
    (event(id, author, 36_383, vec![tag(&["d", &address_hex])], &content, order), address)
}

#[test]
fn vouch_zero_self_and_malformed_states_are_inert() {
    let alice = [1; 32];
    let bob = [2; 32];
    let alice_hex = lowercase_hex(&alice);
    let bob_hex = lowercase_hex(&bob);
    let zero = event(1, alice, 36_382, vec![tag(&["d", &bob_hex]), tag(&["weight", "0"])], "", 1);
    let self_vouch =
        event(2, alice, 36_382, vec![tag(&["d", &alice_hex]), tag(&["weight", "75"])], "", 2);
    let malformed =
        event(3, bob, 36_382, vec![tag(&["d", &alice_hex]), tag(&["weight", "01"])], "", 3);

    let graph = derive(
        &[zero, self_vouch.clone(), malformed.clone()],
        &BTreeSet::from([alice, bob]),
        &params(),
    );
    assert!(graph.outgoing.is_empty());
    assert!(has_skip(&graph, &self_vouch, semantics::skip_reason::SELF_EDGE));
    assert!(has_skip(&graph, &malformed, semantics::skip_reason::SCHEMA));
}

#[test]
fn merge_needs_a_strict_two_sided_live_status() {
    let alice = [1; 32];
    let bob = [2; 32];
    let bob_hex = lowercase_hex(&bob);
    let root = event(
        10,
        bob,
        1_617,
        vec![
            tag(&["a", &format!("30617:{bob_hex}:repo")]),
            tag(&["p", &bob_hex]),
            tag(&["t", "root"]),
            tag(&["commit", COMMIT]),
            tag(&["r", COMMIT]),
        ],
        "patch",
        1,
    );
    let root_hex = lowercase_hex(&root.event.id);
    let merged = event(
        11,
        alice,
        1_631,
        vec![
            tag(&["e", &root_hex, "", "root"]),
            tag(&["merge-commit", COMMIT]),
            tag(&["r", COMMIT]),
        ],
        "merged",
        2,
    );

    let live = derive(&[root.clone(), merged.clone()], &BTreeSet::from([alice, bob]), &params());
    assert_eq!(edge(&live, alice, bob), params().w_merge_fp);

    let bad_duplicate = event(
        12,
        alice,
        1_631,
        vec![
            tag(&["e", &root_hex, "", "root"]),
            tag(&["merge-commit", COMMIT]),
            tag(&["merge-commit", COMMIT]),
            tag(&["r", COMMIT]),
        ],
        "merged",
        3,
    );
    let still_live = derive(
        &[root.clone(), merged, bad_duplicate.clone()],
        &BTreeSet::from([alice, bob]),
        &params(),
    );
    assert_eq!(edge(&still_live, alice, bob), params().w_merge_fp);
    assert!(has_skip(&still_live, &bad_duplicate, semantics::skip_reason::SCHEMA));

    let opened = event(13, alice, 1_630, vec![tag(&["e", &root_hex, "", "root"])], "open", 4);
    let cleared =
        derive(&[root, still_live_source(), opened], &BTreeSet::from([alice, bob]), &params());
    assert_eq!(edge(&cleared, alice, bob), U256::ZERO);
}

// A fresh merged event keeps the lifecycle test independent of moved test values.
fn still_live_source() -> SemanticEvent {
    let root_hex = lowercase_hex(&[10; 32]);
    event(
        11,
        [1; 32],
        1_631,
        vec![
            tag(&["e", &root_hex, "", "root"]),
            tag(&["merge-commit", COMMIT]),
            tag(&["r", COMMIT]),
        ],
        "merged",
        2,
    )
}

#[test]
fn forum_vote_lifecycle_and_pair_cap_are_deterministic() {
    let alice = [1; 32];
    let bob = [2; 32];
    let target_one = event(20, bob, 45_001, vec![tag(&["h", CHANNEL])], "one", 1);
    let target_two = event(21, bob, 45_003, vec![tag(&["h", CHANNEL])], "two", 2);
    let one_hex = lowercase_hex(&target_one.event.id);
    let two_hex = lowercase_hex(&target_two.event.id);
    let plus_one =
        event(22, alice, 45_002, vec![tag(&["h", CHANNEL]), tag(&["e", &one_hex])], "+", 3);
    let plus_two =
        event(23, alice, 45_002, vec![tag(&["h", CHANNEL]), tag(&["e", &two_hex])], "+", 4);
    let mut capped_params = params();
    capped_params.forum_pair_cap = 1;
    let capped = derive(
        &[target_one.clone(), target_two.clone(), plus_one.clone(), plus_two.clone()],
        &BTreeSet::from([alice, bob]),
        &capped_params,
    );
    assert_eq!(edge(&capped, alice, bob), capped_params.w_forum_fp);
    assert!(has_skip(&capped, &plus_one, semantics::skip_reason::PAIR_CAP));

    let minus_two =
        event(24, alice, 45_002, vec![tag(&["h", CHANNEL]), tag(&["e", &two_hex])], "-", 5);
    let malformed =
        event(25, alice, 45_002, vec![tag(&["h", CHANNEL]), tag(&["e", &one_hex])], "up", 6);
    let cleared = derive(
        &[target_one, target_two, plus_one, plus_two, minus_two, malformed.clone()],
        &BTreeSet::from([alice, bob]),
        &capped_params,
    );
    assert_eq!(edge(&cleared, alice, bob), capped_params.w_forum_fp);
    assert!(has_skip(&cleared, &malformed, semantics::skip_reason::SCHEMA));

    let missing = event(
        26,
        alice,
        45_002,
        vec![tag(&["h", CHANNEL]), tag(&["e", &lowercase_hex(&[99; 32])])],
        "+",
        7,
    );
    let missing_graph =
        derive(std::slice::from_ref(&missing), &BTreeSet::from([alice, bob]), &capped_params);
    assert!(has_skip(&missing_graph, &missing, semantics::skip_reason::MISSING_REFERENCE));
}

#[test]
fn completed_job_is_cleared_by_a_later_cancel_or_error() {
    let alice = [1; 32];
    let owner = [2; 32];
    let agent = [3; 32];
    let alice_hex = lowercase_hex(&alice);
    let agent_hex = lowercase_hex(&agent);
    let request =
        event(30, alice, 43_001, vec![tag(&["h", CHANNEL]), tag(&["p", &agent_hex])], "work", 1);
    let request_hex = lowercase_hex(&request.event.id);
    let mut result = event(
        31,
        agent,
        43_004,
        vec![
            tag(&["h", CHANNEL]),
            tag(&["p", &alice_hex]),
            tag(&["e", &request_hex, "", "root"]),
            tag(&["auth", "credential", "conditions", "signature"]),
        ],
        "result",
        2,
    );
    result.oa_owner = Some(owner);
    let live =
        derive(&[request.clone(), result.clone()], &BTreeSet::from([alice, owner]), &params());
    assert_eq!(edge(&live, alice, agent), params().w_job_fp);

    let cancel = event(
        32,
        alice,
        43_005,
        vec![tag(&["h", CHANNEL]), tag(&["p", &agent_hex]), tag(&["e", &request_hex, "", "root"])],
        "cancel",
        3,
    );
    let cancelled = derive(
        &[request.clone(), result.clone(), cancel],
        &BTreeSet::from([alice, owner]),
        &params(),
    );
    assert_eq!(edge(&cancelled, alice, agent), U256::ZERO);

    let mut error = event(
        33,
        agent,
        43_006,
        vec![
            tag(&["h", CHANNEL]),
            tag(&["p", &alice_hex]),
            tag(&["e", &request_hex, "", "root"]),
            tag(&["auth", "credential", "conditions", "signature"]),
        ],
        "error",
        4,
    );
    error.oa_owner = Some(owner);
    let errored = derive(&[request, result, error], &BTreeSet::from([alice, owner]), &params());
    assert_eq!(edge(&errored, alice, agent), U256::ZERO);
}

#[test]
fn conflicting_agent_owners_remove_agent_eligibility() {
    let alice = [1; 32];
    let bob = [2; 32];
    let agent = [3; 32];
    let alice_hex = lowercase_hex(&alice);
    let bob_hex = lowercase_hex(&bob);
    let mut first = event(
        40,
        agent,
        36_382,
        vec![
            tag(&["d", &bob_hex]),
            tag(&["weight", "50"]),
            tag(&["auth", "credential", "conditions", "signature"]),
        ],
        "",
        1,
    );
    first.oa_owner = Some(alice);
    let mut second = event(
        41,
        agent,
        36_382,
        vec![
            tag(&["d", &alice_hex]),
            tag(&["weight", "50"]),
            tag(&["auth", "credential", "conditions", "signature"]),
        ],
        "",
        2,
    );
    second.oa_owner = Some(bob);

    let graph = derive(&[first.clone(), second.clone()], &BTreeSet::from([alice, bob]), &params());
    assert_eq!(
        graph.nodes.iter().copied().collect::<BTreeSet<_>>(),
        BTreeSet::from([node(alice), node(bob)])
    );
    assert!(graph.agents.is_empty());
    assert!(graph.outgoing.is_empty());
    assert!(has_skip(&graph, &first, semantics::skip_reason::AGENT_OWNER_CONFLICT));
    assert!(has_skip(&graph, &second, semantics::skip_reason::AGENT_OWNER_CONFLICT));
}

#[test]
fn a_tombstoned_binding_is_not_published() {
    let fixture = Path::new(env!("CARGO_MANIFEST_DIR")).join(
        "../../tests/fixtures/nostr/buzz/a362fecc2389955f942c9581bdfeba379ab115b3/source-option-a.tgnw",
    );
    let bytes = std::fs::read(fixture).unwrap();
    let bundle = tgnw::decode(&bytes, &NostrLimits::HARD).unwrap();
    let binding_event = bundle.events.into_iter().find(|event| event.kind == 36_383).unwrap();
    let author = binding_event.pubkey;
    let live = SemanticEvent {
        event: binding_event,
        oa_owner: None,
        disposition: EventDisposition::Accepted,
        provenance: Provenance::RelayAttested,
        order: (0, 1),
        observed_at: 100,
    };
    let graph = derive(std::slice::from_ref(&live), &BTreeSet::from([author]), &params());
    assert_eq!(graph.bindings.len(), 1);

    let mut deleted = live;
    deleted.disposition = EventDisposition::Skipped(SkipReason::DeletionTombstoned);
    let graph = derive(&[deleted.clone()], &BTreeSet::from([author]), &params());
    assert!(graph.bindings.is_empty());
    assert!(has_skip(&graph, &deleted, semantics::skip_reason::DELETION_TOMBSTONED));
}

#[test]
fn rebinding_then_unbinding_never_resurrects_the_old_address() {
    let author = [9; 32];
    let (old, old_address) = signed_binding(70, author, 7, 100, 1, 1);
    let (new, new_address) = signed_binding(71, author, 8, 101, 2, 2);
    assert_ne!(old_address, new_address);

    let rebound = derive(&[old.clone(), new.clone()], &BTreeSet::from([author]), &params());
    assert_eq!(rebound.bindings.get(&node(author)), Some(&new_address));
    assert!(has_skip(&rebound, &old, semantics::skip_reason::BINDING_SUPERSEDED));

    let mut unbound = new;
    unbound.disposition = EventDisposition::Skipped(SkipReason::DeletionTombstoned);
    let cleared = derive(&[old.clone(), unbound.clone()], &BTreeSet::from([author]), &params());
    assert!(cleared.bindings.is_empty());
    assert!(has_skip(&cleared, &old, semantics::skip_reason::BINDING_SUPERSEDED));
    assert!(has_skip(&cleared, &unbound, semantics::skip_reason::DELETION_TOMBSTONED));
}
