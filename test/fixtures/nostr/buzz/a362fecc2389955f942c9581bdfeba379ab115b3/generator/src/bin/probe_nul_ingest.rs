use std::path::{Path, PathBuf};

use anyhow::{ensure, Context, Result};
use nostr::Event;
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Corpus {
    serializer_vectors: Vec<FixtureEvent>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct FixtureEvent {
    name: String,
    nip01_preimage: String,
    nip01_preimage_hex: String,
    event: Event,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ProbeReport {
    format: &'static str,
    name: String,
    event_id: String,
    kind: u16,
    nip01_preimage: String,
    nip01_preimage_hex: String,
    event: Event,
    http_status: u16,
    response: Value,
}

fn write_report(output: &Path, report: &ProbeReport) -> Result<()> {
    let mut bytes = serde_json::to_vec_pretty(report).context("serializing NUL probe report")?;
    bytes.push(b'\n');
    std::fs::write(output, bytes)
        .with_context(|| format!("writing NUL probe report {}", output.display()))
}

#[tokio::main]
async fn main() -> Result<()> {
    let mut args = std::env::args_os().skip(1);
    let corpus_path = args
        .next()
        .map(PathBuf::from)
        .context("usage: probe_nul_ingest <source-corpus> <output> [relay-url]")?;
    let output_path = args
        .next()
        .map(PathBuf::from)
        .context("usage: probe_nul_ingest <source-corpus> <output> [relay-url]")?;
    let relay_url = args
        .next()
        .and_then(|value| value.into_string().ok())
        .unwrap_or_else(|| "http://127.0.0.1:33300".to_owned());
    ensure!(args.next().is_none(), "unexpected extra probe_nul_ingest argument");

    let bytes = std::fs::read(&corpus_path)
        .with_context(|| format!("reading {}", corpus_path.display()))?;
    let corpus: Corpus = serde_json::from_slice(&bytes).context("parsing source corpus")?;
    let fixture = corpus
        .serializer_vectors
        .into_iter()
        .find(|fixture| fixture.name == "nip01-controls-unicode")
        .context("controls serializer vector is missing")?;
    let response = reqwest::Client::new()
        .post(format!("{}/events", relay_url.trim_end_matches('/')))
        .header("X-Pubkey", fixture.event.pubkey.to_hex())
        .header("Content-Type", "application/json")
        .body(serde_json::to_vec(&fixture.event)?)
        .send()
        .await
        .context("submitting NUL storage probe")?;
    let status = response.status();
    let body: Value = response.json().await.context("parsing NUL probe response")?;
    ensure!(status.as_u16() == 500, "NUL storage probe unexpectedly returned {status}");
    ensure!(
        body.get("error").and_then(Value::as_str) == Some("internal server error"),
        "NUL storage probe response changed: {body}"
    );
    let report = ProbeReport {
        format: "trustgraphs-buzz-nul-ingest-probe-v1",
        name: fixture.name,
        event_id: fixture.event.id.to_hex(),
        kind: fixture.event.kind.as_u16(),
        nip01_preimage: fixture.nip01_preimage,
        nip01_preimage_hex: fixture.nip01_preimage_hex,
        event: fixture.event,
        http_status: status.as_u16(),
        response: body,
    };
    write_report(&output_path, &report)?;
    println!("recorded expected HTTP 500 NUL storage rejection");
    Ok(())
}
