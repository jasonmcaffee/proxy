//! Streaming reverse proxy implementation shared by the production binary and integration tests.

use napi_derive::napi;
use std::thread;
use tracing_subscriber::EnvFilter;

pub mod config;
pub mod diagnostics;
pub mod logging;
pub mod metrics;
pub mod proxy;
pub mod routing;
pub mod server;
pub mod socket_guard;

pub use config::Config;
pub use server::{build_state, run, run_with_listener};

/// Selects JSON or compact text logs without allowing request payloads into either format.
pub fn initialize_logging() {
    let filter = EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("proxy_rs=info"));
    if std::env::var("PROXY_LOG_FORMAT").is_ok_and(|value| value.eq_ignore_ascii_case("json")) {
        tracing_subscriber::fmt().with_env_filter(filter).json().try_init().ok();
    } else {
        tracing_subscriber::fmt().with_env_filter(filter).compact().try_init().ok();
    }
}

/// Starts the Rust proxy runtime inside the authorized Node host process.
#[napi]
pub fn start_proxy() -> napi::Result<()> {
    initialize_logging();
    let config = Config::from_env().map_err(napi::Error::from_reason)?;
    let listen_addr = config.listen_addr;
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(4)
        .max_blocking_threads(8)
        .enable_all()
        .build()
        .map_err(|error| napi::Error::from_reason(error.to_string()))?;
    let listener = runtime.block_on(tokio::net::TcpListener::bind(listen_addr)).map_err(|error| napi::Error::from_reason(error.to_string()))?;
    let state = {
        let _runtime_context = runtime.enter();
        build_state(config).map_err(|error| napi::Error::from_reason(error.to_string()))?
    };
    thread::Builder::new()
        .name("proxy-rs-runtime".to_string())
        .spawn(move || {
            if let Err(error) = runtime.block_on(run_with_listener(listener, state)) {
                tracing::error!(error = %error, "native proxy runtime exited");
                std::process::exit(1);
            }
        })
        .map_err(|error| napi::Error::from_reason(error.to_string()))?;
    Ok(())
}
