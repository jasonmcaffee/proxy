use bytes::Bytes;
use http_body_util::{BodyExt, Empty};
use hyper::{Request, Uri, header::HOST};
use hyper_util::{
    client::legacy::{Client, connect::HttpConnector},
    rt::TokioExecutor,
};
use serde::Serialize;
use std::{
    env,
    error::Error,
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
    time::Instant,
};
use tokio::sync::Mutex;

type BenchClient = Client<HttpConnector, Empty<Bytes>>;
type BenchError = Box<dyn Error + Send + Sync>;

/// Machine-readable result from one bounded HTTP load probe.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Benchmark {
    url: String,
    host: String,
    requests: usize,
    concurrency: usize,
    successful: usize,
    elapsed_ms: u128,
    requests_per_second: f64,
    p50_ms: u128,
    p95_ms: u128,
    p99_ms: u128,
    max_ms: u128,
}

/// Runs the repeatable baseline load shape configured through BENCH_* variables.
#[tokio::main]
async fn main() -> Result<(), BenchError> {
    let url = env::var("BENCH_URL").unwrap_or_else(|_| "http://127.0.0.1/".to_string());
    let host = env::var("BENCH_HOST").unwrap_or_else(|_| "jasonmcaffee.com".to_string());
    let requests = read_usize("BENCH_REQUESTS", 500)?;
    let concurrency = read_usize("BENCH_CONCURRENCY", 25)?.min(requests);
    let client = Arc::new(client());
    let next = Arc::new(AtomicUsize::new(0));
    let successful = Arc::new(AtomicUsize::new(0));
    let latencies = Arc::new(Mutex::new(Vec::with_capacity(requests)));
    let started = Instant::now();
    let mut workers = Vec::with_capacity(concurrency);
    for _ in 0..concurrency {
        workers.push(tokio::spawn(worker(client.clone(), next.clone(), successful.clone(), latencies.clone(), url.clone(), host.clone(), requests)));
    }
    for worker in workers {
        worker.await??;
    }
    let elapsed = started.elapsed();
    let mut values = latencies.lock().await.clone();
    values.sort_unstable();
    let result = Benchmark {
        url,
        host,
        requests,
        concurrency,
        successful: successful.load(Ordering::Relaxed),
        elapsed_ms: elapsed.as_millis(),
        requests_per_second: requests as f64 / elapsed.as_secs_f64(),
        p50_ms: percentile(&values, 0.50),
        p95_ms: percentile(&values, 0.95),
        p99_ms: percentile(&values, 0.99),
        max_ms: values.last().copied().unwrap_or_default(),
    };
    println!("{}", serde_json::to_string_pretty(&result)?);
    if result.successful != requests {
        std::process::exit(1);
    }
    Ok(())
}

/// Performs requests until the shared sequence reaches the configured total.
async fn worker(
    client: Arc<BenchClient>, next: Arc<AtomicUsize>, successful: Arc<AtomicUsize>, latencies: Arc<Mutex<Vec<u128>>>, url: String, host: String, total: usize,
) -> Result<(), BenchError> {
    loop {
        if next.fetch_add(1, Ordering::Relaxed) >= total {
            return Ok(());
        }
        let started = Instant::now();
        let request = Request::builder().uri(url.parse::<Uri>()?).header(HOST, host.as_str()).body(Empty::new())?;
        let response = client.request(request).await?;
        let status = response.status();
        response.into_body().collect().await?;
        if status.is_success() || status.is_redirection() {
            successful.fetch_add(1, Ordering::Relaxed);
        }
        latencies.lock().await.push(started.elapsed().as_millis());
    }
}

/// Creates the pooled HTTP client shared by benchmark workers.
fn client() -> BenchClient {
    let mut connector = HttpConnector::new();
    connector.enforce_http(true);
    Client::builder(TokioExecutor::new()).build(connector)
}

/// Reads one positive benchmark integer from the environment.
fn read_usize(name: &str, fallback: usize) -> Result<usize, BenchError> {
    let value = env::var(name).map_or(Ok(fallback), |value| value.parse::<usize>())?;
    if value == 0 {
        return Err(format!("{name} must be greater than zero").into());
    }
    Ok(value)
}

/// Selects one nearest-rank latency percentile from sorted samples.
fn percentile(values: &[u128], percentile: f64) -> u128 {
    if values.is_empty() {
        return 0;
    }
    let index = ((values.len() - 1) as f64 * percentile).round() as usize;
    values[index]
}
