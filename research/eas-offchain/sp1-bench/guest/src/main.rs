#![no_main]
sp1_zkvm::entrypoint!(main);

use alloy_primitives::{Address, B256};
use eas_offchain_v2::payload_v1::{
    eip712_domain_separator, verify, AnchorMessage, VerificationContext,
};

type BenchInput =
    (Vec<u8>, B256, B256, u64, Address, B256, u8, B256, B256, B256, u64, B256, u64, Vec<u8>);

pub fn main() {
    let (
        payload,
        expected_schema,
        eas_domain_separator,
        chain_id,
        registry,
        node_id,
        envelope_kind,
        schema_uid,
        previous_head,
        head,
        count,
        data_commitment,
        anchor_timestamp,
        head_signature,
    ): BenchInput = sp1_zkvm::io::read();
    let anchor = AnchorMessage {
        node_id,
        envelope_kind,
        schema_uid,
        previous_head,
        head,
        count,
        data_commitment,
    };
    let context = VerificationContext {
        expected_schema,
        eas_domain_separator,
        head_domain_separator: eip712_domain_separator(
            "Trustgraphs Offchain Head",
            "2",
            chain_id,
            registry,
        ),
        anchor,
        anchor_timestamp,
        head_signature: &head_signature,
    };
    let decoded = verify(&payload, &context).expect("valid generated envelope");
    sp1_zkvm::io::commit(&(decoded.entries.len() as u64, head, data_commitment));
}
