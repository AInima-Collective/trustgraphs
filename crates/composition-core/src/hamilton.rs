//! Exact source-aware Hamilton allocation with widened intermediate products.

use alloy_primitives::U256;

use crate::CompositionError;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Apportioned<K> {
    pub key: K,
    pub allocation: u128,
    pub remainder: U256,
}

/// Allocate `pool` across positive values summing exactly to `denominator`.
/// Equal remainders are resolved by ascending canonical key.
pub fn apportion<K: Clone + Ord>(
    pool: u128,
    denominator: u128,
    items: &[(K, u128)],
) -> Result<Vec<Apportioned<K>>, CompositionError> {
    if denominator == 0 || items.is_empty() {
        return Err(CompositionError::InvalidHamiltonInputs);
    }
    let sum = items.iter().try_fold(0u128, |sum, (_, value)| {
        if *value == 0 {
            return Err(CompositionError::InvalidHamiltonInputs);
        }
        sum.checked_add(*value).ok_or(CompositionError::ArithmeticOverflow)
    })?;
    if sum != denominator {
        return Err(CompositionError::InvalidHamiltonInputs);
    }
    let denominator_u256 = U256::from(denominator);
    let mut apportioned = items
        .iter()
        .map(|(key, value)| {
            let numerator = U256::from(pool)
                .checked_mul(U256::from(*value))
                .ok_or(CompositionError::ArithmeticOverflow)?;
            let quotient = numerator / denominator_u256;
            if quotient > U256::from(u128::MAX) {
                return Err(CompositionError::ArithmeticOverflow);
            }
            Ok(Apportioned {
                key: key.clone(),
                allocation: quotient.to::<u128>(),
                remainder: numerator % denominator_u256,
            })
        })
        .collect::<Result<Vec<_>, CompositionError>>()?;
    let allocated = apportioned.iter().try_fold(0u128, |sum, item| {
        sum.checked_add(item.allocation).ok_or(CompositionError::ArithmeticOverflow)
    })?;
    let residual = pool.checked_sub(allocated).ok_or(CompositionError::ArithmeticOverflow)?;
    if residual > apportioned.len() as u128 {
        return Err(CompositionError::InvalidHamiltonInputs);
    }
    let residual = residual as usize;
    let mut order = (0..apportioned.len()).collect::<Vec<_>>();
    order.sort_by(|left, right| {
        apportioned[*right]
            .remainder
            .cmp(&apportioned[*left].remainder)
            .then_with(|| apportioned[*left].key.cmp(&apportioned[*right].key))
    });
    for index in order.into_iter().take(residual) {
        apportioned[index].allocation = apportioned[index]
            .allocation
            .checked_add(1)
            .ok_or(CompositionError::ArithmeticOverflow)?;
    }
    apportioned.sort_by(|left, right| left.key.cmp(&right.key));
    Ok(apportioned)
}
