//! Reorg safety for the transactions a proof depends on.
//!
//! A proof is expensive and a checkpoint is a block-level fact. If the block that minted a
//! checkpoint is reorged away after we have paid to prove it, the money is gone and the proof is
//! worthless. So every transaction a proof depends on — the `trigger()` that minted the
//! checkpoint, and any anchor transactions its lane-2 witness re-folds — is tracked as
//! `(blockNumber, blockHash)` and must be confirmed before the request goes out.
//!
//! Tracking the HASH and not just the number is the part that matters. A reorg of equal depth
//! leaves the number intact and swaps the contents, and "block 100 exists" would then be a
//! meaningless check.

use alloy_primitives::B256;
use serde::{Deserialize, Serialize};

/// A transaction whose effect a proof depends on.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Anchor {
    pub block_number: u64,
    pub block_hash: B256,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", tag = "state")]
pub enum Finality {
    /// Confirmed deeply enough to spend on.
    Final,
    /// Still shallow. Wait; do not spend.
    Pending { confirmations: u64, required: u64 },
    /// The canonical chain has a DIFFERENT block at this height. Whatever we based on it is void.
    Reorged { expected: B256, canonical: B256 },
}

impl Anchor {
    /// Judge this anchor against the chain as it is now.
    ///
    /// `canonical_hash` is the hash the chain currently reports at `self.block_number`, or `None`
    /// if the chain has not reached that height (which is itself a reorg symptom, not just
    /// shallowness — we recorded a block that no longer exists).
    pub fn finality(&self, head: u64, required: u64, canonical_hash: Option<B256>) -> Finality {
        match canonical_hash {
            Some(h) if h != self.block_hash => {
                Finality::Reorged { expected: self.block_hash, canonical: h }
            }
            None => Finality::Reorged { expected: self.block_hash, canonical: B256::ZERO },
            Some(_) => {
                let confirmations = head.saturating_sub(self.block_number);
                if confirmations >= required {
                    Finality::Final
                } else {
                    Finality::Pending { confirmations, required }
                }
            }
        }
    }
}

/// Every anchor a single proof depends on. All of them must be final.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Dependencies {
    pub anchors: Vec<Anchor>,
}

impl Dependencies {
    pub fn push(&mut self, anchor: Anchor) {
        if !self.anchors.contains(&anchor) {
            self.anchors.push(anchor);
        }
    }

    /// The worst finality among the dependencies: a reorg beats a pending, and a pending beats
    /// final. One shallow anchor makes the whole proof unsafe to pay for.
    pub fn worst(
        &self,
        head: u64,
        required: u64,
        canonical: impl Fn(u64) -> Option<B256>,
    ) -> Finality {
        let mut worst = Finality::Final;
        for a in &self.anchors {
            match a.finality(head, required, canonical(a.block_number)) {
                Finality::Reorged { expected, canonical } => {
                    return Finality::Reorged { expected, canonical }
                }
                pending @ Finality::Pending { .. } => {
                    // Keep the shallowest (largest wait).
                    if let (
                        Finality::Pending { confirmations: c1, .. },
                        Finality::Pending { confirmations: c0, .. },
                    ) = (pending, worst)
                    {
                        if c1 < c0 {
                            worst = pending;
                        }
                    } else {
                        worst = pending;
                    }
                }
                Finality::Final => {}
            }
        }
        worst
    }
}
