//! V1/G1/J1/F1 graph semantics over envelope-authenticated Nostr events.

use std::collections::{BTreeMap, BTreeSet};

use alloy_primitives::{Address, B256, U256};
use nostr_envelope::nostr::event::{decode_hex, NostrEvent};
use nostr_envelope::nostr::{EventDisposition, SkipReason};
use pagerank_core::fixed::fp_mul;
use serde::{Deserialize, Serialize};
use zk_core::anchor::SkipEntry;

use crate::binding;
use crate::params::Params;

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[repr(u8)]
pub enum Provenance {
    RelayAttested = 1,
    SelfCommitted = 2,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct SemanticEvent {
    pub event: NostrEvent,
    pub oa_owner: Option<[u8; 32]>,
    pub disposition: EventDisposition,
    pub provenance: Provenance,
    /// `(anchor fold index, event position within the committed audit/log)`.
    pub order: (u64, u32),
    pub observed_at: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct AgentLink {
    pub agent: [u8; 32],
    pub owner: [u8; 32],
}

#[derive(Clone, Debug, Default)]
pub struct DerivedGraph {
    pub nodes: Vec<B256>,
    pub outgoing: BTreeMap<B256, BTreeMap<B256, U256>>,
    pub bindings: BTreeMap<B256, Address>,
    pub agents: Vec<AgentLink>,
    pub skips: Vec<SkipEntry>,
}

pub mod skip_reason {
    pub const EVENT_MALFORMED: u8 = 10;
    pub const EVENT_UNKNOWN_KIND: u8 = 11;
    pub const OA_MALFORMED: u8 = 12;
    pub const OA_INVALID_SIGNATURE: u8 = 13;
    pub const OA_WINDOW: u8 = 14;
    pub const OA_SELF_OWNED: u8 = 15;
    pub const OA_AMBIGUOUS: u8 = 16;
    pub const LWW_SUPERSEDED: u8 = 17;
    pub const DELETION_TOMBSTONED: u8 = 18;
    pub const INVALID_DELETION: u8 = 19;
    pub const ROSTER_NONMEMBER: u8 = 20;
    pub const SCHEMA: u8 = 32;
    pub const MISSING_REFERENCE: u8 = 33;
    pub const SELF_EDGE: u8 = 34;
    pub const INELIGIBLE_TARGET: u8 = 35;
    pub const AGENT_OWNER_CONFLICT: u8 = 36;
    pub const INVALID_BINDING: u8 = 37;
    pub const BINDING_SUPERSEDED: u8 = 38;
    pub const PAIR_CAP: u8 = 39;
}

fn envelope_skip(reason: SkipReason) -> u8 {
    match reason {
        SkipReason::MalformedEvent => skip_reason::EVENT_MALFORMED,
        SkipReason::UnknownKind => skip_reason::EVENT_UNKNOWN_KIND,
        SkipReason::OaMalformed => skip_reason::OA_MALFORMED,
        SkipReason::OaInvalidSignature => skip_reason::OA_INVALID_SIGNATURE,
        SkipReason::OaWindowViolation => skip_reason::OA_WINDOW,
        SkipReason::OaSelfOwned => skip_reason::OA_SELF_OWNED,
        SkipReason::OaAmbiguous => skip_reason::OA_AMBIGUOUS,
        SkipReason::LwwSuperseded => skip_reason::LWW_SUPERSEDED,
        SkipReason::DeletionTombstoned => skip_reason::DELETION_TOMBSTONED,
        SkipReason::InvalidDeletion => skip_reason::INVALID_DELETION,
        SkipReason::RosterNonMember => skip_reason::ROSTER_NONMEMBER,
    }
}

fn node_id(pubkey: &[u8; 32]) -> B256 {
    nostr_envelope::nostr::nostr_node_id(pubkey)
}

fn event_key(event: &NostrEvent) -> B256 {
    B256::from(event.id)
}

fn insert_skip(skips: &mut BTreeMap<B256, SkipEntry>, event: &SemanticEvent, reason: u8) {
    skips.entry(event_key(&event.event)).or_insert(SkipEntry {
        node_id: event_key(&event.event),
        reason,
        epoch_observed: event.observed_at,
    });
}

fn is_lower_hex(value: &str, bytes: usize) -> bool {
    value.len() == bytes * 2
        && value.bytes().all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn is_commit(value: &str) -> bool {
    (value.len() == 40 || value.len() == 64)
        && value.bytes().all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn canonical_uuid(value: &str) -> bool {
    if value.len() != 36 {
        return false;
    }
    value.bytes().enumerate().all(|(index, byte)| match index {
        8 | 13 | 18 | 23 => byte == b'-',
        _ => byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte),
    })
}

fn canonical_u32(value: &str, maximum: u32) -> Option<u32> {
    if value.is_empty()
        || (value.len() > 1 && value.starts_with('0'))
        || !value.bytes().all(|byte| byte.is_ascii_digit())
    {
        return None;
    }
    value.parse().ok().filter(|parsed| *parsed <= maximum)
}

fn tags_named<'a>(event: &'a NostrEvent, name: &str) -> Vec<&'a [String]> {
    event
        .tags
        .iter()
        .filter(|tag| tag.first().map(String::as_str) == Some(name))
        .map(Vec::as_slice)
        .collect()
}

fn sole_tag<'a>(event: &'a NostrEvent, name: &str) -> Option<&'a [String]> {
    let tags = tags_named(event, name);
    tags.first().copied().filter(|_| tags.len() == 1)
}

fn exact_two_tag<'a>(event: &'a NostrEvent, name: &str) -> Option<&'a str> {
    let tag = sole_tag(event, name)?;
    (tag.len() == 2).then_some(tag[1].as_str())
}

fn event_order(event: &SemanticEvent) -> (u64, u32, [u8; 32]) {
    (event.order.0, event.order.1, event.event.id)
}

fn joint_provenance(left: Provenance, right: Provenance) -> Provenance {
    left.min(right)
}

fn weighted(base: U256, provenance: Provenance, params: &Params) -> U256 {
    match provenance {
        Provenance::RelayAttested => {
            fp_mul(base, params.relay_attested_weight_fp, params.precision_scale)
        }
        Provenance::SelfCommitted => base,
    }
}

fn repo_coordinate(value: &str) -> Option<[u8; 32]> {
    let mut fields = value.splitn(3, ':');
    if fields.next()? != "30617" {
        return None;
    }
    let owner = decode_hex(fields.next()?).ok()?;
    let repo = fields.next()?;
    if repo.is_empty()
        || repo.len() > 64
        || repo.starts_with('.')
        || repo.contains("..")
        || !repo
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
    {
        return None;
    }
    Some(owner)
}

fn valid_vouch(event: &NostrEvent) -> Option<([u8; 32], u32)> {
    if event.kind != 36_382 || !event.content.is_empty() {
        return None;
    }
    let auth_count = tags_named(event, "auth").len();
    if event.tags.len() != 2 + auth_count || auth_count > 1 {
        return None;
    }
    if !event
        .tags
        .iter()
        .all(|tag| tag.first().is_some_and(|name| matches!(name.as_str(), "d" | "weight" | "auth")))
    {
        return None;
    }
    let subject = decode_hex(exact_two_tag(event, "d")?).ok()?;
    let weight = canonical_u32(exact_two_tag(event, "weight")?, 100)?;
    Some((subject, weight))
}

fn valid_repo_root(event: &NostrEvent) -> bool {
    match event.kind {
        1_617 => {
            if event.content.trim().is_empty() || event.content.len() > 60 * 1_024 {
                return false;
            }
            let Some(owner) = exact_two_tag(event, "a").and_then(repo_coordinate) else {
                return false;
            };
            let owner_hex = nostr_envelope::nostr::event::lowercase_hex(&owner);
            let p_tags = tags_named(event, "p");
            let t_tags = tags_named(event, "t");
            if !p_tags.iter().all(|tag| tag.len() == 2 && is_lower_hex(&tag[1], 32))
                || !p_tags.iter().any(|tag| tag[1] == owner_hex)
                || t_tags.len() != 1
                || t_tags[0] != ["t", "root"]
                || event.tags.iter().any(|tag| {
                    tag.as_slice() == ["t", "root-revision"]
                        || tag.first().map(String::as_str) == Some("e")
                })
            {
                return false;
            }
            event.tags.iter().all(|tag| valid_patch_tag(tag))
        }
        1_618 => {
            let Some(owner) = exact_two_tag(event, "a").and_then(repo_coordinate) else {
                return false;
            };
            let owner_hex = nostr_envelope::nostr::event::lowercase_hex(&owner);
            let p_tags = tags_named(event, "p");
            p_tags.iter().all(|tag| tag.len() == 2 && is_lower_hex(&tag[1], 32))
                && p_tags.iter().any(|tag| tag[1] == owner_hex)
                && exact_two_tag(event, "subject")
                    .is_some_and(|value| !value.is_empty() && value.len() <= 256)
                && exact_two_tag(event, "c").is_some_and(is_commit)
                && sole_tag(event, "clone").is_some_and(|tag| {
                    tag.len() >= 2 && tag.iter().skip(1).all(|url| !url.is_empty())
                })
                && event.content.len() <= 64 * 1_024
                && event.tags.iter().all(|tag| valid_pr_tag(tag))
        }
        _ => false,
    }
}

fn valid_patch_tag(tag: &[String]) -> bool {
    let Some(name) = tag.first().map(String::as_str) else {
        return false;
    };
    match name {
        "a" => tag.len() == 2 && repo_coordinate(&tag[1]).is_some(),
        "p" => tag.len() == 2 && is_lower_hex(&tag[1], 32),
        "t" => tag.len() == 2,
        "r" => (tag.len() == 2 || (tag.len() == 3 && tag[2] == "euc")) && is_commit(&tag[1]),
        "commit" | "parent-commit" => tag.len() == 2 && is_commit(&tag[1]),
        "commit-pgp-sig" => tag.len() == 2,
        "committer" => tag.len() == 5,
        _ => false,
    }
}

fn valid_pr_tag(tag: &[String]) -> bool {
    let Some(name) = tag.first().map(String::as_str) else {
        return false;
    };
    match name {
        "a" => tag.len() == 2 && repo_coordinate(&tag[1]).is_some(),
        "p" => tag.len() == 2 && is_lower_hex(&tag[1], 32),
        "r" | "c" | "merge-base" => tag.len() == 2 && is_commit(&tag[1]),
        "subject" => tag.len() == 2 && !tag[1].is_empty() && tag[1].len() <= 256,
        "t" => tag.len() == 2,
        "h" => tag.len() == 2 && canonical_uuid(&tag[1]),
        "clone" => tag.len() >= 2 && tag.iter().skip(1).all(|url| !url.is_empty()),
        "branch-name" => tag.len() == 2,
        "e" => tag.len() == 2 && is_lower_hex(&tag[1], 32),
        _ => false,
    }
}

fn valid_status(event: &NostrEvent) -> Option<[u8; 32]> {
    if !(1_630..=1_633).contains(&event.kind) || event.content.len() > 64 * 1_024 {
        return None;
    }
    let roots: Vec<_> = tags_named(event, "e")
        .into_iter()
        .filter(|tag| tag.len() == 4 && tag[2].is_empty() && tag[3] == "root")
        .collect();
    if roots.len() != 1 || !is_lower_hex(&roots[0][1], 32) {
        return None;
    }
    let replies = tags_named(event, "e")
        .into_iter()
        .filter(|tag| tag.get(3).map(String::as_str) == Some("reply"))
        .count();
    if replies > 1
        || tags_named(event, "a").len() > 1
        || tags_named(event, "merge-commit").len() > 1
        || tags_named(event, "applied-as-commits").len() > 1
    {
        return None;
    }
    if event.tags.iter().any(|tag| !valid_status_tag(tag, event.kind == 1_631)) {
        return None;
    }
    let references: BTreeSet<_> =
        tags_named(event, "r").into_iter().map(|tag| tag[1].as_str()).collect();
    if exact_two_tag(event, "merge-commit").is_some_and(|commit| !references.contains(commit)) {
        return None;
    }
    if let Some(commits) = sole_tag(event, "applied-as-commits") {
        let mut unique = BTreeSet::new();
        if commits
            .iter()
            .skip(1)
            .any(|commit| !unique.insert(commit.as_str()) || !references.contains(commit.as_str()))
        {
            return None;
        }
    }
    decode_hex(&roots[0][1]).ok()
}

fn valid_status_tag(tag: &[String], merged: bool) -> bool {
    let Some(name) = tag.first().map(String::as_str) else {
        return false;
    };
    match name {
        "e" => {
            tag.len() == 4
                && tag[2].is_empty()
                && matches!(tag[3].as_str(), "root" | "reply")
                && is_lower_hex(&tag[1], 32)
        }
        "p" => tag.len() == 2 && is_lower_hex(&tag[1], 32),
        "a" => tag.len() == 2 && repo_coordinate(&tag[1]).is_some(),
        "r" => tag.len() == 2 && is_commit(&tag[1]),
        "q" => {
            merged
                && (2..=4).contains(&tag.len())
                && is_lower_hex(&tag[1], 32)
                && (tag.len() < 4 || (!tag[2].is_empty() && is_lower_hex(&tag[3], 32)))
        }
        "merge-commit" => merged && tag.len() == 2 && is_commit(&tag[1]),
        "applied-as-commits" => {
            merged && tag.len() >= 2 && tag.iter().skip(1).all(|commit| is_commit(commit))
        }
        _ => false,
    }
}

fn valid_forum_target(event: &NostrEvent) -> Option<&str> {
    if !matches!(event.kind, 45_001 | 45_003) {
        return None;
    }
    let channel = exact_two_tag(event, "h")?;
    canonical_uuid(channel).then_some(channel)
}

fn valid_vote(event: &NostrEvent) -> Option<([u8; 32], &str, bool)> {
    if event.kind != 45_002 || event.tags.len() != 2 {
        return None;
    }
    let channel = exact_two_tag(event, "h")?;
    if !canonical_uuid(channel) {
        return None;
    }
    let target = decode_hex(exact_two_tag(event, "e")?).ok()?;
    let positive = match event.content.as_str() {
        "+" => true,
        "-" => false,
        _ => return None,
    };
    Some((target, channel, positive))
}

fn valid_request(event: &NostrEvent) -> Option<([u8; 32], &str)> {
    if event.kind != 43_001
        || event.tags.len() != 2
        || event.content.is_empty()
        || event.content.len() > 16_384
    {
        return None;
    }
    let channel = exact_two_tag(event, "h")?;
    if !canonical_uuid(channel) {
        return None;
    }
    Some((decode_hex(exact_two_tag(event, "p")?).ok()?, channel))
}

fn terminal_refs(event: &NostrEvent) -> Option<([u8; 32], [u8; 32], &str)> {
    let root = sole_tag(event, "e")?;
    if root.len() != 4 || !root[2].is_empty() || root[3] != "root" {
        return None;
    }
    let channel = exact_two_tag(event, "h")?;
    if !canonical_uuid(channel) {
        return None;
    }
    Some((decode_hex(&root[1]).ok()?, decode_hex(exact_two_tag(event, "p")?).ok()?, channel))
}

fn valid_terminal(event: &SemanticEvent, request: &SemanticEvent) -> bool {
    let Some((request_id, peer, channel)) = terminal_refs(&event.event) else {
        return false;
    };
    let Some((agent, request_channel)) = valid_request(&request.event) else {
        return false;
    };
    if request_id != request.event.id || channel != request_channel {
        return false;
    }
    match event.event.kind {
        43_004 => {
            event.event.tags.len() == 4
                && !event.event.content.is_empty()
                && event.event.content.len() <= 65_536
                && event.event.pubkey == agent
                && peer == request.event.pubkey
                && event.oa_owner.is_some()
                && tags_named(&event.event, "auth").len() == 1
        }
        43_005 => {
            event.event.tags.len() == 3
                && event.event.content.len() <= 4_096
                && event.event.pubkey == request.event.pubkey
                && peer == agent
                && tags_named(&event.event, "auth").is_empty()
        }
        43_006 => {
            event.event.tags.len() == 4
                && event.event.content.len() <= 4_096
                && event.event.pubkey == agent
                && peer == request.event.pubkey
                && event.oa_owner.is_some()
                && tags_named(&event.event, "auth").len() == 1
        }
        _ => false,
    }
}

#[derive(Clone)]
struct Candidate<'a> {
    source: [u8; 32],
    target: [u8; 32],
    weight: U256,
    provenance: Provenance,
    event: &'a SemanticEvent,
}

fn candidate_priority(candidate: &Candidate<'_>) -> (Provenance, (u64, u32, [u8; 32])) {
    (candidate.provenance, event_order(candidate.event))
}

fn add_edge(
    outgoing: &mut BTreeMap<B256, BTreeMap<B256, U256>>,
    source: [u8; 32],
    target: [u8; 32],
    weight: U256,
) {
    if weight.is_zero() {
        return;
    }
    let entry = outgoing.entry(node_id(&source)).or_default().entry(node_id(&target)).or_default();
    *entry = entry.checked_add(weight).expect("bounded semantic edge sum");
}

pub fn derive(
    events: &[SemanticEvent],
    roster: &BTreeSet<[u8; 32]>,
    params: &Params,
) -> DerivedGraph {
    let mut skips = BTreeMap::<B256, SkipEntry>::new();
    for event in events {
        if let EventDisposition::Skipped(reason) = event.disposition {
            insert_skip(&mut skips, event, envelope_skip(reason));
        }
    }

    let accepted: Vec<_> =
        events.iter().filter(|event| event.disposition == EventDisposition::Accepted).collect();
    let mut owner_sets = BTreeMap::<[u8; 32], BTreeSet<[u8; 32]>>::new();
    for event in &accepted {
        if let Some(owner) = event.oa_owner {
            owner_sets.entry(event.event.pubkey).or_default().insert(owner);
        }
    }
    let mut agents = Vec::new();
    let mut eligible = roster.clone();
    for (agent, owners) in &owner_sets {
        if owners.len() == 1 {
            let owner = *owners.first().expect("one owner");
            agents.push(AgentLink { agent: *agent, owner });
            eligible.insert(*agent);
        }
    }
    for event in &accepted {
        if event.oa_owner.is_some()
            && owner_sets.get(&event.event.pubkey).is_some_and(|owners| owners.len() != 1)
        {
            insert_skip(&mut skips, event, skip_reason::AGENT_OWNER_CONFLICT);
        }
    }
    agents.sort_by_key(|link| (link.agent, link.owner));

    let usable: Vec<_> = accepted
        .iter()
        .copied()
        .filter(|event| !skips.contains_key(&event_key(&event.event)))
        .collect();
    let by_id: BTreeMap<_, _> = usable.iter().map(|event| (event.event.id, *event)).collect();
    let mut outgoing = BTreeMap::new();

    // V1: envelope state already selected the NIP-33 winner and applied tombstones.
    for evidence in &usable {
        if evidence.event.kind != 36_382 {
            continue;
        }
        let Some((subject, percent)) = valid_vouch(&evidence.event) else {
            insert_skip(&mut skips, evidence, skip_reason::SCHEMA);
            continue;
        };
        if evidence.event.pubkey == subject {
            insert_skip(&mut skips, evidence, skip_reason::SELF_EDGE);
            continue;
        }
        if !eligible.contains(&subject) {
            insert_skip(&mut skips, evidence, skip_reason::INELIGIBLE_TARGET);
            continue;
        }
        let base = params.w_vouch_fp * U256::from(percent) / U256::from(100);
        add_edge(
            &mut outgoing,
            evidence.event.pubkey,
            subject,
            weighted(base, evidence.provenance, params),
        );
    }

    // G1: last valid status per (status author, root); only kind 1631 is live.
    let mut roots = BTreeSet::new();
    for evidence in &usable {
        if matches!(evidence.event.kind, 1_617 | 1_618) {
            if valid_repo_root(&evidence.event) {
                roots.insert(evidence.event.id);
            } else {
                insert_skip(&mut skips, evidence, skip_reason::SCHEMA);
            }
        }
    }
    let mut statuses = BTreeMap::<([u8; 32], [u8; 32]), &SemanticEvent>::new();
    for evidence in &usable {
        if !(1_630..=1_633).contains(&evidence.event.kind) {
            continue;
        }
        let Some(root) = valid_status(&evidence.event) else {
            insert_skip(&mut skips, evidence, skip_reason::SCHEMA);
            continue;
        };
        let key = (evidence.event.pubkey, root);
        if statuses.get(&key).is_none_or(|current| event_order(evidence) > event_order(current)) {
            statuses.insert(key, evidence);
        }
    }
    let mut merge_pairs = BTreeMap::<([u8; 32], [u8; 32]), Candidate<'_>>::new();
    for ((author, root_id), status) in statuses {
        if status.event.kind != 1_631 {
            continue;
        }
        let Some(root) = by_id.get(&root_id).copied().filter(|_| roots.contains(&root_id)) else {
            insert_skip(&mut skips, status, skip_reason::MISSING_REFERENCE);
            continue;
        };
        if author == root.event.pubkey {
            insert_skip(&mut skips, status, skip_reason::SELF_EDGE);
            continue;
        }
        let provenance = joint_provenance(status.provenance, root.provenance);
        let candidate = Candidate {
            source: author,
            target: root.event.pubkey,
            weight: weighted(params.w_merge_fp, provenance, params),
            provenance,
            event: status,
        };
        let key = (candidate.source, candidate.target);
        if merge_pairs
            .get(&key)
            .is_none_or(|current| candidate_priority(&candidate) > candidate_priority(current))
        {
            merge_pairs.insert(key, candidate);
        }
    }
    for candidate in merge_pairs.into_values() {
        add_edge(&mut outgoing, candidate.source, candidate.target, candidate.weight);
    }

    // F1: last literal +/- per (voter, target event), then cap positive states per node pair.
    let mut forum_targets = BTreeMap::<[u8; 32], (&SemanticEvent, &str)>::new();
    for evidence in &usable {
        if matches!(evidence.event.kind, 45_001 | 45_003) {
            if let Some(channel) = valid_forum_target(&evidence.event) {
                forum_targets.insert(evidence.event.id, (evidence, channel));
            } else {
                insert_skip(&mut skips, evidence, skip_reason::SCHEMA);
            }
        }
    }
    let mut vote_state = BTreeMap::<([u8; 32], [u8; 32]), (&SemanticEvent, bool)>::new();
    for evidence in &usable {
        if evidence.event.kind != 45_002 {
            continue;
        }
        let Some((target_id, channel, positive)) = valid_vote(&evidence.event) else {
            insert_skip(&mut skips, evidence, skip_reason::SCHEMA);
            continue;
        };
        let Some((target, target_channel)) = forum_targets.get(&target_id).copied() else {
            insert_skip(&mut skips, evidence, skip_reason::MISSING_REFERENCE);
            continue;
        };
        if channel != target_channel {
            insert_skip(&mut skips, evidence, skip_reason::SCHEMA);
            continue;
        }
        if evidence.event.pubkey == target.event.pubkey {
            insert_skip(&mut skips, evidence, skip_reason::SELF_EDGE);
            continue;
        }
        let key = (evidence.event.pubkey, target_id);
        if vote_state
            .get(&key)
            .is_none_or(|(current, _)| event_order(evidence) > event_order(current))
        {
            vote_state.insert(key, (evidence, positive));
        }
    }
    let mut forum_pairs = BTreeMap::<([u8; 32], [u8; 32]), Vec<Candidate<'_>>>::new();
    for ((voter, target_id), (vote, positive)) in vote_state {
        if !positive {
            continue;
        }
        let target = forum_targets[&target_id].0;
        let provenance = joint_provenance(vote.provenance, target.provenance);
        forum_pairs.entry((voter, target.event.pubkey)).or_default().push(Candidate {
            source: voter,
            target: target.event.pubkey,
            weight: weighted(params.w_forum_fp, provenance, params),
            provenance,
            event: vote,
        });
    }
    apply_capped(&mut outgoing, &mut skips, forum_pairs, params.forum_pair_cap);

    // J1: last valid terminal event per request; only a result establishes an edge.
    let mut requests = BTreeMap::<[u8; 32], &SemanticEvent>::new();
    for evidence in &usable {
        if evidence.event.kind == 43_001 {
            if valid_request(&evidence.event).is_some() {
                requests.insert(evidence.event.id, evidence);
            } else {
                insert_skip(&mut skips, evidence, skip_reason::SCHEMA);
            }
        }
    }
    let mut terminals = BTreeMap::<[u8; 32], &SemanticEvent>::new();
    for evidence in &usable {
        if !matches!(evidence.event.kind, 43_004..=43_006) {
            continue;
        }
        let Some((request_id, _, _)) = terminal_refs(&evidence.event) else {
            insert_skip(&mut skips, evidence, skip_reason::SCHEMA);
            continue;
        };
        let Some(request) = requests.get(&request_id).copied() else {
            insert_skip(&mut skips, evidence, skip_reason::MISSING_REFERENCE);
            continue;
        };
        if !valid_terminal(evidence, request) {
            insert_skip(&mut skips, evidence, skip_reason::SCHEMA);
            continue;
        }
        if terminals
            .get(&request_id)
            .is_none_or(|current| event_order(evidence) > event_order(current))
        {
            terminals.insert(request_id, evidence);
        }
    }
    let mut job_pairs = BTreeMap::<([u8; 32], [u8; 32]), Vec<Candidate<'_>>>::new();
    for (request_id, terminal) in terminals {
        if terminal.event.kind != 43_004 {
            continue;
        }
        let request = requests[&request_id];
        let agent = terminal.event.pubkey;
        if request.event.pubkey == agent {
            insert_skip(&mut skips, terminal, skip_reason::SELF_EDGE);
            continue;
        }
        if !eligible.contains(&agent) || terminal.oa_owner.is_none() {
            insert_skip(&mut skips, terminal, skip_reason::INELIGIBLE_TARGET);
            continue;
        }
        let provenance = joint_provenance(request.provenance, terminal.provenance);
        job_pairs.entry((request.event.pubkey, agent)).or_default().push(Candidate {
            source: request.event.pubkey,
            target: agent,
            weight: weighted(params.w_job_fp, provenance, params),
            provenance,
            event: terminal,
        });
    }
    apply_capped(&mut outgoing, &mut skips, job_pairs, params.job_pair_cap);

    // Binding: newest valid state per author. A valid tombstoned newest coordinate must remain an
    // author-level terminal state; otherwise deleting a rebind would resurrect an older address.
    let mut binding_candidates = BTreeMap::<[u8; 32], (&SemanticEvent, Address)>::new();
    for evidence in events {
        if evidence.event.kind != 36_383
            || !matches!(
                evidence.disposition,
                EventDisposition::Accepted
                    | EventDisposition::Skipped(SkipReason::DeletionTombstoned)
            )
        {
            continue;
        }
        let Some(address) = binding::verify(&evidence.event, params.chain_id) else {
            if evidence.disposition == EventDisposition::Accepted {
                insert_skip(&mut skips, evidence, skip_reason::INVALID_BINDING);
            }
            continue;
        };
        let author = evidence.event.pubkey;
        match binding_candidates.get(&author).copied() {
            Some((current, _)) if event_order(current) >= event_order(evidence) => {
                insert_skip(&mut skips, evidence, skip_reason::BINDING_SUPERSEDED);
            }
            Some((current, _)) => {
                insert_skip(&mut skips, current, skip_reason::BINDING_SUPERSEDED);
                binding_candidates.insert(author, (evidence, address));
            }
            None => {
                binding_candidates.insert(author, (evidence, address));
            }
        }
    }
    let bindings = binding_candidates
        .into_iter()
        .filter_map(|(pubkey, (event, address))| {
            (event.disposition == EventDisposition::Accepted).then_some((node_id(&pubkey), address))
        })
        .collect();

    let mut nodes: Vec<_> = eligible.iter().map(node_id).collect();
    nodes.sort_unstable();
    let mut skips: Vec<_> = skips.into_values().collect();
    skips.sort();
    DerivedGraph { nodes, outgoing, bindings, agents, skips }
}

fn apply_capped(
    outgoing: &mut BTreeMap<B256, BTreeMap<B256, U256>>,
    skips: &mut BTreeMap<B256, SkipEntry>,
    pairs: BTreeMap<([u8; 32], [u8; 32]), Vec<Candidate<'_>>>,
    cap: u32,
) {
    for candidates in pairs.into_values() {
        let mut candidates = candidates;
        candidates.sort_by_key(|candidate| std::cmp::Reverse(candidate_priority(candidate)));
        for (index, candidate) in candidates.into_iter().enumerate() {
            if index >= cap as usize {
                insert_skip(skips, candidate.event, skip_reason::PAIR_CAP);
                continue;
            }
            add_edge(outgoing, candidate.source, candidate.target, candidate.weight);
        }
    }
}
