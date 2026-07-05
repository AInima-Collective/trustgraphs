//! TrustGraph prover host.
//!
//! Subcommands:
//!   vkey                       print the guest program verification key (bytes32) for deployment
//!   paramshash [input.json]    print keccak256 of the canonical params (for the operational timelock)
//!   execute    [input.json]    run the guest via the SP1 executor and assert it matches native
//!                              `pagerank-core::compute` (guest-vs-native cross-check; no proof)
//!   prove      [input.json] [--groth16]
//!                              generate a proof (core, or Groth16-wrapped), verify it locally, and
//!                              write the on-chain proof blob `abi.encode(publicValues, seal)` to proof.bin
//!
//! `input.json` is a serialized `pagerank_core::GuestInput`; omit it to use the built-in sample
//! (identical to test/golden/vectors.json).

use alloy_primitives::{Address, B256, U256};
use anyhow::{anyhow, Result};
use pagerank_core::{
    compute::compute, encode, signer::compute_signers, GuestInput, Params, RawEdge, SelectionParams,
    SignerInput,
};
use sp1_sdk::blocking::{ProveRequest, Prover, ProverClient};
use sp1_sdk::{include_elf, Elf, HashableKey, ProvingKey, SP1Stdin};

/// The root-producer guest ELF, built by build.rs (`sp1_build::build_program`).
fn load_elf() -> Elf {
    include_elf!("trustgraph-program")
}

/// The signer-sync guest ELF (second bin of the program crate).
fn load_signer_elf() -> Elf {
    include_elf!("trustgraph-signer-program")
}

fn scale() -> U256 {
    U256::from(10u64).pow(U256::from(18u64))
}
fn fp(n: u64, d: u64) -> U256 {
    scale() * U256::from(n) / U256::from(d)
}
fn addr(b: u8) -> Address {
    Address::from([b; 20])
}
fn edge(kind: u8, from: u8, to: u8, uid: u8, ts: u64, w: u64) -> RawEdge {
    let mut data = vec![0u8; 64];
    data[32..64].copy_from_slice(&U256::from(w).to_be_bytes::<32>());
    RawEdge {
        kind,
        attester: addr(from),
        recipient: addr(to),
        uid: B256::from([uid; 32]),
        block_timestamp: ts,
        data,
    }
}

/// The built-in sample scenario (matches test/golden/vectors.json).
fn sample_input() -> GuestInput {
    let s = scale();
    let params = Params {
        damping_fp: fp(85, 100),
        tolerance_fp: s / U256::from(1_000_000u64),
        max_iterations: 100,
        min_weight_fp: U256::ZERO,
        max_weight_fp: U256::from(100u64) * s,
        trust_multiplier_fp: U256::from(2u64) * s,
        trust_share_fp: fp(15, 100),
        trust_decay_fp: fp(80, 100),
        trusted_seeds: vec![addr(1), addr(3)],
        total_pool: U256::from(1_000_000_000_000_000_000_000_000u128),
        precision_scale: s,
        schema_uid: B256::from([0xAB; 32]),
        weight_field_index: 1,
    };
    let edges =
        vec![edge(0, 1, 2, 1, 100, 50), edge(0, 2, 3, 2, 101, 75), edge(0, 3, 1, 3, 102, 90)];
    GuestInput { edges, params }
}

fn load_input(path: Option<&String>) -> Result<GuestInput> {
    match path {
        Some(p) => Ok(serde_json::from_str(&std::fs::read_to_string(p)?)?),
        None => Ok(sample_input()),
    }
}

/// abi.encode(bytes publicValues, bytes proofBytes) — the blob SP1TrustGraphVerifier decodes.
fn abi_encode_two_bytes(a: &[u8], b: &[u8]) -> Vec<u8> {
    fn word(n: usize) -> [u8; 32] {
        let mut w = [0u8; 32];
        w[24..].copy_from_slice(&(n as u64).to_be_bytes());
        w
    }
    fn enc(x: &[u8]) -> Vec<u8> {
        let mut v = word(x.len()).to_vec();
        v.extend_from_slice(x);
        let pad = (32 - x.len() % 32) % 32;
        v.extend(std::iter::repeat(0u8).take(pad));
        v
    }
    let a_enc = enc(a);
    let b_enc = enc(b);
    let mut out = Vec::new();
    out.extend_from_slice(&word(0x40)); // offset to a
    out.extend_from_slice(&word(0x40 + a_enc.len())); // offset to b
    out.extend_from_slice(&a_enc);
    out.extend_from_slice(&b_enc);
    out
}

fn cmd_execute(input: GuestInput) -> Result<()> {
    let native = compute(&input);
    let native_pub = encode::journal_encoded(&native.journal);

    let client = ProverClient::from_env();
    let mut stdin = SP1Stdin::new();
    stdin.write(&input);

    let (public_values, report) =
        client.execute(load_elf(), stdin).run().map_err(|e| anyhow!("execute failed: {e:?}"))?;
    let guest_pub = public_values.as_slice().to_vec();

    println!("guest cycles: {}", report.total_instruction_count());
    if guest_pub != native_pub {
        return Err(anyhow!(
            "MISMATCH guest vs native public values\n guest:  0x{}\n native: 0x{}",
            hex::encode(&guest_pub),
            hex::encode(&native_pub)
        ));
    }
    println!("guest == native  ✓");
    println!("journalDigest: 0x{}", hex::encode(encode::journal_digest(&native.journal)));
    println!("outputRoot:    0x{}", hex::encode(native.journal.output_root));
    println!("paramsHash:    0x{}", hex::encode(native.journal.params_hash));
    println!("ipfsHash:      0x{}", hex::encode(native.journal.ipfs_hash));
    println!("cid:           {}", native.cid);
    println!("totalValue:    {}", native.journal.total_value);
    Ok(())
}

fn cmd_prove(input: GuestInput, groth16: bool) -> Result<()> {
    let client = ProverClient::from_env();
    let mut stdin = SP1Stdin::new();
    stdin.write(&input);

    let pk = client.setup(load_elf()).map_err(|e| anyhow!("setup failed: {e:?}"))?;
    let vk = pk.verifying_key();
    println!("vkey: {}", vk.bytes32());

    let req = client.prove(&pk, stdin);
    let proof = if groth16 { req.groth16() } else { req.core() }
        .run()
        .map_err(|e| anyhow!("prove failed: {e:?}"))?;

    client.verify(&proof, vk, None).map_err(|e| anyhow!("local verify failed: {e:?}"))?;
    println!("local verify ✓");

    let public_values = proof.public_values.as_slice().to_vec();
    let seal = proof.bytes();
    let blob = abi_encode_two_bytes(&public_values, &seal);
    std::fs::write("proof.bin", &blob)?;
    std::fs::write("public_values.bin", &public_values)?;
    println!("wrote proof.bin ({} blob bytes, {} seal bytes)", blob.len(), seal.len());
    println!("publicValues: 0x{}", hex::encode(&public_values));
    Ok(())
}

/// The built-in signer sample (same edges/params as the root sample + a 3/50%/min-1 selection).
fn sample_signer_input() -> SignerInput {
    let g = sample_input();
    SignerInput {
        edges: g.edges,
        params: g.params,
        selection: SelectionParams { top_n: 3, min_threshold: 1, target_threshold_bps: 5000 },
    }
}

fn load_signer_input(path: Option<&String>) -> Result<SignerInput> {
    match path {
        Some(p) => Ok(serde_json::from_str(&std::fs::read_to_string(p)?)?),
        None => Ok(sample_signer_input()),
    }
}

fn cmd_signer_execute(input: SignerInput) -> Result<()> {
    let native = compute_signers(&input);
    let native_pub = encode::signer_journal_encoded(&native.journal);

    let client = ProverClient::from_env();
    let mut stdin = SP1Stdin::new();
    stdin.write(&input);

    let (public_values, report) = client
        .execute(load_signer_elf(), stdin)
        .run()
        .map_err(|e| anyhow!("execute failed: {e:?}"))?;
    let guest_pub = public_values.as_slice().to_vec();

    println!("guest cycles: {}", report.total_instruction_count());
    if guest_pub != native_pub {
        return Err(anyhow!(
            "MISMATCH guest vs native public values\n guest:  0x{}\n native: 0x{}",
            hex::encode(&guest_pub),
            hex::encode(&native_pub)
        ));
    }
    println!("guest == native  ✓");
    println!(
        "signerJournalDigest: 0x{}",
        hex::encode(encode::signer_journal_digest(&native.journal))
    );
    println!("signerSetRoot:       0x{}", hex::encode(native.journal.signer_set_root));
    println!("paramsHash:          0x{}", hex::encode(native.journal.params_hash));
    println!("selectionParamsHash: 0x{}", hex::encode(native.journal.selection_params_hash));
    println!("targetThreshold:     {}", native.journal.target_threshold);
    println!("signers ({}):", native.signers.len());
    for s in &native.signers {
        println!("  0x{}", hex::encode(s));
    }
    Ok(())
}

fn cmd_signer_prove(input: SignerInput, groth16: bool) -> Result<()> {
    let client = ProverClient::from_env();
    let mut stdin = SP1Stdin::new();
    stdin.write(&input);

    let pk = client.setup(load_signer_elf()).map_err(|e| anyhow!("setup failed: {e:?}"))?;
    let vk = pk.verifying_key();
    println!("vkey: {}", vk.bytes32());

    let req = client.prove(&pk, stdin);
    let proof = if groth16 { req.groth16() } else { req.core() }
        .run()
        .map_err(|e| anyhow!("prove failed: {e:?}"))?;

    client.verify(&proof, vk, None).map_err(|e| anyhow!("local verify failed: {e:?}"))?;
    println!("local verify ✓");

    let public_values = proof.public_values.as_slice().to_vec();
    let seal = proof.bytes();
    let blob = abi_encode_two_bytes(&public_values, &seal);
    std::fs::write("signer_proof.bin", &blob)?;
    std::fs::write("signer_public_values.bin", &public_values)?;
    println!("wrote signer_proof.bin ({} blob bytes, {} seal bytes)", blob.len(), seal.len());
    println!("publicValues: 0x{}", hex::encode(&public_values));
    Ok(())
}

fn main() -> Result<()> {
    sp1_sdk::utils::setup_logger();
    let args: Vec<String> = std::env::args().collect();
    let cmd = args.get(1).map(|s| s.as_str()).unwrap_or("help");
    match cmd {
        "vkey" => {
            let client = ProverClient::from_env();
            let pk = client.setup(load_elf()).map_err(|e| anyhow!("setup failed: {e:?}"))?;
            println!("{}", pk.verifying_key().bytes32());
        }
        "paramshash" => {
            let input = load_input(args.get(2))?;
            println!("0x{}", hex::encode(encode::params_hash(&input.params)));
        }
        "execute" => cmd_execute(load_input(args.get(2))?)?,
        "prove" => {
            let groth16 = args.iter().any(|a| a == "--groth16");
            // allow `prove --groth16` (no path) or `prove input.json --groth16`
            let path = args.get(2).filter(|s| !s.starts_with("--"));
            cmd_prove(load_input(path)?, groth16)?;
        }
        "signer-vkey" => {
            let client = ProverClient::from_env();
            let pk = client.setup(load_signer_elf()).map_err(|e| anyhow!("setup failed: {e:?}"))?;
            println!("{}", pk.verifying_key().bytes32());
        }
        "signer-selectionparamshash" => {
            let input = load_signer_input(args.get(2))?;
            println!("0x{}", hex::encode(encode::selection_params_hash(&input.selection)));
        }
        "signer-execute" => cmd_signer_execute(load_signer_input(args.get(2))?)?,
        "signer-prove" => {
            let groth16 = args.iter().any(|a| a == "--groth16");
            let path = args.get(2).filter(|s| !s.starts_with("--"));
            cmd_signer_prove(load_signer_input(path)?, groth16)?;
        }
        _ => {
            eprintln!(
                "usage: trustgraph-prover [vkey|execute|prove|paramshash|signer-vkey|\n         signer-selectionparamshash|signer-execute|signer-prove] [input.json] [--groth16]"
            );
        }
    }
    Ok(())
}
