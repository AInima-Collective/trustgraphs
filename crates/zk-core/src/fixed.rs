//! Fixed-point helpers. All arithmetic is integer `U256` at scale S = `precision_scale` (1e18).
//! Products use a 512-bit intermediate so `a * b` cannot overflow before the divide.

use alloy_primitives::{U256, U512};

/// `(a * b) / d`, computed with a widened 512-bit intermediate (no overflow on `a * b`).
///
/// Panics on `d == 0` (a programming error — callers guard division by zero explicitly, matching
/// the legacy `total_base_weight == 0` / `total_scaled_score.is_zero()` early-exits).
///
/// Panics if the QUOTIENT does not fit in 256 bits. Rank callers establish the stronger executable
/// invariant that total standing never exceeds the fixed-point scale on any iteration: row ratios
/// sum to at most one, trust decay is at most one, damping is below one, and teleport uses the
/// remaining fraction. Other callers must establish their own bounds. Keeping the widened check
/// here turns any future invariant drift into an explicit guest failure instead of truncating a
/// consensus value or diverging from the TypeScript `bigint` port.
#[inline]
pub fn mul_div(a: U256, b: U256, d: U256) -> U256 {
    debug_assert!(!d.is_zero(), "mul_div by zero");
    let prod = U512::from(a) * U512::from(b);
    let q = prod / U512::from(d);
    let limbs = q.as_limbs();
    assert!(
        limbs[4] == 0 && limbs[5] == 0 && limbs[6] == 0 && limbs[7] == 0,
        "mul_div overflow: quotient exceeds 256 bits (params outside the representable range)"
    );
    U256::from_limbs([limbs[0], limbs[1], limbs[2], limbs[3]])
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
