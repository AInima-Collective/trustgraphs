//! secp256k1 ecrecover bench (the Ethereum ecrecover path): recover the verifying key from a
//! prehash + recoverable signature via k256, exactly like `ecrecover`. Reads N distinct
//! (prehash, compact-sig, recovery-id) cases generated on the host; XOR-folds every recovered SEC1
//! pubkey into an accumulator and commits it, so the work cannot be optimised away.
#![no_main]
sp1_zkvm::entrypoint!(main);

use k256::ecdsa::{RecoveryId, Signature, VerifyingKey};

pub fn main() {
    // (prehash[32], compact_sig[64], recovery_id)
    let cases: Vec<(Vec<u8>, Vec<u8>, u8)> = sp1_zkvm::io::read();
    let mut acc = [0u8; 32];
    for (prehash, sig_bytes, recid) in &cases {
        let sig = Signature::from_slice(sig_bytes).expect("sig");
        let rid = RecoveryId::from_byte(*recid).expect("recid");
        let vk = VerifyingKey::recover_from_prehash(prehash, &sig, rid).expect("recover");
        for (i, b) in vk.to_sec1_bytes().iter().enumerate() {
            acc[i % 32] ^= b;
        }
    }
    sp1_zkvm::io::commit_slice(&acc);
}
