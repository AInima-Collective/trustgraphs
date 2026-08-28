//! Envelope-1 (atproto) conformance harness: run the `trustgraph-atproto-conformance` guest
//! over a witness (CAR + PLC audit log) and byte-assert guest == native — the M3 exit's
//! "guest proves a real repo end-to-end", plus the in-guest decode cycle number the M1
//! parser verdict deferred.
//!
//! This is a conformance harness, not a production program: it has no on-chain consumer,
//! no journal contract, and does not appear in docs/concepts/networks-and-programs.md's index.

use alloy_primitives::{keccak256, B256};
use anyhow::{anyhow, bail, Context, Result};
use clap::Subcommand;
use envelopes::atproto::{self, plc::PlcOpWitness, AtprotoWitness};
use sp1_sdk::{include_elf, Elf};

fn load_elf() -> Elf {
    include_elf!("trustgraph-atproto-conformance")
}

/// `atproto-conformance` subcommands.
#[derive(Subcommand)]
pub enum Command {
    /// Execute the envelope-1 guest over a witness and byte-assert guest == native.
    Execute {
        /// Path to the repo CAR (e.g. tests/fixtures/atproto/repos/atproto.car or a witness-bundle CAR).
        #[arg(long)]
        car: String,
        /// Path to the PLC audit log JSON (plc.directory /log/audit shape).
        #[arg(long)]
        plc: String,
        /// Comma-separated collection NSIDs to walk.
        #[arg(long)]
        collections: String,
        /// The epoch's deterministic timestamp (drives the 72h-provisional rule).
        #[arg(long, default_value_t = 2_000_000_000)]
        now: u64,
    },
}

/// JSON → Ipld for PLC ops (strings/lists/maps/null/bool/int only). Canonicality is
/// enforced downstream: `plc::decode_op` re-encodes and asserts byte-identity, and the
/// genesis-hash == DID check pins the whole conversion.
fn json_to_ipld(v: &serde_json::Value) -> Result<ipld_core::ipld::Ipld> {
    use ipld_core::ipld::Ipld;
    Ok(match v {
        serde_json::Value::Null => Ipld::Null,
        serde_json::Value::Bool(b) => Ipld::Bool(*b),
        serde_json::Value::Number(n) => {
            Ipld::Integer(n.as_i64().ok_or_else(|| anyhow!("non-i64 number in plc op"))? as i128)
        }
        serde_json::Value::String(s) => Ipld::String(s.clone()),
        serde_json::Value::Array(a) => {
            Ipld::List(a.iter().map(json_to_ipld).collect::<Result<Vec<_>>>()?)
        }
        serde_json::Value::Object(o) => {
            let mut m = std::collections::BTreeMap::new();
            for (k, val) in o {
                m.insert(k.clone(), json_to_ipld(val)?);
            }
            Ipld::Map(m)
        }
    })
}

fn load_witness(car_path: &str, plc_path: &str) -> Result<(B256, B256, AtprotoWitness)> {
    let car = std::fs::read(car_path).with_context(|| format!("reading {car_path}"))?;
    let plc_json: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(plc_path)?).context("plc json")?;

    let mut did = String::new();
    let mut plc_ops = Vec::new();
    for entry in plc_json.as_array().context("audit log must be an array")? {
        did = entry["did"].as_str().context("did")?.to_string();
        let op_bytes = serde_ipld_dagcbor::to_vec(&json_to_ipld(&entry["operation"])?)?;
        let created_at = entry["createdAt"]
            .as_str()
            .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
            .map(|t| t.timestamp().max(0) as u64)
            .unwrap_or(0);
        plc_ops.push(PlcOpWitness {
            op_bytes,
            created_at,
            nullified: entry["nullified"].as_bool().unwrap_or(false),
        });
    }
    if did.is_empty() {
        bail!("empty plc audit log");
    }

    let parsed = atproto::carset::Car::parse(&car).map_err(|e| anyhow!("car parse: {e}"))?;
    let root = *parsed.roots.first().context("car has no root")?;
    let commit_bytes = parsed.get(&root).context("root block missing")?;
    let head = {
        use sha2::Digest;
        B256::from(<[u8; 32]>::from(sha2::Sha256::digest(commit_bytes)))
    };
    let node_id = atproto::did_node_id(&did);
    Ok((node_id, head, AtprotoWitness { did, car, plc_ops }))
}

pub fn run(cmd: Command) -> Result<()> {
    match cmd {
        Command::Execute { car, plc, collections, now } => {
            let (node_id, head, witness) = load_witness(&car, &plc)?;
            let cols: Vec<String> = collections.split(',').map(|s| s.trim().to_string()).collect();
            let col_refs: Vec<&str> = cols.iter().map(|s| s.as_str()).collect();

            // Native reference: same pipeline, same public-values construction as the guest.
            let records = atproto::verify(node_id, head, now, &col_refs, &witness)
                .map_err(|e| anyhow!("native envelope-1 verification failed: {e:?}"))?;
            let mut records_digest = B256::ZERO;
            for r in &records {
                let mut buf = Vec::with_capacity(r.key.len() + r.record_bytes.len());
                buf.extend_from_slice(&r.key);
                buf.extend_from_slice(&r.record_bytes);
                records_digest = zk_core::fold::fold(records_digest, keccak256(&buf));
            }
            let mut native_pub = Vec::with_capacity(32 * 4);
            native_pub.extend_from_slice(node_id.as_slice());
            native_pub.extend_from_slice(head.as_slice());
            native_pub.extend_from_slice(&zk_core::words::word_u64(records.len() as u64));
            native_pub.extend_from_slice(records_digest.as_slice());

            // Guest execution + byte-assert (prints cycles — the in-guest decode number).
            let client = sp1_sdk::blocking::ProverClient::from_env();
            let mut stdin = sp1_sdk::SP1Stdin::new();
            stdin.write(&node_id);
            stdin.write(&head);
            stdin.write(&now);
            stdin.write(&cols);
            stdin.write(&witness);
            let (public_values, report) = {
                use sp1_sdk::blocking::Prover;
                client
                    .execute(load_elf(), stdin)
                    .run()
                    .map_err(|e| anyhow!("guest execute failed: {e:?}"))?
            };
            println!("guest cycles: {}", report.total_instruction_count());
            if let Some(gas) = report.gas() {
                println!("guest PGU:    {gas}");
            }
            if public_values.as_slice() != native_pub.as_slice() {
                bail!(
                    "MISMATCH guest vs native public values\n guest:  0x{}\n native: 0x{}",
                    hex::encode(public_values.as_slice()),
                    hex::encode(&native_pub)
                );
            }
            println!("guest == native  ✓");
            println!("did:            {}", witness.did);
            println!("head:           0x{}", hex::encode(head));
            println!("records:        {}", records.len());
            println!("recordsDigest:  0x{}", hex::encode(records_digest));
            Ok(())
        }
    }
}
