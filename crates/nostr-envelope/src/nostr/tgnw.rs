use super::audit::{action_name, require_canonical_json, AuditEntry};
use super::event::NostrEvent;
use super::{CommitmentVariant, NostrError, NostrLimits};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TgnwBundle {
    pub variant: CommitmentVariant,
    pub community_id: [u8; 16],
    pub instance_domain: [u8; 32],
    pub authority: [u8; 32],
    pub audit: Vec<AuditEntry>,
    pub events: Vec<NostrEvent>,
    pub head_event: Option<NostrEvent>,
}

struct Cursor<'a> {
    input: &'a [u8],
    offset: usize,
}

impl<'a> Cursor<'a> {
    fn new(input: &'a [u8], limits: &NostrLimits) -> Result<Self, NostrError> {
        if input.len() > limits.envelope_bytes as usize {
            return Err(NostrError::LimitExceeded);
        }
        Ok(Self { input, offset: 0 })
    }

    fn take(&mut self, length: usize) -> Result<&'a [u8], NostrError> {
        let end = self.offset.checked_add(length).ok_or(NostrError::Malformed)?;
        if end > self.input.len() {
            return Err(NostrError::Malformed);
        }
        let output = &self.input[self.offset..end];
        self.offset = end;
        Ok(output)
    }

    fn byte(&mut self) -> Result<u8, NostrError> {
        Ok(self.take(1)?[0])
    }

    fn u16(&mut self) -> Result<u16, NostrError> {
        Ok(u16::from_be_bytes(self.take(2)?.try_into().unwrap()))
    }

    fn u32(&mut self) -> Result<u32, NostrError> {
        Ok(u32::from_be_bytes(self.take(4)?.try_into().unwrap()))
    }

    fn u64(&mut self) -> Result<u64, NostrError> {
        Ok(u64::from_be_bytes(self.take(8)?.try_into().unwrap()))
    }

    fn string(&mut self, maximum: u32) -> Result<String, NostrError> {
        let length = self.u32()? as usize;
        if length > maximum as usize {
            return Err(NostrError::LimitExceeded);
        }
        String::from_utf8(self.take(length)?.to_vec()).map_err(|_| NostrError::Malformed)
    }
}

fn parse_optional_32(cursor: &mut Cursor<'_>) -> Result<Option<[u8; 32]>, NostrError> {
    match cursor.byte()? {
        0 => Ok(None),
        1 => Ok(Some(cursor.take(32)?.try_into().unwrap())),
        _ => Err(NostrError::Malformed),
    }
}

fn parse_optional_string(
    cursor: &mut Cursor<'_>,
    maximum: u32,
) -> Result<Option<String>, NostrError> {
    match cursor.byte()? {
        0 => Ok(None),
        1 => cursor.string(maximum).map(Some),
        _ => Err(NostrError::Malformed),
    }
}

fn parse_audit(cursor: &mut Cursor<'_>, limits: &NostrLimits) -> Result<AuditEntry, NostrError> {
    let sequence = cursor.u64()?;
    let hash = cursor.take(32)?.try_into().unwrap();
    let previous_hash = parse_optional_32(cursor)?;
    let action = cursor.byte()?;
    action_name(action)?;
    let actor_pubkey = parse_optional_32(cursor)?;
    let object_id = parse_optional_string(cursor, 1_024)?;
    let created_at = cursor.string(64)?;
    let detail = cursor.string(limits.audit_detail_bytes)?;
    require_canonical_json(&detail)?;
    Ok(AuditEntry {
        sequence,
        hash,
        previous_hash,
        action,
        actor_pubkey,
        object_id,
        created_at,
        detail,
    })
}

fn parse_event(cursor: &mut Cursor<'_>, limits: &NostrLimits) -> Result<NostrEvent, NostrError> {
    let start = cursor.offset;
    let id = cursor.take(32)?.try_into().unwrap();
    let pubkey = cursor.take(32)?.try_into().unwrap();
    let created_at = cursor.u64()?;
    let kind = cursor.u32()?;
    if kind > u32::from(u16::MAX) {
        return Err(NostrError::Malformed);
    }
    let tag_count = cursor.u32()?;
    if tag_count > limits.tags_per_event {
        return Err(NostrError::LimitExceeded);
    }
    let mut tags = Vec::with_capacity(tag_count as usize);
    let mut all_tag_bytes = 0u32;
    for _ in 0..tag_count {
        let element_count = cursor.u32()?;
        if element_count > limits.elements_per_tag {
            return Err(NostrError::LimitExceeded);
        }
        let mut tag = Vec::with_capacity(element_count as usize);
        for _ in 0..element_count {
            let element = cursor.string(limits.tag_string_bytes)?;
            all_tag_bytes = all_tag_bytes
                .checked_add(u32::try_from(element.len()).map_err(|_| NostrError::LimitExceeded)?)
                .ok_or(NostrError::LimitExceeded)?;
            if all_tag_bytes > limits.all_tag_strings_bytes {
                return Err(NostrError::LimitExceeded);
            }
            tag.push(element);
        }
        tags.push(tag);
    }
    let content = cursor.string(limits.content_bytes)?;
    let sig = cursor.take(64)?.to_vec();
    if cursor.offset - start > limits.encoded_event_bytes as usize {
        return Err(NostrError::LimitExceeded);
    }
    Ok(NostrEvent { id, pubkey, created_at, kind: kind as u16, tags, content, sig })
}

pub fn decode(input: &[u8], limits: &NostrLimits) -> Result<TgnwBundle, NostrError> {
    let mut cursor = Cursor::new(input, limits)?;
    if cursor.take(4)? != b"TGNW" || cursor.byte()? != 1 {
        return Err(NostrError::Malformed);
    }
    let variant = match cursor.byte()? {
        1 => CommitmentVariant::BuzzAuditV1,
        2 => CommitmentVariant::SelfLogV1,
        _ => return Err(NostrError::UnsupportedVariant),
    };
    if cursor.u16()? != 0 {
        return Err(NostrError::Malformed);
    }
    let community_id = cursor.take(16)?.try_into().unwrap();
    let instance_domain = cursor.take(32)?.try_into().unwrap();
    let authority = cursor.take(32)?.try_into().unwrap();

    let mut audit = Vec::new();
    let mut events = Vec::new();
    let head_event = match variant {
        CommitmentVariant::BuzzAuditV1 => {
            let audit_count = cursor.u32()?;
            if audit_count > limits.audit_entries {
                return Err(NostrError::LimitExceeded);
            }
            audit.reserve(audit_count as usize);
            for _ in 0..audit_count {
                audit.push(parse_audit(&mut cursor, limits)?);
            }
            let event_count = cursor.u32()?;
            if event_count > limits.events {
                return Err(NostrError::LimitExceeded);
            }
            events.reserve(event_count as usize);
            for _ in 0..event_count {
                events.push(parse_event(&mut cursor, limits)?);
            }
            None
        }
        CommitmentVariant::SelfLogV1 => {
            let event_count = cursor.u32()?;
            if event_count > limits.events {
                return Err(NostrError::LimitExceeded);
            }
            events.reserve(event_count as usize);
            for _ in 0..event_count {
                events.push(parse_event(&mut cursor, limits)?);
            }
            Some(parse_event(&mut cursor, limits)?)
        }
    };
    if cursor.offset != input.len() {
        return Err(NostrError::TrailingBytes);
    }
    Ok(TgnwBundle { variant, community_id, instance_domain, authority, audit, events, head_event })
}

fn push_u32(output: &mut Vec<u8>, value: usize) -> Result<(), NostrError> {
    output.extend_from_slice(
        &u32::try_from(value).map_err(|_| NostrError::LimitExceeded)?.to_be_bytes(),
    );
    Ok(())
}

fn push_string(output: &mut Vec<u8>, value: &str) -> Result<(), NostrError> {
    push_u32(output, value.len())?;
    output.extend_from_slice(value.as_bytes());
    Ok(())
}

fn encode_optional_32(output: &mut Vec<u8>, value: Option<&[u8; 32]>) {
    match value {
        Some(value) => {
            output.push(1);
            output.extend_from_slice(value);
        }
        None => output.push(0),
    }
}

fn encode_audit(output: &mut Vec<u8>, entry: &AuditEntry) -> Result<(), NostrError> {
    output.extend_from_slice(&entry.sequence.to_be_bytes());
    output.extend_from_slice(&entry.hash);
    encode_optional_32(output, entry.previous_hash.as_ref());
    output.push(entry.action);
    encode_optional_32(output, entry.actor_pubkey.as_ref());
    match &entry.object_id {
        Some(object_id) => {
            output.push(1);
            push_string(output, object_id)?;
        }
        None => output.push(0),
    }
    push_string(output, &entry.created_at)?;
    push_string(output, &entry.detail)?;
    Ok(())
}

fn encode_event(output: &mut Vec<u8>, event: &NostrEvent) -> Result<(), NostrError> {
    output.extend_from_slice(&event.id);
    output.extend_from_slice(&event.pubkey);
    output.extend_from_slice(&event.created_at.to_be_bytes());
    output.extend_from_slice(&u32::from(event.kind).to_be_bytes());
    push_u32(output, event.tags.len())?;
    for tag in &event.tags {
        push_u32(output, tag.len())?;
        for element in tag {
            push_string(output, element)?;
        }
    }
    push_string(output, &event.content)?;
    output.extend_from_slice(&event.sig);
    Ok(())
}

pub fn encode(bundle: &TgnwBundle) -> Result<Vec<u8>, NostrError> {
    let mut output = Vec::new();
    output.extend_from_slice(b"TGNW");
    output.push(1);
    output.push(bundle.variant as u8);
    output.extend_from_slice(&0u16.to_be_bytes());
    output.extend_from_slice(&bundle.community_id);
    output.extend_from_slice(&bundle.instance_domain);
    output.extend_from_slice(&bundle.authority);
    match bundle.variant {
        CommitmentVariant::BuzzAuditV1 => {
            if bundle.head_event.is_some() {
                return Err(NostrError::Malformed);
            }
            push_u32(&mut output, bundle.audit.len())?;
            for entry in &bundle.audit {
                encode_audit(&mut output, entry)?;
            }
            push_u32(&mut output, bundle.events.len())?;
            for event in &bundle.events {
                encode_event(&mut output, event)?;
            }
        }
        CommitmentVariant::SelfLogV1 => {
            if !bundle.audit.is_empty() {
                return Err(NostrError::Malformed);
            }
            push_u32(&mut output, bundle.events.len())?;
            for event in &bundle.events {
                encode_event(&mut output, event)?;
            }
            encode_event(&mut output, bundle.head_event.as_ref().ok_or(NostrError::Malformed)?)?;
        }
    }
    Ok(output)
}
