//! Read-only live strict-lane availability and consensus preflight used before `trigger()`.

use alloy_primitives::B256;
use alloy_sol_types::{sol, SolCall};
use anyhow::{Context, Result};
use clap::Parser;
use input_exporter::envelope0_fetch::FetchConfig;
use input_exporter::envelope0_witness::{assemble_strict_witness, PayloadSource, WitnessRequest};
use input_exporter::rpc::{parse_addr, Rpc};
use pagerank_core::Params;
use std::path::PathBuf;
use std::time::Duration;

sol! {
    function anchorAcc() external view returns (bytes32);
    function anchorCount() external view returns (uint64);
}

#[derive(Parser, Debug)]
#[command(about = "Verify every current strict Envelope0 bundle before snapshot.trigger()")]
struct Args {
    #[arg(long)]
    rpc: String,
    /// Hard deadline for each JSON-RPC request.
    #[arg(long, default_value_t = input_exporter::rpc::DEFAULT_RPC_TIMEOUT_SECONDS)]
    rpc_timeout_seconds: u64,
    #[arg(long)]
    registry: String,
    #[arg(long)]
    params: String,
    #[arg(long, default_value_t = 0)]
    from_block: u64,
    #[arg(long, default_value_t = 10_000)]
    chunk: u64,
    #[arg(long, required = true)]
    envelope0_gateway: Vec<String>,
    #[arg(long, default_value = ".trustgraph/cache/envelope0")]
    envelope0_cache: String,
    #[arg(long, default_value_t = 8)]
    envelope0_fetch_concurrency: usize,
}

#[tokio::main]
async fn main() -> Result<()> {
    let args = Args::parse();
    anyhow::ensure!(args.rpc_timeout_seconds > 0, "--rpc-timeout-seconds must be at least 1");
    let rpc = Rpc::with_timeout(args.rpc, Duration::from_secs(args.rpc_timeout_seconds));
    let registry = parse_addr(&args.registry)?;
    let params: Params = serde_json::from_str(
        &std::fs::read_to_string(&args.params)
            .with_context(|| format!("reading params {}", args.params))?,
    )
    .context("parsing strict lane params")?;
    let block = rpc.block_number().await.context("reading preflight head")?;
    let tag = format!("0x{block:x}");
    let acc = anchorAccCall::abi_decode_returns(
        &rpc.eth_call_at(registry, anchorAccCall {}.abi_encode(), tag.clone())
            .await
            .context("reading live anchorAcc")?,
    )?;
    let count = anchorCountCall::abi_decode_returns(
        &rpc.eth_call_at(registry, anchorCountCall {}.abi_encode(), tag)
            .await
            .context("reading live anchorCount")?,
    )?;
    let report = assemble_strict_witness(
        &rpc,
        WitnessRequest {
            registry,
            from_block: args.from_block,
            to_block: block,
            chunk: args.chunk,
            expected_acc: B256::from(acc),
            expected_count: count,
            params: &params,
            payload_source: PayloadSource::Hosted(FetchConfig {
                gateways: args.envelope0_gateway,
                cache_dir: PathBuf::from(args.envelope0_cache),
                concurrency: args.envelope0_fetch_concurrency,
                timeout: Duration::from_secs(20),
            }),
        },
    )
    .await?;
    println!(
        "{{\"block\":{block},\"anchorCount\":{count},\"nodes\":{},\"mutations\":{},\"cacheHits\":{},\"gatewayAttempts\":{},\"exactReaders\":{},\"fetchLatencyMs\":{}}}",
        report.witness.payloads.len(),
        report.mutation_count,
        report.fetch.cache_hits,
        report.fetch.gateway_attempts,
        report.fetch.gateway_successes,
        report.fetch.latency_ms
    );
    Ok(())
}
