//! Canonical fixed-point Trust-Aware PageRank — the TypeScript mirror of the Rust
//! `crates/pagerank-core` crate (the single source of truth). Browser-recomputed scores, merkle
//! roots, and CIDs produced here are byte-identical to what the SP1 zk guest commits.
//!
//! See `PLAN.md` §1 (frozen byte formats) and §2 (fixed-point algorithm spec).

export * from './types'
export { compute, journalDigest } from './compute'
export {
  accumulate,
  edgeLeaf,
  fold,
  decodeWeight,
  journalEncoded,
  paramsHash,
  selectionParamsHash,
  signerJournalEncoded,
  signerJournalDigest,
} from './encode'
export {
  buildTree,
  merkleRoot,
  outputLeaf,
  proofFor,
  seedSetRoot,
  signerSetRoot,
} from './merkle'
export { selectSigners, computeSigners } from './signer'
export { buildGraph, type Graph } from './reconcile'
export { calculate } from './pagerank'
export { distributePoints } from './distribute'
export { canonicalBlob, cidV1Raw } from './cid'
export { mulDiv, fpMul, fpDiv } from './fixed'
