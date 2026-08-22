//! Strict decimal-string → fixed-point parser (HYPERCERTS_ATPROTO_PLAN §2: "numbers are
//! strings and weights are un-normalized by design"). Any string outside the closed grammar
//! is a DETERMINISTIC SKIP (`None`), never a guess — the skip is provable (§3.5).
//!
//! Grammar: `^[0-9]{1,20}(\.[0-9]{1,18})?$` — plain decimal, no sign, no exponent, no
//! leading '+', at most 18 fractional digits (the fixed-point scale), integer part bounded
//! so `int * S + frac` cannot overflow U256 in practice (20 digits < 1e21).

use alloy_primitives::U256;

/// The fixed-point scale S = 1e18 (matches `Params::precision_scale` everywhere).
pub fn scale() -> U256 {
    U256::from(1_000_000_000_000_000_000u64)
}

/// Parse a decimal string to fixed-point at scale 1e18. `None` = malformed ⇒ skip.
pub fn parse_fp(s: &str) -> Option<U256> {
    let bytes = s.as_bytes();
    if bytes.is_empty() {
        return None;
    }
    let (int_part, frac_part) = match s.split_once('.') {
        Some((i, f)) => (i, Some(f)),
        None => (s, None),
    };
    if int_part.is_empty() || int_part.len() > 20 || !int_part.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    if let Some(f) = frac_part {
        if f.is_empty() || f.len() > 18 || !f.bytes().all(|b| b.is_ascii_digit()) {
            return None;
        }
    }
    let int_val: U256 = U256::from_str_radix(int_part, 10).ok()?;
    let mut out = int_val.checked_mul(scale())?;
    if let Some(f) = frac_part {
        // frac digits d_1..d_k contribute d * 10^(18-k)
        let frac_val: U256 = U256::from_str_radix(f, 10).ok()?;
        let mult = U256::from(10u64).pow(U256::from((18 - f.len()) as u64));
        out = out.checked_add(frac_val.checked_mul(mult)?)?;
    }
    Some(out)
}

/// Parse and clamp to [0, 1] in fixed point (E2 response weights, E3 scores after
/// normalization use this bound).
pub fn parse_fp_clamped_01(s: &str) -> Option<U256> {
    let v = parse_fp(s)?;
    Some(v.min(scale()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn grammar() {
        assert_eq!(parse_fp("1"), Some(scale()));
        assert_eq!(parse_fp("0.5"), Some(scale() / U256::from(2)));
        assert_eq!(parse_fp("87.5"), Some(U256::from(875u64) * scale() / U256::from(10)));
        assert_eq!(parse_fp("0.000000000000000001"), Some(U256::from(1)));
        // malformed ⇒ deterministic skip
        for bad in [
            "",
            ".",
            "1.",
            ".5",
            "-1",
            "+1",
            "1e5",
            "1.2.3",
            "0x10",
            " 1",
            "1 ",
            "0.0000000000000000001", /* 19 frac digits */
        ] {
            assert_eq!(parse_fp(bad), None, "{bad:?} must be rejected");
        }
    }

    #[test]
    fn clamp() {
        assert_eq!(
            parse_fp_clamped_01("0.85"),
            Some(U256::from(85u64) * scale() / U256::from(100))
        );
        assert_eq!(parse_fp_clamped_01("3.5"), Some(scale()));
    }
}
