use std::collections::{BTreeMap, BTreeSet};

use sha2::{Digest, Sha256};

use super::event::{decode_hex, NostrEvent};
use super::oa;
use super::{EventDisposition, EventOutcome, NostrError, SkipReason, VerificationCache};

fn relevant_kind(kind: u16) -> bool {
    matches!(
        kind,
        5 | 1_617
            | 1_618
            | 1_630..=1_633
            | 13_534
            | 36_382..=36_384
            | 43_001..=43_006
            | 45_001..=45_003
    )
}

fn d_tag(event: &NostrEvent) -> Option<&str> {
    let mut values = event.tags.iter().filter(|tag| tag.first().map(String::as_str) == Some("d"));
    let first = values.next()?;
    if values.next().is_some() || first.len() != 2 {
        return None;
    }
    Some(&first[1])
}

fn replacement_key(event: &NostrEvent) -> Option<(u16, [u8; 32], String)> {
    if (10_000..20_000).contains(&event.kind) {
        Some((event.kind, event.pubkey, String::new()))
    } else if (30_000..40_000).contains(&event.kind) {
        Some((event.kind, event.pubkey, d_tag(event)?.to_owned()))
    } else {
        None
    }
}

fn wins_over(candidate: &NostrEvent, current: &NostrEvent) -> bool {
    candidate.created_at > current.created_at
        || (candidate.created_at == current.created_at && candidate.id < current.id)
}

fn parse_coordinate(value: &str) -> Option<(u16, [u8; 32], String)> {
    let mut fields = value.splitn(3, ':');
    let kind = fields.next()?.parse::<u16>().ok()?;
    let pubkey = decode_hex::<32>(fields.next()?).ok()?;
    let d = fields.next()?.to_owned();
    Some((kind, pubkey, d))
}

pub fn roster(events: &[NostrEvent], relay: &[u8; 32]) -> Result<BTreeSet<[u8; 32]>, NostrError> {
    let rosters: Vec<_> = events.iter().filter(|event| event.kind == 13_534).collect();
    if rosters.is_empty() {
        return Err(NostrError::BadRoster);
    }
    for event in &rosters {
        if &event.pubkey != relay
            || !event.content.is_empty()
            || !event.tags.first().is_some_and(|tag| tag.len() == 1 && tag[0] == "-")
        {
            return Err(NostrError::BadRoster);
        }
        let mut members = BTreeSet::new();
        for tag in event.tags.iter().skip(1) {
            if tag.len() != 3
                || tag[0] != "member"
                || !matches!(tag[2].as_str(), "owner" | "admin" | "member")
            {
                return Err(NostrError::BadRoster);
            }
            let member = decode_hex::<32>(&tag[1]).map_err(|_| NostrError::BadRoster)?;
            if !members.insert(member) {
                return Err(NostrError::BadRoster);
            }
        }
        if members.is_empty() {
            return Err(NostrError::BadRoster);
        }
    }

    let event = rosters
        .into_iter()
        .reduce(|winner, candidate| if wins_over(candidate, winner) { candidate } else { winner })
        .ok_or(NostrError::BadRoster)?;
    let mut output = BTreeSet::new();
    for tag in event.tags.iter().skip(1) {
        output.insert(decode_hex::<32>(&tag[1]).map_err(|_| NostrError::BadRoster)?);
    }
    Ok(output)
}

pub fn resolve(
    events: Vec<NostrEvent>,
    relay: &[u8; 32],
) -> Result<(Vec<EventOutcome>, BTreeSet<[u8; 32]>), NostrError> {
    resolve_with(events, relay, oa::owner_for_event)
}

pub(crate) fn resolve_cached(
    events: Vec<NostrEvent>,
    relay: &[u8; 32],
    cache: &mut VerificationCache,
) -> Result<(Vec<EventOutcome>, BTreeSet<[u8; 32]>), NostrError> {
    resolve_with(events, relay, |event| cache.owner_for_event(event))
}

fn resolve_with<F>(
    events: Vec<NostrEvent>,
    relay: &[u8; 32],
    mut owner_for_event: F,
) -> Result<(Vec<EventOutcome>, BTreeSet<[u8; 32]>), NostrError>
where
    F: FnMut(&NostrEvent) -> Result<Option<[u8; 32]>, SkipReason>,
{
    let roster = roster(&events, relay)?;
    let mut outcomes: Vec<EventOutcome> = events
        .into_iter()
        .map(|event| EventOutcome {
            event,
            oa_owner: None,
            disposition: EventDisposition::Accepted,
        })
        .collect();

    for outcome in &mut outcomes {
        if (30_000..40_000).contains(&outcome.event.kind) && d_tag(&outcome.event).is_none() {
            outcome.disposition = EventDisposition::Skipped(SkipReason::MalformedEvent);
            continue;
        }
        if !relevant_kind(outcome.event.kind) {
            outcome.disposition = EventDisposition::Skipped(SkipReason::UnknownKind);
            continue;
        }
        if outcome.event.kind == 13_534 {
            continue;
        }
        match owner_for_event(&outcome.event) {
            Ok(Some(owner)) if roster.contains(&owner) => outcome.oa_owner = Some(owner),
            Ok(Some(_)) => {
                outcome.disposition = EventDisposition::Skipped(SkipReason::RosterNonMember)
            }
            Ok(None) if roster.contains(&outcome.event.pubkey) => {}
            Ok(None) => {
                outcome.disposition = EventDisposition::Skipped(SkipReason::RosterNonMember)
            }
            Err(reason) => outcome.disposition = EventDisposition::Skipped(reason),
        }
    }

    let mut winners = BTreeMap::<(u16, [u8; 32], String), usize>::new();
    for index in 0..outcomes.len() {
        if !matches!(outcomes[index].disposition, EventDisposition::Accepted) {
            continue;
        }
        let Some(key) = replacement_key(&outcomes[index].event) else {
            continue;
        };
        match winners.get(&key).copied() {
            None => {
                winners.insert(key, index);
            }
            Some(current) if wins_over(&outcomes[index].event, &outcomes[current].event) => {
                outcomes[current].disposition =
                    EventDisposition::Skipped(SkipReason::LwwSuperseded);
                winners.insert(key, index);
            }
            Some(_) => {
                outcomes[index].disposition = EventDisposition::Skipped(SkipReason::LwwSuperseded)
            }
        }
    }

    for deletion_index in 0..outcomes.len() {
        if outcomes[deletion_index].event.kind != 5
            || !matches!(outcomes[deletion_index].disposition, EventDisposition::Accepted)
        {
            continue;
        }
        let deletion = outcomes[deletion_index].event.clone();
        let targets: Vec<_> = deletion
            .tags
            .iter()
            .filter(|tag| tag.first().is_some_and(|name| name == "e" || name == "a"))
            .collect();
        if targets.len() != 1 || deletion.tags.len() != 1 || targets[0].len() != 2 {
            outcomes[deletion_index].disposition =
                EventDisposition::Skipped(SkipReason::InvalidDeletion);
            continue;
        }
        let tag = targets[0];
        let mut applied = false;
        if tag[0] == "e" {
            if let Ok(target_id) = decode_hex::<32>(&tag[1]) {
                for (index, target) in outcomes.iter_mut().enumerate() {
                    if index != deletion_index
                        && target.event.id == target_id
                        && target.event.pubkey == deletion.pubkey
                    {
                        target.disposition =
                            EventDisposition::Skipped(SkipReason::DeletionTombstoned);
                        applied = true;
                    }
                }
            }
        } else if let Some((kind, pubkey, d)) = parse_coordinate(&tag[1]) {
            if pubkey == deletion.pubkey {
                for (index, target) in outcomes.iter_mut().enumerate() {
                    if index != deletion_index
                        && target.event.pubkey == pubkey
                        && target.event.kind == kind
                        && d_tag(&target.event) == Some(d.as_str())
                        && target.event.created_at <= deletion.created_at
                    {
                        target.disposition =
                            EventDisposition::Skipped(SkipReason::DeletionTombstoned);
                        applied = true;
                    }
                }
            }
        }
        if !applied {
            outcomes[deletion_index].disposition =
                EventDisposition::Skipped(SkipReason::InvalidDeletion);
        }
    }

    Ok((outcomes, roster))
}

pub fn outcome_digests(outcomes: &[EventOutcome]) -> ([u8; 32], [u8; 32]) {
    let mut accepted = Sha256::new();
    accepted.update(b"trustgraphs.nostr.accepted-events.v1");
    let mut skipped = Sha256::new();
    skipped.update(b"trustgraphs.nostr.skipped-events.v1");
    for outcome in outcomes {
        match outcome.disposition {
            EventDisposition::Accepted => accepted.update(outcome.event.id),
            EventDisposition::Skipped(reason) => {
                skipped.update(outcome.event.id);
                skipped.update([reason as u8]);
            }
        }
    }
    (accepted.finalize().into(), skipped.finalize().into())
}
