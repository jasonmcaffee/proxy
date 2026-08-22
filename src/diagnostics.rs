use crate::{config::Config, metrics::ProxyMetrics};
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
pub fn diagnostic_response(path: &str, peer: IpAddr, config: &Config, metrics: &ProxyMetrics) -> Option<Response<ProxyBody>> {
    if !diagnostics_authorized(peer) {
        return None;
    }
    match path {
        "/__proxy/health" => {
            Some(json_response(StatusCode::OK, json!({ "status": "ok", "version": env!("CARGO_PKG_VERSION"), "uptimeSeconds": metrics.uptime().as_secs() })))
        }
        "/__proxy/ready" => Some(json_response(StatusCode::OK, json!({ "status": "ready", "listen": config.listen_addr.to_string(), "targets": 9 }))),
        "/__proxy/socket-stats" => {
            Some(json_response(StatusCode::OK, serde_json::to_value(metrics.socket_stats()).unwrap_or_else(|_| json!({"status":"error"}))))
        }
        "/__proxy/metrics" => Some(metrics_response(metrics)),
        _ => None,
    }
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
