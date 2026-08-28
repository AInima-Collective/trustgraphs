//! Lane-2 envelopes: per-identity completeness commitments verified in-guest.
//!
//! An envelope implements one contract (OFFCHAIN_ATTESTATIONS_ZK §4.2): *given a head and
//! witness bytes, either produce the COMPLETE, authenticated edge set behind that head, or
//! fail.* The guest never partially accepts an envelope — a failure trips rule Φ for that
//! node and is committed in `skippedDigest`, never silently dropped.
//!
//! One module per substrate; this crate carries envelope 1 (atproto repo commit). Envelope 0
//! (EAS offchain) lives in `eas-offchain` and envelope 2 (Nostr) in `nostr-envelope`, each
//! isolated so a guest pulls in only the substrate it verifies. Dispatch is a plain match on
//! `envelope_kind` — no dyn traits; the guest must be deterministic and auditable.
//!
//! Rules identical to the other guest crates: NO floats, NO non-deterministic iteration,
//! NO platform-dependent operations.

pub mod atproto;
pub mod ecdsa;

use alloy_primitives::{Address, B256};
use serde::{Deserialize, Serialize};

/// An edge whose authorship the envelope has cryptographically established. The program crate
/// maps these into its own edge semantics (for trust-graph: `RawEdge`-equivalent inputs to
/// reconciliation, entering the total order with `time` and the anchor fold index).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct AuthedEdge {
    /// The authenticated author (for envelope 0: recovered from the per-edge EIP-712 signature
    /// and required to equal the log owner).
    pub attester: Address,
    pub recipient: Address,
    /// The envelope-native unique id (EAS offchain v2 UID for envelope 0).
    pub uid: B256,
    /// The edge's self-declared time (drives reconciliation order within the node's set).
    pub time: u64,
    /// Raw attestation `data` (same ABI schema as lane 1: `(string comment, uint256 confidence)`).
    pub data: Vec<u8>,
}

/// Why an envelope failed verification. Every variant maps to a closed rule-Φ skip reason in
/// the program crate — failure is a *provable event*, not an abort.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EnvelopeError {
    /// The witness does not re-fold to the anchored head (incomplete or reordered log).
    HeadMismatch,
    /// The witnessed log length differs from the anchored count (H-5: the count is part of
    /// the anchored claim; a head can only verify at the exact length its owner co-signed).
    CountMismatch,
    /// The head signature does not recover to the log owner.
    BadHeadSignature,
    /// A per-edge signature is invalid or recovers to someone other than the log owner.
    BadEdgeSignature,
    /// An attest entry has no matching witnessed attestation (or UID mismatch).
    MissingAttestation,
    /// A revoke entry references a UID never attested in this log.
    RevokeUnknownUid,
    /// Malformed structure (bad lengths, unknown version, undecodable fields).
    Malformed,
    /// The attestation's EIP-712 domain separator is not in the pinned accepted set.
    UnknownDomain,
}
