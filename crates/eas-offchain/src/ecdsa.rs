use alloy_primitives::{keccak256, Address, B256};
use k256::ecdsa::{RecoveryId, Signature, VerifyingKey};

pub(crate) fn recover_address(prehash: &B256, signature: &[u8]) -> Result<Address, ()> {
    if signature.len() != 65 {
        return Err(());
    }
    let parity = match signature[64] {
        27 => 0,
        28 => 1,
        _ => return Err(()),
    };
    let signature = Signature::from_slice(&signature[..64]).map_err(|_| ())?;
    if signature.normalize_s().is_some() {
        return Err(());
    }
    let recovery_id = RecoveryId::from_byte(parity).ok_or(())?;
    let verifying_key =
        VerifyingKey::recover_from_prehash(prehash.as_slice(), &signature, recovery_id)
            .map_err(|_| ())?;
    let uncompressed = verifying_key.to_encoded_point(false);
    let hash = keccak256(&uncompressed.as_bytes()[1..]);
    Ok(Address::from_slice(&hash[12..]))
}
