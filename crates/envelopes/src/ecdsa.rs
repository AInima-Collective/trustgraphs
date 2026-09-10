//! secp256k1 recovery shared by envelope implementations. Inside the SP1 guest, `k256`
//! resolves to the sp1-patches precompile fork (measured 27.3k cycles / 50.2k PGU per
//! recover — research/offchain/05-spike-results.md §3); natively it is upstream RustCrypto.

use alloy_primitives::{keccak256, Address, B256};
use k256::ecdsa::{RecoveryId, Signature, VerifyingKey};

use crate::EnvelopeError;

/// Recover the Ethereum address that signed `prehash` from a 65-byte `(r ‖ s ‖ v)` signature
/// (v ∈ {0,1,27,28}). Enforces low-S (malleability) like ecrecover-consuming contracts do.
pub fn recover_address(prehash: &B256, sig65: &[u8]) -> Result<Address, EnvelopeError> {
    if sig65.len() != 65 {
        return Err(EnvelopeError::Malformed);
    }
    let v = match sig65[64] {
        0 | 27 => 0u8,
        1 | 28 => 1u8,
        _ => return Err(EnvelopeError::Malformed),
    };
    let sig = Signature::from_slice(&sig65[..64]).map_err(|_| EnvelopeError::Malformed)?;
    // Low-S enforcement: normalize_s() returns Some only when s was high.
    if sig.normalize_s().is_some() {
        return Err(EnvelopeError::Malformed);
    }
    let rid = RecoveryId::from_byte(v).ok_or(EnvelopeError::Malformed)?;
    let vk = VerifyingKey::recover_from_prehash(prehash.as_slice(), &sig, rid)
        .map_err(|_| EnvelopeError::BadEdgeSignature)?;
    let uncompressed = vk.to_encoded_point(false);
    let hash = keccak256(&uncompressed.as_bytes()[1..]);
    Ok(Address::from_slice(&hash[12..]))
}
