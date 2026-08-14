//! Host/prover for the isolated `trust-graph-weighted` V1 SP1 program.

use alloy_primitives::{Address, B256};
use anyhow::Result;
use clap::Subcommand;
use sp1_sdk::{include_elf, Elf};
use weighted_prior_core::{
    compute::compute,
    encode,
    manifest::{canonical_manifest, manifest_digest, prior_root},
    Binding, GuestInput, Params, PriorEntry, RawEdge, PARAMS_VERSION, SCALE,
};

use crate::common;

pub fn elf() -> Elf {
    include_elf!("trustgraph-weighted-program")
}

fn account(index: u64) -> Address {
    let mut bytes = [0u8; 20];
    bytes[12..].copy_from_slice(&index.to_be_bytes());
    Address::from(bytes)
}

fn edge_between(
    attester: Address,
    recipient: Address,
    uid: u64,
    timestamp: u64,
    weight: u64,
) -> RawEdge {
    let mut data = vec![0u8; 64];
    data[56..64].copy_from_slice(&weight.to_be_bytes());
    RawEdge {
        kind: 0,
        attester,
        recipient,
        uid: B256::from([uid as u8; 32]),
        block_timestamp: timestamp,
        data,
    }
}

fn edge(from: u64, to: u64, uid: u64, timestamp: u64, weight: u64) -> RawEdge {
    let mut edge = edge_between(account(from), account(to), uid, timestamp, weight);
    let mut uid_bytes = [0u8; 32];
    uid_bytes[24..].copy_from_slice(&uid.to_be_bytes());
    edge.uid = B256::from(uid_bytes);
    edge.data = vec![0u8; 32];
    edge.data[24..].copy_from_slice(&weight.to_be_bytes());
    edge
}

fn input_from(prior: Vec<PriorEntry>, edges: Vec<RawEdge>, max_iterations: u32) -> GuestInput {
    let manifest = canonical_manifest(10, &prior).expect("canonical built-in manifest");
    let params = Params {
        version: PARAMS_VERSION,
        damping_fp: 850_000_000_000_000_000,
        tolerance_fp: 0,
        max_iterations,
        min_weight: 0,
        max_weight: 100,
        prior_root: prior_root(&prior).expect("canonical built-in prior"),
        prior_count: prior.len() as u32,
        manifest_sha256: manifest_digest(&manifest),
        schema_uid: B256::from([0xAB; 32]),
        weight_field_index: 1,
        accumulator: Address::from([0xAC; 20]),
        chain_id: 10,
    };
    GuestInput {
        edges,
        params,
        manifest,
        binding: Binding {
            recipient: Address::from([0xBE; 20]),
            instance_domain: zk_core::journal::instance_domain(Address::from([0x5A; 20]), 10),
        },
    }
}

/// Production golden scenario. Its normalized prior/root/digest are the accepted research vector;
/// its graph adds sparse, dangling/self, and disconnected-nonprior cases in one witness.
pub fn sample_input() -> GuestInput {
    let a = Address::from([0x11; 20]);
    let b = Address::from([0x22; 20]);
    let c = Address::from([0x33; 20]);
    let d = Address::from([0x44; 20]);
    let e = Address::from([0x55; 20]);
    let prior = vec![
        PriorEntry { account: a, weight: 740_740_740_740_740_741 },
        PriorEntry { account: b, weight: 185_185_185_185_185_185 },
        PriorEntry { account: c, weight: 74_074_074_074_074_074 },
    ];
    let edges = vec![
        edge_between(a, b, 1, 100, 3),
        edge_between(a, c, 2, 101, 1),
        edge_between(b, c, 3, 102, 5),
        // Self-only row: account 0x33 is dangling under the normative transition filter.
        edge_between(c, c, 4, 103, 99),
        // Disconnected nonprior component: both outputs must remain zero and be omitted.
        edge_between(d, e, 5, 104, 1),
        edge_between(e, d, 6, 105, 1),
    ];
    input_from(prior, edges, 40)
}

/// Named release fixtures for host/guest public-value parity. The constitutional max-size case is
/// generated separately by [`benchmark_input`] so normal parity checks remain quick.
pub fn parity_inputs() -> Vec<(&'static str, GuestInput)> {
    let a = account(1);
    let b = account(2);
    let c = account(3);
    let d = account(4);
    let balanced = vec![
        PriorEntry { account: a, weight: SCALE / 2 },
        PriorEntry { account: b, weight: SCALE / 2 },
    ];

    let empty = input_from(balanced.clone(), vec![], 40);
    let sparse = input_from(balanced.clone(), vec![edge_between(a, b, 11, 100, 3)], 40);
    let dangling = input_from(
        balanced,
        vec![edge_between(a, a, 12, 100, 100), edge_between(b, b, 13, 101, 100)],
        40,
    );
    let concentrated = input_from(
        vec![
            PriorEntry { account: a, weight: SCALE - 2 },
            PriorEntry { account: b, weight: 1 },
            PriorEntry { account: c, weight: 1 },
        ],
        vec![edge_between(a, b, 14, 100, 3), edge_between(a, c, 15, 101, 1)],
        40,
    );
    let mut tie = input_from(
        vec![PriorEntry { account: a, weight: SCALE }],
        vec![
            edge_between(a, b, 16, 100, 1),
            edge_between(a, c, 17, 101, 1),
            edge_between(a, d, 18, 102, 1),
        ],
        1,
    );
    // Forces two missing Hamilton units across three equal remainders; ascending address wins.
    tie.params.damping_fp = 850_000_000_000_000_001;

    vec![
        ("empty", empty),
        ("sparse", sparse),
        ("dangling", dangling),
        ("concentrated", concentrated),
        ("tie", tie),
    ]
}

/// Deterministic degree-N ring used for the constitutional 2,048/degree-16/40 cycle gate.
pub fn benchmark_input(count: usize, degree: usize, max_iterations: u32) -> GuestInput {
    assert!(count > 0 && count <= 2_048 && degree < count);
    let base = SCALE / count as u64;
    let remainder = SCALE % count as u64;
    let prior = (0..count)
        .map(|index| PriorEntry {
            account: account(index as u64 + 1),
            weight: base + u64::from((index as u64) < remainder),
        })
        .collect::<Vec<_>>();
    let mut edges = Vec::with_capacity(count * degree);
    for source in 0..count {
        let mut targets = (1..=degree).map(|offset| (source + offset) % count).collect::<Vec<_>>();
        targets.sort_unstable();
        for (position, target) in targets.into_iter().enumerate() {
            edges.push(edge(
                source as u64 + 1,
                target as u64 + 1,
                (source * degree + position + 1) as u64,
                (source * degree + position + 1) as u64,
                (position % 16 + 1) as u64,
            ));
        }
    }
    let mut input = input_from(prior, edges, max_iterations);
    input.params.weight_field_index = 0;
    input
}

fn load_input(path: Option<&String>) -> Result<GuestInput> {
    match path {
        Some(path) => Ok(serde_json::from_str(&std::fs::read_to_string(path)?)?),
        None => Ok(sample_input()),
    }
}

#[derive(Subcommand)]
pub enum Command {
    /// Print the weighted guest verification key (bytes32).
    Vkey,
    /// Print keccak256 of the frozen weighted V1 params tuple.
    Paramshash { input: Option<String> },
    /// Execute the guest and byte-assert its journal against native computation.
    Execute {
        input: Option<String>,
        #[arg(long)]
        out_dir: Option<String>,
    },
    /// Prove and locally verify a weighted root.
    Prove {
        input: Option<String>,
        #[arg(long)]
        groth16: bool,
        #[arg(long)]
        out_dir: Option<String>,
    },
}

const OUT_DIR: &str = "trust-graph-weighted";

pub fn run(command: Command) -> Result<()> {
    match command {
        Command::Vkey => common::print_vkey(elf()),
        Command::Paramshash { input } => {
            let input = load_input(input.as_ref())?;
            println!("0x{}", hex::encode(encode::params_hash(&input.params)));
            Ok(())
        }
        Command::Execute { input, out_dir } => {
            execute(load_input(input.as_ref())?, common::out_dir(out_dir.as_ref(), OUT_DIR)?)
        }
        Command::Prove { input, groth16, out_dir } => {
            prove(load_input(input.as_ref())?, groth16, common::out_dir(out_dir.as_ref(), OUT_DIR)?)
        }
    }
}

fn execute(input: GuestInput, out: std::path::PathBuf) -> Result<()> {
    let native = compute(&input)?;
    let public_values = encode::journal_encoded(&native.journal);
    let execution = common::execute_values_untraced(elf(), &input, &public_values)?;
    println!("guest cycles: {}", execution.cycles);
    println!("guest == native  ✓");
    println!("journalDigest: 0x{}", hex::encode(encode::journal_digest(&native.journal)));
    println!("outputRoot:    0x{}", hex::encode(native.journal.output_root));
    println!("paramsHash:    0x{}", hex::encode(native.journal.params_hash));
    println!("ipfsHash:      0x{}", hex::encode(native.journal.ipfs_hash));
    println!("cid:           {}", native.cid);
    println!("iterations:    {}", native.iterations);
    let path = common::write_out(&out, "blob.json", &native.blob)?;
    println!("wrote {} ({} bytes)", path.display(), native.blob.len());
    Ok(())
}

fn prove(input: GuestInput, groth16: bool, out: std::path::PathBuf) -> Result<()> {
    let native = compute(&input)?;
    let proof = common::prove_values(elf(), &input, groth16)?;
    let proof_path = common::write_out(&out, "proof.bin", proof.blob())?;
    common::write_out(&out, "public_values.bin", &proof.public_values)?;
    let blob_path = common::write_out(&out, "blob.json", &native.blob)?;
    println!("vkey: {}", proof.vkey);
    println!("local verify ✓");
    println!("wrote {}", proof_path.display());
    println!("wrote {}", blob_path.display());
    Ok(())
}
