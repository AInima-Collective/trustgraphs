use k256::schnorr::signature::hazmat::PrehashVerifier;
use k256::schnorr::{Signature, VerifyingKey};
use sha2::{Digest, Sha256};

use super::event::{decode_hex, lowercase_hex, NostrEvent};
use super::{NostrError, SkipReason};

fn canonical_decimal(value: &str, maximum: u64) -> Option<u64> {
    if value.is_empty()
        || (value.len() > 1 && value.starts_with('0'))
        || !value.bytes().all(|byte| byte.is_ascii_digit())
    {
        return None;
    }
    value.parse::<u64>().ok().filter(|parsed| *parsed <= maximum)
}

pub fn conditions_apply(conditions: &str, kind: u16, created_at: u64) -> bool {
    if conditions.is_empty() {
        return true;
    }
    if conditions.bytes().any(|byte| byte.is_ascii_whitespace()) {
        return false;
    }
    conditions.split('&').all(|clause| {
        if let Some(value) = clause.strip_prefix("kind=") {
            canonical_decimal(value, u16::MAX.into()) == Some(u64::from(kind))
        } else if let Some(value) = clause.strip_prefix("created_at<") {
            canonical_decimal(value, u32::MAX.into()).is_some_and(|bound| created_at < bound)
        } else if let Some(value) = clause.strip_prefix("created_at>") {
            canonical_decimal(value, u32::MAX.into()).is_some_and(|bound| created_at > bound)
        } else {
            false
        }
    })
}

pub fn verify_tag(
    tag: &[String],
    agent: &[u8; 32],
    kind: u16,
    created_at: u64,
) -> Result<[u8; 32], SkipReason> {
    if tag.len() != 4 || tag[0] != "auth" {
        return Err(SkipReason::OaMalformed);
    }
    let owner = decode_hex::<32>(&tag[1]).map_err(|_| SkipReason::OaMalformed)?;
    if &owner == agent {
        return Err(SkipReason::OaSelfOwned);
    }
    if !conditions_apply(&tag[2], kind, created_at) {
        return Err(SkipReason::OaWindowViolation);
    }
    let signature = decode_hex::<64>(&tag[3]).map_err(|_| SkipReason::OaMalformed)?;
    let preimage = format!("nostr:agent-auth:{}:{}", lowercase_hex(agent), tag[2]);
    let digest: [u8; 32] = Sha256::digest(preimage.as_bytes()).into();
    let key = VerifyingKey::from_bytes(&owner).map_err(|_| SkipReason::OaInvalidSignature)?;
    let signature =
        Signature::try_from(signature.as_slice()).map_err(|_| SkipReason::OaInvalidSignature)?;
    key.verify_prehash(&digest, &signature).map_err(|_| SkipReason::OaInvalidSignature)?;
    Ok(owner)
}

pub fn owner_for_event(event: &NostrEvent) -> Result<Option<[u8; 32]>, SkipReason> {
    let tags: Vec<_> =
        event.tags.iter().filter(|tag| tag.first().map(String::as_str) == Some("auth")).collect();
    match tags.as_slice() {
        [] => Ok(None),
        [tag] => verify_tag(tag, &event.pubkey, event.kind, event.created_at).map(Some),
        _ => Err(SkipReason::OaAmbiguous),
    }
}

pub fn verify_tag_hard(
    tag: &[String],
    agent: &[u8; 32],
    kind: u16,
    created_at: u64,
) -> Result<[u8; 32], NostrError> {
    verify_tag(tag, agent, kind, created_at).map_err(|_| NostrError::BadOa)
}
