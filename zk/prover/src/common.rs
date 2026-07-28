//! Shared prover plumbing used by every program module: the on-chain proof-blob encoding, the
//! ProverClient setup helper, and the execute (guest-vs-native cross-check) and prove/verify flows.
//! Program-specific details (which ELF, which journal fields to print, which output files to write)
//! live in `programs/*`; the byte-level machinery is here so it stays identical across programs.

use anyhow::{anyhow, Result};
use serde::Serialize;
use sp1_sdk::blocking::{ProveRequest, Prover, ProverClient};
use sp1_sdk::{Elf, HashableKey, ProvingKey, SP1Stdin};
use std::path::{Path, PathBuf};

/// Repo root, resolved from this crate's manifest dir (`zk/prover`) so generated-output paths
/// are stable regardless of the CWD the prover is invoked from.
pub fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../..")
}

/// Resolve (and create) the generated-output directory for `program`: the `--out-dir` override
/// when given, else `<repo root>/.trustgraph/<program>/` — the single gitignored home for
/// everything the prover writes.
pub fn out_dir(override_dir: Option<&String>, program: &str) -> Result<PathBuf> {
    let dir = match override_dir {
        Some(d) => PathBuf::from(d),
        None => repo_root().join(".trustgraph").join(program),
    };
    std::fs::create_dir_all(&dir)
        .map_err(|e| anyhow!("create output dir {}: {e}", dir.display()))?;
    // Canonicalize so the "wrote …" lines print clean absolute paths (no `zk/prover/../..`).
    Ok(dir.canonicalize().unwrap_or(dir))
}

/// Write `name` into `dir`, returning the full path (for the "wrote …" log lines).
pub fn write_out(dir: &Path, name: &str, bytes: impl AsRef<[u8]>) -> Result<PathBuf> {
    let path = dir.join(name);
    std::fs::write(&path, bytes).map_err(|e| anyhow!("write {}: {e}", path.display()))?;
    Ok(path)
}

/// abi.encode(bytes publicValues, bytes proofBytes) — the blob SP1JournalVerifier decodes.
pub fn abi_encode_two_bytes(a: &[u8], b: &[u8]) -> Vec<u8> {
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

/// The guest program verification key (bytes32) for the given ELF.
pub fn vkey(elf: Elf) -> Result<String> {
    let client = ProverClient::from_env();
    let pk = client.setup(elf).map_err(|e| anyhow!("setup failed: {e:?}"))?;
    Ok(pk.verifying_key().bytes32())
}

/// Print the guest program verification key (bytes32) for the given ELF (deployment / config value).
pub fn print_vkey(elf: Elf) -> Result<()> {
    println!("{}", vkey(elf)?);
    Ok(())
}

/// What the guest actually committed, plus what it cost. The value-returning half of
/// [`execute_and_check`], for callers that are programs rather than people.
#[derive(Clone, Debug)]
pub struct Execution {
    /// The guest's `publicValues` — byte-identical to the native journal encoding, or this
    /// function returned an error.
    pub public_values: Vec<u8>,
    pub cycles: u64,
}

/// Run the guest and byte-assert it against `native_pub`, returning the result instead of printing
/// it.
///
/// This assertion is the operator's submit precondition (GOAL ground rule 4): it is free, and it
/// is the same check `execute` has always made. A caller that skips it is submitting bytes it has
/// not verified are the bytes it computed.
pub fn execute_values<T: Serialize>(elf: Elf, input: &T, native_pub: &[u8]) -> Result<Execution> {
    let client = ProverClient::from_env();
    let mut stdin = SP1Stdin::new();
    stdin.write(input);

    let (public_values, report) =
        client.execute(elf, stdin).run().map_err(|e| anyhow!("execute failed: {e:?}"))?;
    let guest_pub = public_values.as_slice().to_vec();

    if guest_pub != native_pub {
        return Err(anyhow!(
            "MISMATCH guest vs native public values\n guest:  0x{}\n native: 0x{}",
            hex::encode(&guest_pub),
            hex::encode(native_pub)
        ));
    }
    Ok(Execution { public_values: guest_pub, cycles: report.total_instruction_count() })
}

/// Run the guest via the SP1 executor and assert its public values match the native `native_pub`
/// (the guest-vs-native cross-check; no proof). Prints the cycle count and the `guest == native ✓`
/// line. This is the parity layer — it must byte-assert, never soften to a warning.
pub fn execute_and_check<T: Serialize>(elf: Elf, input: &T, native_pub: &[u8]) -> Result<()> {
    let exec = execute_values(elf, input, native_pub)?;
    println!("guest cycles: {}", exec.cycles);
    println!("guest == native  ✓");
    Ok(())
}

/// Generate a proof (core, or Groth16-wrapped) for the given ELF + input, verify it locally, and
/// return `(publicValues, seal)`. Prints the vkey and the local-verify line. Callers assemble the
/// on-chain blob via [`abi_encode_two_bytes`] and write the program-specific output files.
pub fn prove_and_verify<T: Serialize>(
    elf: Elf,
    input: &T,
    groth16: bool,
) -> Result<(Vec<u8>, Vec<u8>)> {
    let p = prove_values(elf, input, groth16)?;
    println!("vkey: {}", p.vkey);
    println!("local verify ✓");
    Ok((p.public_values, p.seal))
}

/// A finished proof, ready to submit.
#[derive(Clone, Debug)]
pub struct Proof {
    pub public_values: Vec<u8>,
    pub seal: Vec<u8>,
    pub vkey: String,
}

impl Proof {
    /// The on-chain blob `abi.encode(publicValues, seal)` that `SP1JournalVerifier` decodes.
    pub fn blob(&self) -> Vec<u8> {
        abi_encode_two_bytes(&self.public_values, &self.seal)
    }
}

/// Prove and locally verify, returning the result instead of printing it.
///
/// The value-returning half of [`prove_and_verify`]. `zk/operator` calls this; the CLI wraps it.
/// Before this existed, the only way to get a root out of the prover was to scrape stdout with
/// `awk` (`taskfile/instances.sh`), which is a seam that breaks silently the first time a log line
/// changes.
pub fn prove_values<T: Serialize>(elf: Elf, input: &T, groth16: bool) -> Result<Proof> {
    let client = ProverClient::from_env();
    let mut stdin = SP1Stdin::new();
    stdin.write(input);

    let pk = client.setup(elf).map_err(|e| anyhow!("setup failed: {e:?}"))?;
    let vk = pk.verifying_key();

    let req = client.prove(&pk, stdin);
    let proof = if groth16 { req.groth16() } else { req.core() }
        .run()
        .map_err(|e| anyhow!("prove failed: {e:?}"))?;

    client.verify(&proof, vk, None).map_err(|e| anyhow!("local verify failed: {e:?}"))?;

    Ok(Proof {
        public_values: proof.public_values.as_slice().to_vec(),
        seal: proof.bytes(),
        vkey: vk.bytes32(),
    })
}
