//! Program-agnostic ZK building blocks shared by every trustgraphs program
//! (trust-graph, signer-sync, hypercerts, …).
//!
//! This crate holds the encodings that are NOT specific to any one program: 32-byte ABI
//! words, the chained-hash accumulator fold, the OpenZeppelin StandardMerkleTree, the
//! fixed-point arithmetic, the canonical blob/CIDv1 construction, and the static-ABI
//! journal-tuple discipline. Program semantics (PageRank, edge decoding, journal shapes,
//! params schemas) live in the per-program core crates (`pagerank-core`,
//! `hypercerts-core`), which re-export these modules so each has a single home.
//!
//! Rules, identical to the per-program crates: NO floating point, NO platform-dependent
//! operations, NO non-deterministic iteration, NO async — the identical logic compiles to
//! the SP1 zkVM guest, native (host + tests), and the browser TS port's reference.

pub mod anchor;
pub mod cid;
pub mod fixed;
pub mod fold;
pub mod journal;
pub mod merkle;
pub mod words;
