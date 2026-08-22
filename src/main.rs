use proxy_rs::{Config, initialize_logging, run};

/// Loads configuration, initializes structured logging, and runs the proxy process.
#[tokio::main]
async fn main() {
    initialize_logging();
    let config = match Config::from_env() {
        Ok(config) => config,
        Err(error) => {
            tracing::error!(error = %error, "invalid proxy configuration");
            std::process::exit(2);
        }
    };
    tracing::info!(
        next = %config.nextjs_target,
        ai = %config.ai_target,
        ai_api = %config.ai_service_target,
        media = %config.media_target,
        plex = %config.plex_target,
        chordical_api = %config.chordical_api_target,
        chordical_ui = %config.chordical_ui_target,
        git = %config.git_target,
        phone = %config.phone_sync_target,
        "proxy targets loaded"
    );
    if let Err(error) = run(config).await {
        tracing::error!(error = %error, "proxy exited");
        std::process::exit(1);
    }
}
