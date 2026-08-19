//! Envelope-2 conformance guest. Verification failures panic; successful execution commits six
//! ABI words: node id, head, count, data commitment, accepted-events digest, skipped digest.
#![no_main]
sp1_zkvm::entrypoint!(main);

use nostr_envelope::nostr::{self, NostrAnchor, NostrVerifyConfig};
use zk_core::words::word_u64;

pub fn main() {
    let anchor: NostrAnchor = sp1_zkvm::io::read();
    let config: NostrVerifyConfig = sp1_zkvm::io::read();
    let bytes: Vec<u8> = sp1_zkvm::io::read();
    let verified = nostr::verify(&anchor, &config, &bytes)
        .expect("envelope-2 Nostr conformance verification failed");

    let mut public_values = Vec::with_capacity(32 * 6);
    public_values.extend_from_slice(verified.node_id.as_slice());
    public_values.extend_from_slice(verified.head.as_slice());
    public_values.extend_from_slice(&word_u64(verified.count));
    public_values.extend_from_slice(verified.data_commitment.as_slice());
    public_values.extend_from_slice(verified.accepted_events_digest.as_slice());
    public_values.extend_from_slice(verified.skipped_digest.as_slice());
    sp1_zkvm::io::commit_slice(&public_values);
}
