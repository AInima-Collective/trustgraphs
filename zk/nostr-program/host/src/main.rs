use std::path::{Path, PathBuf};

use alloy_primitives::B256;
use anyhow::{bail, Context, Result};
use nostr_envelope::nostr::tgnw;
use nostr_envelope::nostr::{
    community_node_id, verify, CommitmentVariant, NostrAnchor, NostrLimits, NostrVerifyConfig,
    BUZZ_AUDIT_BITMAP,
};
use sha2::{Digest, Sha256};
use sp1_sdk::blocking::{Prover, ProverClient};
use sp1_sdk::{include_elf, Elf, SP1Stdin};
use zk_core::words::word_u64;

const ELF: Elf = include_elf!("nostr-conformance");

fn default_fixture() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join(
        "../../../tests/fixtures/nostr/buzz/a362fecc2389955f942c9581bdfeba379ab115b3/live/live-option-a.tgnw",
    )
}

fn main() -> Result<()> {
    if std::env::var("SP1_PROVER").is_err() {
        std::env::set_var("SP1_PROVER", "mock");
    }
    let path = std::env::args_os().nth(1).map(PathBuf::from).unwrap_or_else(default_fixture);
    let bytes = std::fs::read(&path).with_context(|| format!("reading {}", path.display()))?;
    let bundle = tgnw::decode(&bytes, &NostrLimits::HARD)
        .map_err(|error| anyhow::anyhow!("TGNW decode failed: {error:?}"))?;
    if bundle.variant != CommitmentVariant::BuzzAuditV1 {
        bail!("host currently expects the live Option-A fixture");
    }
    let anchor = NostrAnchor {
        node_id: community_node_id(&bundle.community_id),
        head: B256::from(bundle.audit.last().context("empty audit prefix")?.hash),
        count: bundle.audit.len() as u64,
        data_commitment: B256::from(<[u8; 32]>::from(Sha256::digest(&bytes))),
    };
    let config = NostrVerifyConfig {
        community_id: bundle.community_id,
        instance_domain: bundle.instance_domain,
        relay_pubkey: bundle.authority,
        allowed_variants: BUZZ_AUDIT_BITMAP,
        limits: NostrLimits::HARD,
    };
    let native = verify(&anchor, &config, &bytes)
        .map_err(|error| anyhow::anyhow!("native verification failed: {error:?}"))?;
    let mut expected = Vec::with_capacity(32 * 6);
    expected.extend_from_slice(native.node_id.as_slice());
    expected.extend_from_slice(native.head.as_slice());
    expected.extend_from_slice(&word_u64(native.count));
    expected.extend_from_slice(native.data_commitment.as_slice());
    expected.extend_from_slice(native.accepted_events_digest.as_slice());
    expected.extend_from_slice(native.skipped_digest.as_slice());

    let mut stdin = SP1Stdin::new();
    stdin.write(&anchor);
    stdin.write(&config);
    stdin.write(&bytes);
    let client = ProverClient::from_env();
    let (public_values, report) = client.execute(ELF, stdin).run().context("guest execution")?;
    if public_values.as_slice() != expected.as_slice() {
        bail!("guest/native public values differ");
    }

    let mut invalid_bytes = bytes.clone();
    let last = invalid_bytes.len().checked_sub(1).context("empty TGNW")?;
    invalid_bytes[last] ^= 1;
    let mut invalid_anchor = anchor;
    invalid_anchor.data_commitment = B256::from(<[u8; 32]>::from(Sha256::digest(&invalid_bytes)));
    if verify(&invalid_anchor, &config, &invalid_bytes).is_ok() {
        bail!("native verifier accepted the invalid signed event");
    }
    let mut invalid_stdin = SP1Stdin::new();
    invalid_stdin.write(&invalid_anchor);
    invalid_stdin.write(&config);
    invalid_stdin.write(&invalid_bytes);
    let (_, invalid_report) =
        client.execute(ELF, invalid_stdin).run().context("executing invalid guest input")?;
    if invalid_report.exit_code == 0 {
        bail!("guest accepted the invalid signed event");
    }

    println!("guest == native");
    println!("guest and native reject the re-committed signed-byte mutation");
    println!("cycles: {}", report.total_instruction_count());
    println!("PGU: {}", report.gas().unwrap_or(0));
    println!("events: {}", native.outcomes.len());
    println!("audit entries: {}", native.count);
    println!("data commitment: {:#x}", native.data_commitment);
    println!("accepted digest: {:#x}", native.accepted_events_digest);
    println!("skipped digest: {:#x}", native.skipped_digest);
    Ok(())
}
