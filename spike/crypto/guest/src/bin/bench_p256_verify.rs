//! NIST P-256 (secp256r1) ECDSA verify bench: `VerifyingKey::verify_prehash` over low-S
//! signatures via p256. Reads N distinct (sec1_pubkey, prehash, compact-sig) cases; counts
//! successful verifications and commits the count so the work is not optimised away.
#![no_main]
sp1_zkvm::entrypoint!(main);

use p256::ecdsa::signature::hazmat::PrehashVerifier;
use p256::ecdsa::{Signature, VerifyingKey};

pub fn main() {
    // (sec1_pubkey_uncompressed[65], prehash[32], compact_sig[64])
    let cases: Vec<(Vec<u8>, Vec<u8>, Vec<u8>)> = sp1_zkvm::io::read();
    let mut ok: u32 = 0;
    for (pk, prehash, sig_bytes) in &cases {
        let vk = VerifyingKey::from_sec1_bytes(pk).expect("pubkey");
        let sig = Signature::from_slice(sig_bytes).expect("sig");
        if vk.verify_prehash(prehash, &sig).is_ok() {
            ok += 1;
        }
    }
    sp1_zkvm::io::commit_slice(&ok.to_le_bytes());
}
