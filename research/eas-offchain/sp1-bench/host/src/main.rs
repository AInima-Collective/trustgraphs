use alloy_primitives::{keccak256, Address, B256, U256};
use anyhow::{ensure, Context, Result};
use eas_offchain::payload::{
    anchor_digest, data_commitment, eip712_domain_separator, encode, AnchorMessage, PayloadV1,
    E0_ENTRY_WORK_UNITS, MAX_ENTRIES_PER_NODE, MAX_PAYLOAD_BYTES,
};
use eas_offchain::{
    address_node_id, attest_struct_hash, eip712_digest, log_head, offchain_uid_v2, LogEntry,
    OffchainAttestation, ENTRY_ATTEST, ENTRY_REVOKE,
};
use k256::ecdsa::SigningKey;
use serde::Serialize;
use sp1_sdk::blocking::{EnvProver, Prover, ProverClient};
use sp1_sdk::{include_elf, Elf, SP1Stdin};
use std::path::Path;

const ELF: Elf = include_elf!("eas-offchain-envelope-bench");
const SCHEMA: B256 = B256::repeat_byte(0xab);
const EAS: Address = Address::repeat_byte(0xc2);
const REGISTRY: Address = Address::repeat_byte(0x11);
const CHAIN_ID: u64 = 11_155_111;
const SIGNED_TIME: u64 = 1_770_000_000;
const ANCHOR_TIME: u64 = 1_770_000_060;

type BenchInput =
    (Vec<u8>, B256, B256, u64, Address, B256, u8, B256, B256, B256, u64, B256, u64, Vec<u8>);

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Measurement {
    label: String,
    entries: usize,
    attestations: usize,
    revocations: usize,
    payload_bytes: usize,
    work_units: u64,
    cycles: u64,
    pgu: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Marginal {
    label: String,
    from_entries: usize,
    to_entries: usize,
    cycles_per_entry: u64,
    pgu_per_entry: u64,
    budgeted_cycles_per_entry: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Results {
    format: &'static str,
    sp1: &'static str,
    cargo_prove: &'static str,
    max_payload_bytes: usize,
    max_entries_per_node: usize,
    entry_work_units: u64,
    cycles_per_work_unit: u64,
    measurements: Vec<Measurement>,
    marginals: Vec<Marginal>,
}

fn addr_of(key: &SigningKey) -> Address {
    let point = key.verifying_key().to_encoded_point(false);
    let hash = keccak256(&point.as_bytes()[1..]);
    Address::from_slice(&hash[12..])
}

fn sign(key: &SigningKey, digest: B256) -> Vec<u8> {
    let (signature, _) = key.sign_prehash_recoverable(digest.as_slice()).unwrap();
    let signature = signature.normalize_s().unwrap_or(signature);
    for recovery in 0..=1 {
        let recovery_id = k256::ecdsa::RecoveryId::from_byte(recovery).unwrap();
        let recovered = k256::ecdsa::VerifyingKey::recover_from_prehash(
            digest.as_slice(),
            &signature,
            recovery_id,
        );
        if recovered.as_ref().is_ok_and(|candidate| candidate == key.verifying_key()) {
            let mut out = signature.to_bytes().to_vec();
            out.push(27 + recovery);
            return out;
        }
    }
    unreachable!("a recoverable signature must have a recovery id")
}

fn data(confidence: usize) -> Vec<u8> {
    let mut data = vec![0u8; 96];
    data[31] = 64;
    data[32..64].copy_from_slice(&U256::from(confidence + 1).to_be_bytes::<32>());
    data
}

fn recipient(index: usize) -> Address {
    let mut value = [0u8; 20];
    value[12..].copy_from_slice(&(index as u64 + 1).to_be_bytes());
    Address::from(value)
}

fn salt(index: usize) -> B256 {
    B256::from(U256::from(index + 1).to_be_bytes::<32>())
}

fn attestation(key: &SigningKey, eas_domain: B256, index: usize) -> (OffchainAttestation, B256) {
    let mut value = OffchainAttestation {
        version: 2,
        schema: SCHEMA,
        recipient: recipient(index),
        time: SIGNED_TIME,
        expiration_time: 0,
        revocable: true,
        ref_uid: B256::ZERO,
        data: data(index),
        salt: salt(index),
        signature: Vec::new(),
    };
    value.signature = sign(key, eip712_digest(eas_domain, attest_struct_hash(&value)));
    let uid = offchain_uid_v2(&value);
    (value, uid)
}

fn generated(count: usize, revoke_dense: bool) -> BenchInput {
    assert!(count > 0 && count <= MAX_ENTRIES_PER_NODE);
    assert!(!revoke_dense || count % 2 == 0);
    let key = SigningKey::from_slice(&[0x42; 32]).unwrap();
    let owner = addr_of(&key);
    let eas_domain = eip712_domain_separator("EAS Attestation", "1.3.0", CHAIN_ID, EAS);
    let attestation_count = if revoke_dense { count / 2 } else { count };
    let mut attestations = Vec::with_capacity(attestation_count);
    let mut entries = Vec::with_capacity(count);
    for index in 0..attestation_count {
        let (attestation, uid) = attestation(&key, eas_domain, index);
        entries.push(LogEntry { kind: ENTRY_ATTEST, uid });
        attestations.push(attestation);
    }
    if revoke_dense {
        for attestation in &attestations {
            entries.push(LogEntry { kind: ENTRY_REVOKE, uid: offchain_uid_v2(attestation) });
        }
    }
    let payload = encode(&PayloadV1 { owner, entries, attestations }).unwrap();
    assert!(payload.len() <= MAX_PAYLOAD_BYTES);
    let head = log_head(&decode_entries(&payload));
    let commitment = data_commitment(&payload);
    let anchor = AnchorMessage {
        node_id: address_node_id(owner),
        envelope_kind: 0,
        schema_uid: SCHEMA,
        previous_head: B256::ZERO,
        head,
        count: count as u64,
        data_commitment: commitment,
    };
    let head_signature = sign(&key, anchor_digest(CHAIN_ID, REGISTRY, &anchor));
    (
        payload,
        SCHEMA,
        eas_domain,
        CHAIN_ID,
        REGISTRY,
        anchor.node_id,
        anchor.envelope_kind,
        anchor.schema_uid,
        anchor.previous_head,
        anchor.head,
        anchor.count,
        anchor.data_commitment,
        ANCHOR_TIME,
        head_signature,
    )
}

// Decode through the production codec so benchmark generation cannot accidentally use a different
// head than the guest will parse.
fn decode_entries(payload: &[u8]) -> Vec<LogEntry> {
    eas_offchain::payload::decode(payload, SCHEMA).unwrap().entries
}

fn run(
    client: &EnvProver,
    label: &str,
    input: BenchInput,
    revoke_dense: bool,
) -> Result<Measurement> {
    let entries = input.10 as usize;
    let payload_bytes = input.0.len();
    let attestations = if revoke_dense { entries / 2 } else { entries };
    let revocations = entries - attestations;
    let mut stdin = SP1Stdin::new();
    stdin.write(&input);
    let (_public, report) = client.execute(ELF, stdin).run().with_context(|| label.to_owned())?;
    let measurement = Measurement {
        label: label.to_owned(),
        entries,
        attestations,
        revocations,
        payload_bytes,
        work_units: 1 + entries as u64 * E0_ENTRY_WORK_UNITS,
        cycles: report.total_instruction_count(),
        pgu: report.gas().unwrap_or(0),
    };
    println!(
        "RESULT,{},{},{},{},{},{},{}",
        measurement.label,
        measurement.entries,
        measurement.attestations,
        measurement.revocations,
        measurement.payload_bytes,
        measurement.cycles,
        measurement.pgu
    );
    Ok(measurement)
}

fn marginal(label: &str, from: &Measurement, to: &Measurement) -> Marginal {
    let delta = (to.entries - from.entries) as u64;
    Marginal {
        label: label.to_owned(),
        from_entries: from.entries,
        to_entries: to.entries,
        cycles_per_entry: (to.cycles - from.cycles) / delta,
        pgu_per_entry: (to.pgu - from.pgu) / delta,
        budgeted_cycles_per_entry: E0_ENTRY_WORK_UNITS * 40_000,
    }
}

fn write_results(path: &Path, results: &Results) -> Result<()> {
    let mut bytes = serde_json::to_vec_pretty(results)?;
    bytes.push(b'\n');
    std::fs::write(path, bytes).with_context(|| format!("writing {}", path.display()))
}

fn main() -> Result<()> {
    if std::env::var("SP1_PROVER").is_err() {
        std::env::set_var("SP1_PROVER", "mock");
    }
    let output = std::env::args_os().nth(1);
    ensure!(std::env::args_os().nth(2).is_none(), "usage: host [results.json]");
    let client = ProverClient::from_env();
    let measurements = vec![
        run(&client, "all-attest-N1", generated(1, false), false)?,
        run(&client, "all-attest-N100", generated(100, false), false)?,
        run(&client, "all-attest-N1000", generated(1_000, false), false)?,
        run(&client, "all-attest-N2048", generated(2_048, false), false)?,
        run(&client, "revoke-dense-N2", generated(2, true), true)?,
        run(&client, "revoke-dense-N100", generated(100, true), true)?,
        run(&client, "revoke-dense-N1000", generated(1_000, true), true)?,
        run(&client, "revoke-dense-N2048", generated(2_048, true), true)?,
    ];
    let marginals = vec![
        marginal("all-attest", &measurements[1], &measurements[2]),
        marginal("revoke-dense", &measurements[5], &measurements[6]),
    ];
    for row in &marginals {
        println!(
            "MARGINAL,{},{},{},{}",
            row.label, row.to_entries, row.cycles_per_entry, row.pgu_per_entry
        );
    }
    let results = Results {
        format: "trustgraphs-eas-offchain-sp1-bench-v1",
        sp1: "6.3.1",
        cargo_prove: "8252c29",
        max_payload_bytes: MAX_PAYLOAD_BYTES,
        max_entries_per_node: MAX_ENTRIES_PER_NODE,
        entry_work_units: E0_ENTRY_WORK_UNITS,
        cycles_per_work_unit: 40_000,
        measurements,
        marginals,
    };
    if let Some(output) = output {
        write_results(Path::new(&output), &results)?;
    }
    Ok(())
}
