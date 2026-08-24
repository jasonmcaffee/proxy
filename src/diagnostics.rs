use crate::{config::Config, metrics::ProxyMetrics, socket_guard::SocketGuard};
use bytes::Bytes;
use http_body_util::{BodyExt, Full, combinators::UnsyncBoxBody};
use hyper::{Response, StatusCode, header::CONTENT_TYPE};
use serde_json::json;
use std::{convert::Infallible, error::Error, net::IpAddr};

pub type BoxError = Box<dyn Error + Send + Sync>;
pub type ProxyBody = UnsyncBoxBody<Bytes, BoxError>;

/// Returns true only for the actual accepted loopback peer, never forwarded headers.
pub fn diagnostics_authorized(peer: IpAddr) -> bool {
    peer.is_loopback()
}

/// Returns an internal diagnostic response for recognized loopback-only paths.
pub fn diagnostic_response(path: &str, peer: IpAddr, config: &Config, metrics: &ProxyMetrics, guard: &SocketGuard) -> Option<Response<ProxyBody>> {
    if !diagnostics_authorized(peer) {
        return None;
    }
    match path {
        "/__proxy/health" => {
            Some(json_response(StatusCode::OK, json!({ "status": "ok", "version": env!("CARGO_PKG_VERSION"), "uptimeSeconds": metrics.uptime().as_secs() })))
        }
        "/__proxy/ready" => Some(json_response(StatusCode::OK, json!({ "status": "ready", "listen": config.listen_addr.to_string(), "targets": 9 }))),
        "/__proxy/socket-stats" => Some(json_response(StatusCode::OK, socket_stats(metrics, guard))),
        "/__proxy/metrics" => Some(metrics_response(metrics)),
        _ => None,
    }
}

/// Merges the connection counters with the socket guard's reap accounting.
///
/// The kernel nonpaged-pool watchdog in the AI service tells whoever is diagnosing a RAM breach to
/// read this endpoint for "how many proxied pairs are open and how many the guard has reaped"
/// (task-1556). The rewrite dropped the guard, so those fields silently disappeared; they are back,
/// under their original names, alongside the newer process counters.
fn socket_stats(metrics: &ProxyMetrics, guard: &SocketGuard) -> serde_json::Value {
    let mut value = serde_json::to_value(metrics.socket_stats()).unwrap_or_else(|_| json!({}));
    let snapshot = serde_json::to_value(guard.snapshot(10)).unwrap_or_else(|_| json!({}));
    if let (Some(target), Some(source)) = (value.as_object_mut(), snapshot.as_object()) {
        for (key, entry) in source {
            if key == "oldest" {
                continue;
            }
            target.insert(key.clone(), entry.clone());
        }
        // The guard sees every in-flight HTTP exchange; the metrics list sees upgraded tunnels only.
        let mut oldest = source.get("oldest").and_then(|rows| rows.as_array()).cloned().unwrap_or_default();
        if let Some(tunnels) = target.get("oldest").and_then(|rows| rows.as_array()) {
            oldest.extend(tunnels.iter().cloned());
        }
        target.insert("oldest".to_string(), json!(oldest));
    }
    value
}

/// Builds a JSON response with a fixed content type.
pub fn json_response(status: StatusCode, value: serde_json::Value) -> Response<ProxyBody> {
    let bytes = serde_json::to_vec(&value).unwrap_or_else(|_| b"{\"error\":\"serialization failure\"}".to_vec());
    Response::builder().status(status).header(CONTENT_TYPE, "application/json; charset=utf-8").body(full_body(bytes)).expect("static diagnostic response")
}

/// Builds the Prometheus scrape response, returning a safe 500 if encoding fails.
fn metrics_response(metrics: &ProxyMetrics) -> Response<ProxyBody> {
    match metrics.encode() {
        Ok(bytes) => Response::builder()
            .status(StatusCode::OK)
            .header(CONTENT_TYPE, "text/plain; version=0.0.4; charset=utf-8")
            .body(full_body(bytes))
            .expect("metrics response"),
        Err(_) => json_response(StatusCode::INTERNAL_SERVER_ERROR, json!({"error":"metrics encoding failed"})),
    }
}

/// Boxes one bounded in-memory response body into the proxy's common body type.
pub fn full_body<T: Into<Bytes>>(value: T) -> ProxyBody {
    Full::new(value.into()).map_err(|never: Infallible| -> BoxError { match never {} }).boxed_unsync()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::{Ipv4Addr, Ipv6Addr};

    #[test]
    fn diagnostics_only_trust_actual_loopback_peers() {
        assert!(diagnostics_authorized(IpAddr::V4(Ipv4Addr::LOCALHOST)));
        assert!(diagnostics_authorized(IpAddr::V6(Ipv6Addr::LOCALHOST)));
        assert!(!diagnostics_authorized("203.0.113.10".parse().unwrap()));
    }
}
