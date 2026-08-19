use std::path::{Path, PathBuf};

use anyhow::{bail, ensure, Context, Result};
use buzz_sdk::{build_create_channel, build_join, ChannelKind, Visibility};
use nostr::secp256k1::rand::{rngs::StdRng, SeedableRng};
use nostr::secp256k1::SECP256K1;
use nostr::{Event, EventBuilder, Keys, SecretKey, Timestamp};
use reqwest::StatusCode;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use uuid::Uuid;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Corpus {
    channel_id: Uuid,
    principals: Principals,
    events: Vec<NamedEvent>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Principals {
    alice: String,
    bob: String,
}

#[derive(Deserialize)]
struct NamedEvent {
    name: String,
    event: Event,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SeedReport {
    format: &'static str,
    source_corpus: String,
    relay_url: String,
    channel_id: Uuid,
    receipts: Vec<Receipt>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Receipt {
    name: String,
    event_id: String,
    kind: u16,
    http_status: u16,
    accepted: bool,
    message: String,
}

fn fixed_keys(byte: u8) -> Result<Keys> {
    let secret = SecretKey::from_slice(&[byte; 32]).context("fixed Nostr fixture secret")?;
    Ok(Keys::new(secret))
}

fn deterministic_sign(
    builder: EventBuilder,
    signer: &Keys,
    created_at: u64,
    seed: u8,
) -> Result<Event> {
    let unsigned =
        builder.custom_created_at(Timestamp::from(created_at)).build(signer.public_key());
    let mut rng = StdRng::from_seed([seed; 32]);
    let event =
        unsigned.sign_with_ctx(SECP256K1, &mut rng, signer).context("signing live setup event")?;
    event.verify().context("verifying live setup event")?;
    Ok(event)
}

fn auth_tag_json(event: &Event) -> Result<Option<String>> {
    event
        .tags
        .iter()
        .find(|tag| tag.as_slice().first().map(String::as_str) == Some("auth"))
        .map(serde_json::to_string)
        .transpose()
        .context("serializing NIP-OA auth tag")
}

async fn submit(
    client: &reqwest::Client,
    relay_url: &str,
    name: impl Into<String>,
    event: &Event,
) -> Result<Receipt> {
    let name = name.into();
    let mut request = client
        .post(format!("{}/events", relay_url.trim_end_matches('/')))
        .header("X-Pubkey", event.pubkey.to_hex())
        .header("Content-Type", "application/json")
        .body(serde_json::to_vec(event).context("serializing event for relay")?);
    if let Some(auth_tag) = auth_tag_json(event)? {
        request = request.header("X-Auth-Tag", auth_tag);
    }

    let response = request
        .send()
        .await
        .with_context(|| format!("submitting {name} to the live Buzz relay"))?;
    let status = response.status();
    let bytes =
        response.bytes().await.with_context(|| format!("reading relay response for {name}"))?;
    let body: Value = serde_json::from_slice(&bytes).with_context(|| {
        format!("parsing relay response for {name}: {}", String::from_utf8_lossy(&bytes))
    })?;
    let accepted = body.get("accepted").and_then(Value::as_bool).unwrap_or(false);
    let message = body.get("message").and_then(Value::as_str).unwrap_or_default().to_owned();
    if status != StatusCode::OK || !accepted {
        bail!("relay rejected {name} ({}, HTTP {}): {body}", event.id, status.as_u16());
    }
    Ok(Receipt {
        name,
        event_id: event.id.to_hex(),
        kind: event.kind.as_u16(),
        http_status: status.as_u16(),
        accepted,
        message,
    })
}

fn write_report(output: &Path, report: &SeedReport) -> Result<()> {
    let bytes = serde_json::to_vec_pretty(report).context("serializing live seed report")?;
    std::fs::write(output, bytes)
        .with_context(|| format!("writing live seed report {}", output.display()))
}

#[tokio::main]
async fn main() -> Result<()> {
    let mut args = std::env::args_os().skip(1);
    let corpus_path = args.next().map(PathBuf::from).context(
        "usage: live_seed <live-source-corpus.json> <seed-report.json> [relay-http-url]",
    )?;
    let output_path = args.next().map(PathBuf::from).context(
        "usage: live_seed <live-source-corpus.json> <seed-report.json> [relay-http-url]",
    )?;
    let relay_url = args
        .next()
        .and_then(|value| value.into_string().ok())
        .unwrap_or_else(|| "http://127.0.0.1:33300".to_owned());
    ensure!(args.next().is_none(), "unexpected extra live_seed argument");

    let corpus_bytes = std::fs::read(&corpus_path)
        .with_context(|| format!("reading live corpus {}", corpus_path.display()))?;
    let corpus: Corpus =
        serde_json::from_slice(&corpus_bytes).context("parsing live source corpus")?;
    let alice = fixed_keys(2)?;
    let bob = fixed_keys(3)?;
    ensure!(
        corpus.principals.alice == alice.public_key().to_hex(),
        "live corpus Alice key does not match the pinned fixture key"
    );
    ensure!(
        corpus.principals.bob == bob.public_key().to_hex(),
        "live corpus Bob key does not match the pinned fixture key"
    );
    let base_time =
        corpus.events.first().context("live corpus has no events")?.event.created_at.as_secs();

    let create = deterministic_sign(
        build_create_channel(
            corpus.channel_id,
            "Trustgraphs S0 live fixture",
            Some(Visibility::Open),
            Some(ChannelKind::Stream),
            Some("Pinned Buzz/Nostr conformance export"),
            None,
        )?,
        &alice,
        base_time,
        240,
    )?;
    let join = deterministic_sign(build_join(corpus.channel_id)?, &bob, base_time + 1, 241)?;

    let client = reqwest::Client::builder().build().context("building live relay HTTP client")?;
    let skip_setup = std::env::var("TG_BUZZ_LIVE_SKIP_SETUP").as_deref() == Ok("true");
    let mut receipts = Vec::new();
    if !skip_setup {
        receipts.push(submit(&client, &relay_url, "setup-create-channel", &create).await?);
        receipts.push(submit(&client, &relay_url, "setup-bob-join", &join).await?);
    }
    for named in &corpus.events {
        if named.name == "relay-roster" {
            continue;
        }
        receipts.push(submit(&client, &relay_url, &named.name, &named.event).await?);
    }

    let report = SeedReport {
        format: "trustgraphs-buzz-live-seed-report-v1",
        source_corpus: corpus_path.display().to_string(),
        relay_url,
        channel_id: corpus.channel_id,
        receipts,
    };
    write_report(&output_path, &report)?;
    println!("accepted {} live events; wrote {}", report.receipts.len(), output_path.display());
    Ok(())
}
