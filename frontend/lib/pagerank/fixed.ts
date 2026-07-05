//! Fixed-point helpers. All arithmetic is integer `bigint` at scale S = `precisionScale` (1e18).
//! `bigint` maps cleanly to U256 for our magnitudes; products cannot overflow (arbitrary precision).
//! Mirrors `pagerank_core::fixed`.

/**
 * `(a * b) / d`, truncating toward zero (matches U256 integer division for non-negative operands).
 * Callers guard `d != 0` explicitly, matching the Rust early-exits.
 */
export const mulDiv = (a: bigint, b: bigint, d: bigint): bigint => (a * b) / d

/** `(a * b) / S` — the canonical fixed-point multiply (both operands scaled by S). */
export const fpMul = (a: bigint, b: bigint, scale: bigint): bigint =>
  mulDiv(a, b, scale)

/** `(a * S) / b` — the canonical fixed-point divide (result scaled by S). */
export const fpDiv = (a: bigint, b: bigint, scale: bigint): bigint =>
  mulDiv(a, scale, b)
