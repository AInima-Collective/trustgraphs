//! Issue-60 research codec for a cooperating ERC-8004 event accumulator.
//!
//! This crate is deliberately detached from the production workspace and from every shipped guest.
//! It independently reproduces the TypeScript/Solidity golden bytes so a later implementation can
//! promote a reviewed version without silently rotating an existing program.

use alloy_primitives::{keccak256, Address, Bytes, B256};
use serde::{Deserialize, Serialize};

pub const EVENT_DOMAIN_TEXT: &[u8] = b"TRUSTGRAPHS_ERC8004_EVENT_V1";
pub const CHECKPOINT_DOMAIN_TEXT: &[u8] = b"TRUSTGRAPHS_ERC8004_CHECKPOINT_V1";
pub const EVENT_SET_VERSION_TEXT: &[u8] = b"TRUSTGRAPHS_ERC8004_EVENT_SET_V1";

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CanonicalEvent {
    pub chain_id: u64,
    pub registry: Address,
    pub block_number: u64,
    pub sequence: u64,
    pub implementation_code_hash: B256,
    pub event_set_version: B256,
    pub kind: u8,
    pub topics: Vec<B256>,
    pub data: Bytes,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Checkpoint {
    pub chain_id: u64,
    pub accumulator: Address,
    pub identity_registry: Address,
    pub reputation_registry: Address,
    pub activation_block: u64,
    pub end_block: u64,
    pub end_block_hash: B256,
    pub count: u64,
    pub head: B256,
    pub event_set_version: B256,
    pub identity_implementation_code_hash: B256,
    pub reputation_implementation_code_hash: B256,
    pub preimage_commitment: B256,
}

fn uint_word(value: u64) -> [u8; 32] {
    let mut word = [0u8; 32];
    word[24..].copy_from_slice(&value.to_be_bytes());
    word
}

fn address_word(value: Address) -> [u8; 32] {
    let mut word = [0u8; 32];
    word[12..].copy_from_slice(value.as_slice());
    word
}

fn push_word(output: &mut Vec<u8>, value: B256) {
    output.extend_from_slice(value.as_slice());
}

pub fn event_domain() -> B256 {
    keccak256(EVENT_DOMAIN_TEXT)
}

pub fn checkpoint_domain() -> B256 {
    keccak256(CHECKPOINT_DOMAIN_TEXT)
}

pub fn event_set_version() -> B256 {
    keccak256(EVENT_SET_VERSION_TEXT)
}

pub fn topics_hash(topics: &[B256]) -> B256 {
    assert!(topics.len() <= 4, "an EVM log has at most four topics");
    let mut preimage = Vec::with_capacity(1 + topics.len() * 32);
    preimage.push(topics.len() as u8);
    for topic in topics {
        preimage.extend_from_slice(topic.as_slice());
    }
    keccak256(preimage)
}

pub fn preimage_hash(topics: &[B256], data: &[u8]) -> B256 {
    assert!(topics.len() <= 4, "an EVM log has at most four topics");
    let mut preimage = Vec::with_capacity(9 + topics.len() * 32 + data.len());
    preimage.push(topics.len() as u8);
    for topic in topics {
        preimage.extend_from_slice(topic.as_slice());
    }
    preimage.extend_from_slice(&(data.len() as u64).to_be_bytes());
    preimage.extend_from_slice(data);
    keccak256(preimage)
}

/// `keccak256(abi.encode(EVENT_DOMAIN, chainId, registry, blockNumber, sequence,
/// implementationCodeHash, eventSetVersion, kind, topicsHash, dataHash))`.
pub fn event_leaf(event: &CanonicalEvent) -> B256 {
    let mut encoded = Vec::with_capacity(10 * 32);
    push_word(&mut encoded, event_domain());
    encoded.extend_from_slice(&uint_word(event.chain_id));
    encoded.extend_from_slice(&address_word(event.registry));
    encoded.extend_from_slice(&uint_word(event.block_number));
    encoded.extend_from_slice(&uint_word(event.sequence));
    push_word(&mut encoded, event.implementation_code_hash);
    push_word(&mut encoded, event.event_set_version);
    encoded.extend_from_slice(&uint_word(event.kind as u64));
    push_word(&mut encoded, topics_hash(&event.topics));
    push_word(&mut encoded, keccak256(&event.data));
    debug_assert_eq!(encoded.len(), 320);
    keccak256(encoded)
}

pub fn fold(previous: B256, leaf: B256) -> B256 {
    let mut encoded = [0u8; 64];
    encoded[..32].copy_from_slice(previous.as_slice());
    encoded[32..].copy_from_slice(leaf.as_slice());
    keccak256(encoded)
}

pub fn replay(events: &[CanonicalEvent]) -> (B256, B256) {
    let mut head = B256::ZERO;
    let mut preimage_head = B256::ZERO;
    for (index, event) in events.iter().enumerate() {
        assert_eq!(event.sequence, index as u64, "non-contiguous event sequence");
        head = fold(head, event_leaf(event));
        preimage_head = fold(preimage_head, preimage_hash(&event.topics, &event.data));
    }
    (head, preimage_head)
}

pub fn checkpoint_digest(checkpoint: &Checkpoint) -> B256 {
    let mut encoded = Vec::with_capacity(14 * 32);
    push_word(&mut encoded, checkpoint_domain());
    encoded.extend_from_slice(&uint_word(checkpoint.chain_id));
    encoded.extend_from_slice(&address_word(checkpoint.accumulator));
    encoded.extend_from_slice(&address_word(checkpoint.identity_registry));
    encoded.extend_from_slice(&address_word(checkpoint.reputation_registry));
    encoded.extend_from_slice(&uint_word(checkpoint.activation_block));
    encoded.extend_from_slice(&uint_word(checkpoint.end_block));
    push_word(&mut encoded, checkpoint.end_block_hash);
    encoded.extend_from_slice(&uint_word(checkpoint.count));
    push_word(&mut encoded, checkpoint.head);
    push_word(&mut encoded, checkpoint.event_set_version);
    push_word(&mut encoded, checkpoint.identity_implementation_code_hash);
    push_word(&mut encoded, checkpoint.reputation_implementation_code_hash);
    push_word(&mut encoded, checkpoint.preimage_commitment);
    debug_assert_eq!(encoded.len(), 448);
    keccak256(encoded)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde::Deserialize;
    use std::{fs, path::PathBuf, str::FromStr};

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Golden {
        constants: Constants,
        events: Vec<EventVector>,
        checkpoint: CheckpointVector,
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Constants {
        event_domain: B256,
        checkpoint_domain: B256,
        event_set_version: B256,
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct EventVector {
        chain_id: String,
        registry: String,
        block_number: String,
        sequence: String,
        implementation_code_hash: B256,
        event_set_version: B256,
        kind: u8,
        topics: Vec<B256>,
        data: Bytes,
        topics_hash: B256,
        data_hash: B256,
        preimage_hash: B256,
        leaf: B256,
        head_after: B256,
        preimage_head_after: B256,
    }

    impl EventVector {
        fn event(&self) -> CanonicalEvent {
            CanonicalEvent {
                chain_id: self.chain_id.parse().unwrap(),
                registry: Address::from_str(&self.registry).unwrap(),
                block_number: self.block_number.parse().unwrap(),
                sequence: self.sequence.parse().unwrap(),
                implementation_code_hash: self.implementation_code_hash,
                event_set_version: self.event_set_version,
                kind: self.kind,
                topics: self.topics.clone(),
                data: self.data.clone(),
            }
        }
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct CheckpointVector {
        chain_id: String,
        accumulator: String,
        identity_registry: String,
        reputation_registry: String,
        activation_block: String,
        end_block: String,
        end_block_hash: B256,
        count: String,
        head: B256,
        event_set_version: B256,
        identity_implementation_code_hash: B256,
        reputation_implementation_code_hash: B256,
        preimage_commitment: B256,
        digest: B256,
    }

    impl CheckpointVector {
        fn checkpoint(&self) -> Checkpoint {
            Checkpoint {
                chain_id: self.chain_id.parse().unwrap(),
                accumulator: Address::from_str(&self.accumulator).unwrap(),
                identity_registry: Address::from_str(&self.identity_registry).unwrap(),
                reputation_registry: Address::from_str(&self.reputation_registry).unwrap(),
                activation_block: self.activation_block.parse().unwrap(),
                end_block: self.end_block.parse().unwrap(),
                end_block_hash: self.end_block_hash,
                count: self.count.parse().unwrap(),
                head: self.head,
                event_set_version: self.event_set_version,
                identity_implementation_code_hash: self.identity_implementation_code_hash,
                reputation_implementation_code_hash: self.reputation_implementation_code_hash,
                preimage_commitment: self.preimage_commitment,
            }
        }
    }

    fn golden() -> Golden {
        let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../golden.json");
        serde_json::from_slice(&fs::read(path).unwrap()).unwrap()
    }

    #[test]
    fn type_script_solidity_and_rust_vectors_match() {
        let golden = golden();
        assert_eq!(event_domain(), golden.constants.event_domain);
        assert_eq!(checkpoint_domain(), golden.constants.checkpoint_domain);
        assert_eq!(event_set_version(), golden.constants.event_set_version);
        let mut head = B256::ZERO;
        let mut preimage_head = B256::ZERO;
        let events = golden
            .events
            .iter()
            .map(|vector| {
                let event = vector.event();
                assert_eq!(topics_hash(&event.topics), vector.topics_hash);
                assert_eq!(keccak256(&event.data), vector.data_hash);
                assert_eq!(preimage_hash(&event.topics, &event.data), vector.preimage_hash);
                let leaf = event_leaf(&event);
                assert_eq!(leaf, vector.leaf);
                head = fold(head, leaf);
                preimage_head = fold(preimage_head, vector.preimage_hash);
                assert_eq!(head, vector.head_after);
                assert_eq!(preimage_head, vector.preimage_head_after);
                event
            })
            .collect::<Vec<_>>();
        assert_eq!(replay(&events), (head, preimage_head));

        let checkpoint = golden.checkpoint.checkpoint();
        assert_eq!(checkpoint.head, head);
        assert_eq!(checkpoint.preimage_commitment, preimage_head);
        assert_eq!(checkpoint_digest(&checkpoint), golden.checkpoint.digest);
    }
}
