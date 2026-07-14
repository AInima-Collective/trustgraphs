//! Fixed-point helpers. All arithmetic is integer `U256` at scale S = `precision_scale` (1e18).
//! Products use a 512-bit intermediate so `a * b` cannot overflow before the divide.

use alloy_primitives::{U256, U512};

/// `(a * b) / d`, computed with a widened 512-bit intermediate (no overflow on `a * b`).
///
/// Panics on `d == 0` (a programming error — callers guard division by zero explicitly, matching
/// the legacy `total_base_weight == 0` / `total_scaled_score.is_zero()` early-exits).
#[inline]
pub fn mul_div(a: U256, b: U256, d: U256) -> U256 {
    debug_assert!(!d.is_zero(), "mul_div by zero");
    let prod = U512::from(a) * U512::from(b);
    let q = prod / U512::from(d);
    // The mathematical result always fits in 256 bits for our magnitudes; truncation is a no-op.
    U256::from_limbs([q.as_limbs()[0], q.as_limbs()[1], q.as_limbs()[2], q.as_limbs()[3]])
}

/// `(a * b) / S` — the canonical fixed-point multiply (both operands scaled by S).
#[inline]
pub fn fp_mul(a: U256, b: U256, scale: U256) -> U256 {
    mul_div(a, b, scale)
}

/// `(a * S) / b` — the canonical fixed-point divide (result scaled by S).
#[inline]
pub fn fp_div(a: U256, b: U256, scale: U256) -> U256 {
    mul_div(a, scale, b)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn s() -> U256 {
        U256::from(1_000_000_000_000_000_000u64)
    }

    #[test]
    fn fp_mul_half_times_half() {
        let half = s() / U256::from(2);
        // 0.5 * 0.5 = 0.25
        assert_eq!(fp_mul(half, half, s()), s() / U256::from(4));
    }

    #[test]
    fn fp_div_one_by_four() {
        let one = s();
        let four = U256::from(4) * s();
        // 1 / 4 = 0.25
        assert_eq!(fp_div(one, four, s()), s() / U256::from(4));
    }

    #[test]
    fn mul_div_no_overflow_large() {
        // 1e6 * 1e30 / 1e6 == 1e30 (would overflow a naive 256-bit a*b only for far larger inputs,
        // but this exercises the widened path).
        let a = U256::from(1_000_000u64);
        let b = U256::from(10).pow(U256::from(30));
        let d = U256::from(1_000_000u64);
        assert_eq!(mul_div(a, b, d), b);
    }
}
