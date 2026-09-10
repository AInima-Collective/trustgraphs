//! The journal discipline: every program's journal is a hand-rolled STATIC-ABI tuple —
//! a concatenation of 32-byte words in a FROZEN field order — and the on-chain verifier
//! binds `keccak256` of those exact bytes.
//!
//! Program crates own their journal shapes (field structs + `*_encoded` functions built
//! from [`crate::words`]); this module holds the shape-independent pieces so a new
//! program cannot invent a second digest convention.

use crate::words::{word_addr, word_u256, word_u64};
use alloy_primitives::{keccak256, Address, B256, U256};
use serde::{Deserialize, Serialize};

/// The common 12-word root-producer journal v3, shared by the trust-graph, weighted-prior,
/// and trust-compose programs (field order FROZEN, OFFCHAIN doc §4.3 + the two v3 bindings).
/// A program with no lane 2 commits the empty lane as the zero accumulator.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Journal {
    pub acc: B256,
    pub leaf_count: u64,
    /// Lane-2 anchor-log accumulator at the checkpoint (`AnchorRegistry.anchorAcc`).
    pub anchor_acc: B256,
    /// Lane-2 anchor count at the checkpoint.
    pub anchor_count: u64,
    pub params_hash: B256,
    pub output_root: B256,
    pub ipfs_hash: B256,
    pub cid_digest: B256,
    pub total_value: U256,
    /// Chained fold over rule-Φ / deterministic-skip entries (`crate::anchor::skipped_digest`);
    /// `bytes32(0)` when nothing was skipped (or the instance has no lane 2).
    pub skipped_digest: B256,
    /// v3: the bounty payee, committed verbatim from the prover's binding. Bound because
    /// `submitProof` folds its own `recipient` argument into the digest, so the fee provably
    /// follows the journal rather than `msg.sender` — a copied transaction pays the original
    /// prover.
    pub recipient: Address,
    /// v3: the instance this proof is for. Bound because `submitProof` rebuilds it from
    /// `address(this)` and `block.chainid` — see [`instance_domain`].
    pub instance_domain: B256,
}

/// The ABI-encoded journal-v3 tuple — the exact bytes the SP1 guest commits as `publicValues`,
/// and the preimage of the journal digest:
/// `abi.encode(bytes32 acc, uint64 leafCount, bytes32 anchorAcc, uint64 anchorCount,
///             bytes32 paramsHash, bytes32 outputRoot, bytes32 ipfsHash, bytes32 cidDigest,
///             uint256 totalValue, bytes32 skippedDigest,
///             address recipient, bytes32 instanceDomain)`.
pub fn journal_encoded(j: &Journal) -> Vec<u8> {
    let mut buf = Vec::with_capacity(32 * 12);
    buf.extend_from_slice(j.acc.as_slice());
    buf.extend_from_slice(&word_u64(j.leaf_count));
    buf.extend_from_slice(j.anchor_acc.as_slice());
    buf.extend_from_slice(&word_u64(j.anchor_count));
    buf.extend_from_slice(j.params_hash.as_slice());
    buf.extend_from_slice(j.output_root.as_slice());
    buf.extend_from_slice(j.ipfs_hash.as_slice());
    buf.extend_from_slice(j.cid_digest.as_slice());
    buf.extend_from_slice(&word_u256(j.total_value));
    buf.extend_from_slice(j.skipped_digest.as_slice());
    buf.extend_from_slice(&word_addr(j.recipient));
    buf.extend_from_slice(j.instance_domain.as_slice());
    buf
}

/// The journal digest the on-chain verifier binds: `keccak256(journal_encoded(j))`.
pub fn journal_digest(j: &Journal) -> B256 {
    keccak256(journal_encoded(j))
}

/// Concatenate 32-byte ABI words into the encoded static tuple (`abi.encode` of a tuple
/// whose members are all static types).
pub fn encode_words(words: &[[u8; 32]]) -> Vec<u8> {
    let mut buf = Vec::with_capacity(32 * words.len());
    for w in words {
        buf.extend_from_slice(w);
    }
    buf
}

/// The journal digest the on-chain verifier binds: `keccak256(encoded)`.
pub fn digest(encoded: &[u8]) -> B256 {
    keccak256(encoded)
}

/// Universal domain separation: `keccak256(abi.encode(address snapshot, uint256 chainId))`.
///
/// Every program's journal commits this value, and `MerkleSnapshot.submitProof` REBUILDS it from
/// `address(this)` and `block.chainid` rather than accepting it as an argument. Two consequences,
/// both deliberate:
///
/// 1. A submitter cannot lie about which instance a proof is for — a proof carrying instance A's
///    domain produces a digest that instance B's `submitProof` never computes.
/// 2. No program's params codec has to remember to include an instance-unique field. This is the
///    universal form of the fix `INSTANCE_FACTORY.md` §6.1 made per-program in the trust-graph
///    params schema, and it is what closes the hypercerts hole (its params carry no
///    instance-unique field at all, so two identically-configured hypercerts instances accepted
///    each other's proofs — issue #9).
///
/// `chain_id` is encoded as a `uint256` because that is the Solidity type of `block.chainid`.
pub fn instance_domain(snapshot: Address, chain_id: u64) -> B256 {
    keccak256(encode_words(&[word_addr(snapshot), word_u256(U256::from(chain_id))]))
}
