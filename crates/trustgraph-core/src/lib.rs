//! Trustgraphs root-producer statement with strict optional EAS off-chain envelope 0.
//!
//! Lane-1 scoring and all frozen encodings remain in `pagerank-core`. This crate adds only the
//! Trustgraphs-specific strict lane-2 witness and computation, keeping companion guests that depend
//! on `pagerank-core` byte-identical.

use alloy_primitives::B256;
use serde::{Deserialize, Serialize};

pub use pagerank_core::{AnchorRecord, Binding, ComputeResult, Journal, Params, RawEdge};

pub mod compute;
pub mod lane2;

#[cfg(test)]
mod tests;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Envelope0AnchorAuthorization {
    pub fold_index: u64,
    #[serde(with = "zk_core::serde_hex")]
    pub head_signature: Vec<u8>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Envelope0PayloadWitness {
    pub node_id: B256,
    #[serde(with = "zk_core::serde_hex")]
    pub payload: Vec<u8>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Lane2Witness {
    pub anchors: Vec<AnchorRecord>,
    pub authorizations: Vec<Envelope0AnchorAuthorization>,
    pub payloads: Vec<Envelope0PayloadWitness>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct GuestInput {
    pub edges: Vec<RawEdge>,
    pub params: Params,
    #[serde(default)]
    pub lane2: Option<Lane2Witness>,
    #[serde(default)]
    pub binding: Binding,
}
