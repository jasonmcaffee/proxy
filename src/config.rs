use std::{
    env,
    net::{IpAddr, Ipv4Addr, SocketAddr},
    time::Duration,
};
use url::Url;

/// Validated upstream addresses and operational limits for one proxy process.
#[derive(Clone, Debug)]
pub struct Config {
    pub listen_addr: SocketAddr,
    pub nextjs_target: Url,
    pub ai_target: Url,
    pub ai_service_target: Url,
    pub media_target: Url,
    pub plex_target: Url,
    pub chordical_api_target: Url,
    pub chordical_ui_target: Url,
    pub git_target: Url,
    pub phone_sync_target: Url,
    pub connect_timeout: Duration,
    pub plex_header_timeout: Duration,
    pub upgrade_idle_timeout: Duration,
    /// How long a plain HTTP exchange may move no bytes before the socket guard reaps it (task-1556).
    pub http_idle_timeout: Duration,
    /// How often the socket guard checks every in-flight exchange (task-1556).
    pub guard_sweep_interval: Duration,
    pub keep_alive: Duration,
    pub max_connections: usize,
    pub max_upstream_per_target: usize,
    pub max_idle_per_host: usize,
}

impl Config {
    /// Loads configuration from the existing proxy `.env` and process environment.
    pub fn from_env() -> Result<Self, String> {
        dotenvy::dotenv().ok();
        let port = read_u16("PORT", 80)?;
        let host = read_ip("PROXY_LISTEN_HOST", IpAddr::V4(Ipv4Addr::UNSPECIFIED))?;
        Ok(Self {
            listen_addr: SocketAddr::new(host, port),
            nextjs_target: read_url("NEXTJS_TARGET", "http://localhost:3200")?,
            ai_target: read_url("AI_TARGET", "http://localhost:7070")?,
            ai_service_target: read_url("AI_SERVICE_TARGET", "http://localhost:8081")?,
            media_target: read_url("MEDIA_TARGET", "http://localhost:3300")?,
            plex_target: read_url("PLEX_TARGET", "http://localhost:32400")?,
            chordical_api_target: read_url_with_legacy("CHORDICAL_API_TARGET", "CHORDICAL_TARGET", "http://localhost:4500")?,
            chordical_ui_target: read_url("CHORDICAL_UI_TARGET", "http://localhost:3100")?,
            git_target: read_url("GIT_TARGET", "http://localhost:3000")?,
            phone_sync_target: read_url("PHONE_SYNC_TARGET", "http://localhost:7071")?,
            connect_timeout: Duration::from_millis(read_u64("PROXY_CONNECT_TIMEOUT_MS", 5_000)?),
            plex_header_timeout: Duration::from_millis(read_u64("PROXY_PLEX_HEADER_TIMEOUT_MS", 30_000)?),
            upgrade_idle_timeout: Duration::from_millis(read_u64("PROXY_SOCKET_IDLE_TIMEOUT_MS", 900_000)?),
            http_idle_timeout: Duration::from_millis(read_u64("PROXY_SOCKET_IDLE_TIMEOUT_MS", 900_000)?),
            guard_sweep_interval: Duration::from_millis(read_u64("PROXY_SOCKET_SWEEP_INTERVAL_MS", 15_000)?),
            keep_alive: Duration::from_millis(read_u64("PROXY_SOCKET_KEEPALIVE_MS", 60_000)?),
            max_connections: read_usize("PROXY_MAX_CONNECTIONS", 2_048)?,
            max_upstream_per_target: read_usize("PROXY_MAX_UPSTREAM_SOCKETS", 512)?,
            max_idle_per_host: read_usize("PROXY_MAX_FREE_UPSTREAM_SOCKETS", 32)?,
        })
    }

    /// Builds a deterministic all-upstreams-equal configuration for integration tests.
    pub fn for_tests(listen_addr: SocketAddr, target: Url) -> Self {
        Self {
            listen_addr,
            nextjs_target: target.clone(),
            ai_target: target.clone(),
            ai_service_target: target.clone(),
            media_target: target.clone(),
            plex_target: target.clone(),
            chordical_api_target: target.clone(),
            chordical_ui_target: target.clone(),
            git_target: target.clone(),
            phone_sync_target: target,
            connect_timeout: Duration::from_secs(1),
            plex_header_timeout: Duration::from_secs(1),
            upgrade_idle_timeout: Duration::from_secs(2),
            http_idle_timeout: Duration::from_secs(900),
            guard_sweep_interval: Duration::from_secs(3_600),
            keep_alive: Duration::from_secs(1),
            max_connections: 128,
            max_upstream_per_target: 64,
            max_idle_per_host: 8,
        }
    }
}

/// Parses an HTTP upstream URL and rejects unsupported schemes or missing authorities.
fn parse_target(name: &str, value: &str) -> Result<Url, String> {
    let url = Url::parse(value).map_err(|error| format!("{name} is invalid: {error}"))?;
    if url.scheme() != "http" {
        return Err(format!("{name} must use http because TLS terminates at Cloudflare"));
    }
    if url.host_str().is_none() {
        return Err(format!("{name} must include a host"));
    }
    Ok(url)
}

/// Reads and validates a URL environment variable.
fn read_url(name: &str, fallback: &str) -> Result<Url, String> {
    parse_target(name, &env::var(name).unwrap_or_else(|_| fallback.to_string()))
}

/// Reads a URL while honoring one historical environment-variable alias.
fn read_url_with_legacy(name: &str, legacy: &str, fallback: &str) -> Result<Url, String> {
    let value = env::var(name).or_else(|_| env::var(legacy)).unwrap_or_else(|_| fallback.to_string());
    parse_target(name, &value)
}

/// Reads a positive `u64` environment variable.
fn read_u64(name: &str, fallback: u64) -> Result<u64, String> {
    let value = match env::var(name) {
        Ok(value) => value.parse::<u64>().map_err(|_| format!("{name} must be a positive integer"))?,
        Err(_) => fallback,
    };
    if value == 0 { Err(format!("{name} must be greater than zero")) } else { Ok(value) }
}

/// Reads a positive `usize` environment variable.
fn read_usize(name: &str, fallback: usize) -> Result<usize, String> {
    let value = read_u64(name, fallback as u64)?;
    usize::try_from(value).map_err(|_| format!("{name} is too large"))
}

/// Reads a TCP port environment variable.
fn read_u16(name: &str, fallback: u16) -> Result<u16, String> {
    let value = read_u64(name, fallback as u64)?;
    u16::try_from(value).map_err(|_| format!("{name} must be between 1 and 65535"))
}

/// Reads an IP address environment variable.
fn read_ip(name: &str, fallback: IpAddr) -> Result<IpAddr, String> {
    match env::var(name) {
        Ok(value) => value.parse::<IpAddr>().map_err(|_| format!("{name} must be an IP address")),
        Err(_) => Ok(fallback),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_https_targets_at_the_cloudflare_http_boundary() {
        assert!(parse_target("TARGET", "https://localhost:443").is_err());
    }

    #[test]
    fn accepts_http_targets_with_paths() {
        let parsed = parse_target("TARGET", "http://127.0.0.1:9000/base").unwrap();
        assert_eq!(parsed.port(), Some(9000));
    }
}
