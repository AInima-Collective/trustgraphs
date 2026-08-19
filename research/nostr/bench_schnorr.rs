//! BIP340 schnorr verify bench (the Nostr signature path): verify (msg32, sig64, xonly-pk32)
//! triples via k256::schnorr, exactly what a Nostr event verification does after computing the
//! event id. Reads N distinct cases generated on the host; XOR-folds a success byte + the pubkey
//! bytes into an accumulator and commits it, so the work cannot be optimised away.
#![no_main]
sp1_zkvm::entrypoint!(main);

use k256::schnorr::signature::hazmat::PrehashVerifier;
use k256::schnorr::{Signature, VerifyingKey};

pub fn main() {
    // (msg[32], sig[64], xonly_pubkey[32])
    let cases: Vec<(Vec<u8>, Vec<u8>, Vec<u8>)> = sp1_zkvm::io::read();
    let mut acc = [0u8; 32];
    for (msg, sig_bytes, pk_bytes) in &cases {
        let vk = VerifyingKey::from_bytes(pk_bytes).expect("xonly pubkey");
        let sig = Signature::try_from(sig_bytes.as_slice()).expect("sig");
        vk.verify_prehash(msg, &sig).expect("schnorr prehash verify");
        for (i, b) in pk_bytes.iter().enumerate() {
            acc[i % 32] ^= b;
        }
        acc[0] ^= 1;
    }
    sp1_zkvm::io::commit_slice(&acc);
}
