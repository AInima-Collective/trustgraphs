//! Crypto-benchmark host for the M1 Phase-A spike (research/offchain/03-sp1-feasibility.md).
//!
//! For each guest bin/case it runs the SP1 executor (`execute()`, no proving backend needed) and
//! records BOTH `report.total_instruction_count()` (RISC-V cycles) and `report.gas()` (Prover Gas
//! Units — the metric SP1 actually bills, per the "PGUs, not cycles" caveat in dossier 03 §1).
//!
//! ALWAYS run with SP1_PROVER=mock (the cpu backend OOMs an 11 GiB box; execute-only never needs a
//! backend). Prints machine-readable `RESULT,<label>,<cycles>,<pgu>` lines plus a human table.

use rand::rngs::StdRng;
use rand::SeedableRng;
use sha2::{Digest, Sha256};
use sp1_sdk::blocking::{EnvProver, Prover, ProverClient};
use sp1_sdk::{include_elf, Elf, SP1Stdin};

// ---- Guest ELFs (patched) ----
const ELF_NOOP: Elf = include_elf!("noop");
const ELF_MEMFILL: Elf = include_elf!("bench-memfill");
const ELF_ECRECOVER: Elf = include_elf!("bench-ecrecover");
const ELF_P256: Elf = include_elf!("bench-p256-verify");
const ELF_KECCAK: Elf = include_elf!("bench-keccak");
const ELF_SHA256: Elf = include_elf!("bench-sha256");
// ---- Guest ELFs (unpatched comparison) ----
const ELF_ECRECOVER_NP: Elf = include_elf!("bench-ecrecover-nopatch");
const ELF_SHA256_NP: Elf = include_elf!("bench-sha256-nopatch");

fn run<T: serde::Serialize>(client: &EnvProver, elf: Elf, label: &str, input: &T) -> (u64, u64) {
    let mut stdin = SP1Stdin::new();
    stdin.write(input);
    let (_pv, report) = client.execute(elf, stdin).run().expect("execute failed");
    let cycles = report.total_instruction_count();
    let pgu = report.gas().unwrap_or(0);
    println!("RESULT,{label},{cycles},{pgu}");
    println!("  {label:<26} cycles={cycles:>12}  pgu={pgu:>12}");
    (cycles, pgu)
}

/// secp256k1: N distinct (prehash[32], compact_sig[64], recovery_id) cases.
fn gen_ecrecover(n: usize) -> Vec<(Vec<u8>, Vec<u8>, u8)> {
    use k256::ecdsa::SigningKey;
    let mut rng = StdRng::seed_from_u64(0xA11CE ^ n as u64);
    (0..n)
        .map(|i| {
            let sk = SigningKey::random(&mut rng);
            let prehash = Sha256::digest(format!("trustgraph-k256-msg-{i}").as_bytes());
            let (sig, recid) = sk
                .sign_prehash_recoverable(&prehash)
                .expect("sign recoverable");
            (prehash.to_vec(), sig.to_bytes().to_vec(), recid.to_byte())
        })
        .collect()
}

/// P-256: N distinct (sec1_pubkey_uncompressed[65], prehash[32], compact_sig[64]) low-S cases.
fn gen_p256(n: usize) -> Vec<(Vec<u8>, Vec<u8>, Vec<u8>)> {
    use p256::ecdsa::signature::hazmat::PrehashSigner;
    use p256::ecdsa::{Signature, SigningKey};
    let mut rng = StdRng::seed_from_u64(0xB0B ^ n as u64);
    (0..n)
        .map(|i| {
            let sk = SigningKey::random(&mut rng);
            let prehash = Sha256::digest(format!("trustgraph-p256-msg-{i}").as_bytes());
            // RustCrypto ECDSA normalises to low-S by default.
            let sig: Signature = sk.sign_prehash(&prehash).expect("sign prehash");
            let pk = sk
                .verifying_key()
                .to_encoded_point(false)
                .as_bytes()
                .to_vec();
            (pk, prehash.to_vec(), sig.to_bytes().to_vec())
        })
        .collect()
}

fn main() {
    // Force mock: execute-only, no prover backend (cpu OOMs an 11 GiB box).
    if std::env::var("SP1_PROVER").is_err() {
        std::env::set_var("SP1_PROVER", "mock");
    }
    sp1_sdk::utils::setup_logger();
    let client = ProverClient::from_env();

    println!("== baselines ==");
    run(&client, ELF_NOOP, "noop", &0u32);

    println!("== ecrecover (secp256k1, patched) ==");
    let ec1 = gen_ecrecover(1);
    let ec100 = gen_ecrecover(100);
    run(&client, ELF_ECRECOVER, "ecrecover-patched-N1", &ec1);
    run(&client, ELF_ECRECOVER, "ecrecover-patched-N100", &ec100);
    println!("== ecrecover (secp256k1, UNPATCHED) ==");
    run(&client, ELF_ECRECOVER_NP, "ecrecover-nopatch-N1", &ec1);
    run(&client, ELF_ECRECOVER_NP, "ecrecover-nopatch-N100", &ec100);

    println!("== p256 verify (secp256r1, patched) ==");
    let p1 = gen_p256(1);
    let p100 = gen_p256(100);
    run(&client, ELF_P256, "p256verify-patched-N1", &p1);
    run(&client, ELF_P256, "p256verify-patched-N100", &p100);

    // Hash sizes: 1 KiB, 64 KiB, 1 MiB. memfill isolates buffer-generation from hashing.
    let sizes: [(u32, &str); 3] = [(1024, "1KiB"), (65536, "64KiB"), (1048576, "1MiB")];

    println!("== memfill baseline (buffer generation, no hash) ==");
    for (len, name) in sizes {
        run(&client, ELF_MEMFILL, &format!("memfill-{name}"), &len);
    }

    println!("== keccak256 (tiny-keccak, patched) ==");
    for (len, name) in sizes {
        run(&client, ELF_KECCAK, &format!("keccak-patched-{name}"), &len);
    }

    println!("== sha256 (sha2, patched) ==");
    for (len, name) in sizes {
        run(&client, ELF_SHA256, &format!("sha256-patched-{name}"), &len);
    }

    println!("== sha256 (sha2, UNPATCHED) ==");
    for (len, name) in sizes {
        run(&client, ELF_SHA256_NP, &format!("sha256-nopatch-{name}"), &len);
    }

    println!("\nDone. Grep 'RESULT,' lines for the machine-readable table.");
}
