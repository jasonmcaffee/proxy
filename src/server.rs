use crate::{
    config::Config,
    logging::RequestLog,
    metrics::ProxyMetrics,
    proxy::{AppState, handle_request},
};
use hyper::{Request, body::Incoming, server::conn::http1, service::service_fn};
use hyper_util::{
    client::legacy::{Client, connect::HttpConnector},
    rt::{TokioExecutor, TokioIo, TokioTimer},
};
use socket2::{SockRef, TcpKeepalive};
use std::{
    error::Error,
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    },
    time::Duration,
};
use tokio::{
    net::{TcpListener, TcpStream},
    sync::Semaphore,
};
use tracing::{info, warn};

/// Builds the pooled upstream client, metrics registry, and request logger.
pub fn build_state(config: Config) -> Result<AppState, Box<dyn Error + Send + Sync>> {
    let mut connector = HttpConnector::new();
    connector.enforce_http(true);
    connector.set_connect_timeout(Some(config.connect_timeout));
    connector.set_nodelay(true);
    connector.set_keepalive(Some(config.keep_alive));
    let client = Client::builder(TokioExecutor::new())
        .pool_timer(TokioTimer::new())
        .pool_idle_timeout(Duration::from_secs(90))
        .pool_max_idle_per_host(config.max_idle_per_host)
        .build(connector);
    Ok(AppState::new(config, client, ProxyMetrics::new()?, RequestLog::new()))
}

/// Binds the configured address and serves until the process receives Ctrl-C.
pub async fn run(config: Config) -> Result<(), Box<dyn Error + Send + Sync>> {
    let listener = TcpListener::bind(config.listen_addr).await?;
    let state = build_state(config)?;
    run_with_listener(listener, state).await
}

/// Serves an already-bound listener for production and ephemeral-port integration tests.
pub async fn run_with_listener(listener: TcpListener, state: AppState) -> Result<(), Box<dyn Error + Send + Sync>> {
    let address = listener.local_addr()?;
    let limits = Arc::new(Semaphore::new(state.config.max_connections));
    let current_connections = Arc::new(AtomicU64::new(0));
    info!(listen = %address, version = env!("CARGO_PKG_VERSION"), "Rust proxy listening");

    loop {
        let (stream, peer) = listener.accept().await?;
        let permit = match limits.clone().try_acquire_owned() {
            Ok(permit) => permit,
            Err(_) => {
                state.metrics.rejected_connection();
                drop(stream);
                continue;
            }
        };
        configure_stream(&stream, state.config.keep_alive);
        let connection_count = current_connections.fetch_add(1, Ordering::Relaxed) + 1;
        state.metrics.accepted_connection(connection_count);
        let connection_counter = current_connections.clone();
        let connection_state = state.clone();

        tokio::spawn(async move {
            let service = service_fn(move |request: Request<Incoming>| handle_request(request, peer, connection_state.clone()));
            let result = http1::Builder::new().keep_alive(true).serve_connection(TokioIo::new(stream), service).with_upgrades().await;
            if let Err(error) = result {
                tracing::debug!(peer = %peer, error = %error, "downstream connection ended");
            }
            connection_counter.fetch_sub(1, Ordering::Relaxed);
            drop(permit);
        });
    }
}

/// Applies TCP settings that recover vanished peers and minimize interactive latency.
fn configure_stream(stream: &TcpStream, keep_alive: Duration) {
    if let Err(error) = stream.set_nodelay(true) {
        warn!(error = %error, "failed to set TCP_NODELAY");
    }
    let keepalive = TcpKeepalive::new().with_time(keep_alive).with_interval(Duration::from_secs(10));
    if let Err(error) = SockRef::from(stream).set_tcp_keepalive(&keepalive) {
        warn!(error = %error, "failed to configure TCP keepalive");
    }
}
