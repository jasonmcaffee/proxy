use bytes::Bytes;
use http_body_util::{BodyExt, Empty};
use hyper::{Request, Uri, header::HOST};
use hyper_util::{
    client::legacy::{Client, connect::HttpConnector},
    rt::TokioExecutor,
};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::{env, error::Error};

type ProbeClient = Client<HttpConnector, Empty<Bytes>>;
type ProbeError = Box<dyn Error + Send + Sync>;

/// Stable response properties compared between the Node and Rust listeners.
#[derive(Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
struct Snapshot {
    status: u16,
    content_type: String,
    location: String,
    cors: String,
    body_length: usize,
    body_sha256: String,
}

/// One route comparison emitted as machine-readable rollout evidence.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Comparison {
    host: &'static str,
    path: &'static str,
    matches: bool,
    baseline: Snapshot,
    candidate: Snapshot,
}

/// Compares safe production routes on two local listeners and fails on any mismatch.
#[tokio::main]
async fn main() -> Result<(), ProbeError> {
    let baseline = env::var("BASELINE_URL").unwrap_or_else(|_| "http://127.0.0.1".to_string());
    let candidate = env::var("CANDIDATE_URL").unwrap_or_else(|_| "http://127.0.0.1:18080".to_string());
    let client = client();
    let routes = [
        ("jasonmcaffee.com", "/"),
        ("www.jasonmcaffee.com", "/"),
        ("ai.jasonmcaffee.com", "/"),
        ("media.jasonmcaffee.com", "/"),
        // Gitea's login page embeds a per-request CSRF token; its stable version route is the
        // correct byte-for-byte proxy comparison surface.
        ("git.jasonmcaffee.com", "/api/v1/version"),
        ("phone.jasonmcaffee.com", "/"),
        ("chordical.com", "/"),
        ("www.chordical.com", "/"),
        ("api.chordical.com", "/"),
    ];
    let mut comparisons = Vec::new();
    for (host, path) in routes {
        let old = snapshot(&client, &baseline, host, path).await?;
        let new = snapshot(&client, &candidate, host, path).await?;
        comparisons.push(Comparison { host, path, matches: old == new, baseline: old, candidate: new });
    }
    println!("{}", serde_json::to_string_pretty(&comparisons)?);
    if comparisons.iter().any(|comparison| !comparison.matches) {
        std::process::exit(1);
    }
    Ok(())
}

/// Creates a pooled local HTTP client for rollout probes.
fn client() -> ProbeClient {
    let mut connector = HttpConnector::new();
    connector.enforce_http(true);
    Client::builder(TokioExecutor::new()).build(connector)
}

/// Fetches and hashes the semantic response contract for one host/path pair.
async fn snapshot(client: &ProbeClient, base: &str, host: &str, path: &str) -> Result<Snapshot, ProbeError> {
    let uri = format!("{base}{path}").parse::<Uri>()?;
    let request = Request::builder().uri(uri).header(HOST, host).body(Empty::new())?;
    let response = client.request(request).await?;
    let status = response.status().as_u16();
    let content_type = header(response.headers(), "content-type");
    let location = header(response.headers(), "location");
    let cors = header(response.headers(), "access-control-allow-origin");
    let body = response.into_body().collect().await?.to_bytes();
    Ok(Snapshot { status, content_type, location, cors, body_length: body.len(), body_sha256: format!("{:x}", Sha256::digest(&body)) })
}

/// Reads one response header as a comparable string.
fn header(headers: &hyper::HeaderMap, name: &str) -> String {
    headers.get(name).and_then(|value| value.to_str().ok()).unwrap_or_default().to_string()
}
