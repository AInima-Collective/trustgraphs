use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};

use super::NostrError;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct AuditEntry {
    pub sequence: u64,
    pub hash: [u8; 32],
    pub previous_hash: Option<[u8; 32]>,
    pub action: u8,
    pub actor_pubkey: Option<[u8; 32]>,
    pub object_id: Option<String>,
    pub created_at: String,
    pub detail: String,
}

pub fn action_name(code: u8) -> Result<&'static str, NostrError> {
    match code {
        0 => Ok("event_created"),
        1 => Ok("event_deleted"),
        2 => Ok("channel_created"),
        3 => Ok("channel_updated"),
        4 => Ok("channel_deleted"),
        5 => Ok("member_added"),
        6 => Ok("member_removed"),
        7 => Ok("auth_success"),
        8 => Ok("auth_failure"),
        9 => Ok("rate_limit_exceeded"),
        10 => Ok("media_uploaded"),
        _ => Err(NostrError::UnknownAuditAction),
    }
}

fn canonical_json_value(value: &Value, output: &mut String) -> Result<(), NostrError> {
    match value {
        Value::Object(map) => {
            let mut fields: Vec<_> = map.iter().collect();
            fields.sort_unstable_by(|left, right| left.0.cmp(right.0));
            output.push('{');
            for (index, (key, value)) in fields.into_iter().enumerate() {
                if index != 0 {
                    output.push(',');
                }
                output.push_str(&serde_json::to_string(key).map_err(|_| NostrError::Malformed)?);
                output.push(':');
                canonical_json_value(value, output)?;
            }
            output.push('}');
        }
        Value::Array(values) => {
            output.push('[');
            for (index, value) in values.iter().enumerate() {
                if index != 0 {
                    output.push(',');
                }
                canonical_json_value(value, output)?;
            }
            output.push(']');
        }
        scalar => {
            output.push_str(&serde_json::to_string(scalar).map_err(|_| NostrError::Malformed)?)
        }
    }
    Ok(())
}

pub fn require_canonical_json(input: &str) -> Result<(), NostrError> {
    let value: Value = serde_json::from_str(input).map_err(|_| NostrError::Malformed)?;
    let mut canonical = String::new();
    canonical_json_value(&value, &mut canonical)?;
    if canonical != input {
        return Err(NostrError::NonCanonicalAuditDetail);
    }
    Ok(())
}

fn decimal(bytes: &[u8]) -> Option<u32> {
    if bytes.is_empty() || !bytes.iter().all(u8::is_ascii_digit) {
        return None;
    }
    bytes
        .iter()
        .try_fold(0u32, |value, byte| value.checked_mul(10)?.checked_add(u32::from(byte - b'0')))
}

fn valid_rfc3339_micros(value: &str) -> bool {
    let bytes = value.as_bytes();
    if bytes.len() != 32
        || bytes[4] != b'-'
        || bytes[7] != b'-'
        || bytes[10] != b'T'
        || bytes[13] != b':'
        || bytes[16] != b':'
        || bytes[19] != b'.'
        || &bytes[26..] != b"+00:00"
    {
        return false;
    }
    let Some(month) = decimal(&bytes[5..7]) else {
        return false;
    };
    let Some(day) = decimal(&bytes[8..10]) else {
        return false;
    };
    let Some(hour) = decimal(&bytes[11..13]) else {
        return false;
    };
    let Some(minute) = decimal(&bytes[14..16]) else {
        return false;
    };
    let Some(second) = decimal(&bytes[17..19]) else {
        return false;
    };
    let Some(year) = decimal(&bytes[0..4]) else {
        return false;
    };
    let leap = year % 4 == 0 && (year % 100 != 0 || year % 400 == 0);
    let maximum_day = match month {
        2 if leap => 29,
        2 => 28,
        4 | 6 | 9 | 11 => 30,
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        _ => return false,
    };
    year != 0
        && decimal(&bytes[20..26]).is_some()
        && (1..=maximum_day).contains(&day)
        && hour <= 23
        && minute <= 59
        && second <= 59
}

pub fn compute_hash(
    community_id: &[u8; 16],
    entry: &AuditEntry,
    previous: Option<&[u8; 32]>,
) -> Result<[u8; 32], NostrError> {
    let action = action_name(entry.action)?;
    let mut preimage = Vec::with_capacity(256 + entry.detail.len());
    preimage.extend_from_slice(community_id);
    preimage.extend_from_slice(&entry.sequence.to_be_bytes());
    preimage.extend_from_slice(entry.created_at.as_bytes());
    preimage.extend_from_slice(action.as_bytes());
    match entry.actor_pubkey {
        Some(actor) => {
            preimage.push(1);
            preimage.extend_from_slice(&actor);
        }
        None => preimage.push(0),
    }
    match &entry.object_id {
        Some(object_id) => {
            preimage.push(1);
            preimage.extend_from_slice(object_id.as_bytes());
        }
        None => preimage.push(0),
    }
    preimage.extend_from_slice(entry.detail.as_bytes());
    preimage.extend_from_slice(previous.unwrap_or(&[0u8; 32]));
    Ok(Sha256::digest(preimage).into())
}

pub fn verify_prefix(
    community_id: &[u8; 16],
    entries: &[AuditEntry],
) -> Result<[u8; 32], NostrError> {
    let mut previous: Option<[u8; 32]> = None;
    for (index, entry) in entries.iter().enumerate() {
        if entry.sequence != (index + 1) as u64 {
            return Err(NostrError::AuditSequence);
        }
        if entry.previous_hash != previous {
            return Err(NostrError::AuditPreviousHash);
        }
        if !valid_rfc3339_micros(&entry.created_at) {
            return Err(NostrError::Malformed);
        }
        require_canonical_json(&entry.detail)?;
        let computed = compute_hash(community_id, entry, previous.as_ref())?;
        if computed != entry.hash {
            return Err(NostrError::AuditHash);
        }
        previous = Some(computed);
    }
    Ok(previous.unwrap_or([0u8; 32]))
}
