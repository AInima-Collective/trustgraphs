//! Fixed-point helpers. All arithmetic is integer `bigint` at scale S = `precisionScale` (1e18).
//! Mirrors `pagerank_core::fixed`.
//!
//! `bigint` is arbitrary-precision and the guest's U256 is not, so "mirrors" is only true while
//! results stay under 2^256. They used to diverge silently past that point — the guest truncated,
//! this port kept going — which meant the browser preview could show different payouts, and a
//! different ranking order, from the proof. Both sides now refuse instead: the guest panics (no
//! proof exists) and this throws (no preview is shown). See `crates/zk-core/src/fixed.rs`.

/** The guest's ceiling: results at or above this do not exist in U256. */
const U256_MAX = (1n << 256n) - 1n

/** Checked U256 addition, matching Rust's `checked_add(...).expect(...)`. */
export const checkedAdd = (a: bigint, b: bigint, context: string): bigint => {
  const sum = a + b
  if (sum > U256_MAX) {
    throw new RangeError(`${context} overflowed 256 bits`)
  }
  return sum
}

/**
 * `(a * b) / d`, truncating toward zero (matches U256 integer division for non-negative operands).
 * Callers guard `d != 0` explicitly, matching the Rust early-exits.
 *
 * Throws if the quotient exceeds 256 bits, mirroring `mul_div`'s assertion. Silently returning the
 * mathematically-correct-but-unrepresentable answer would be worse than failing: it would disagree
 * with what any proof can commit.
 */
export const mulDiv = (a: bigint, b: bigint, d: bigint): bigint => {
  const q = (a * b) / d
  if (q > U256_MAX) {
    throw new RangeError(
      'mulDiv overflow: quotient exceeds 256 bits (params outside the representable range)'
    )
  }
  return q
}

/** `(a * b) / S` — the canonical fixed-point multiply (both operands scaled by S). */
export const fpMul = (a: bigint, b: bigint, scale: bigint): bigint =>
  mulDiv(a, b, scale)

/** `(a * S) / b` — the canonical fixed-point divide (result scaled by S). */
export const fpDiv = (a: bigint, b: bigint, scale: bigint): bigint =>
  mulDiv(a, scale, b)
