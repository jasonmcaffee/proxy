use crate::{
    config::Config,
    diagnostics::{BoxError, ProxyBody, diagnostic_response, full_body, json_response},
    logging::RequestLog,
    metrics::{ProxyMetrics, UpgradeLease},
    routing::{RouteClass, RouteDecision, route_request},
};
use bytes::Bytes;
use http_body::Frame;
use http_body_util::BodyExt;
use hyper::{
    HeaderMap, Method, Request, Response, StatusCode, Uri,
    body::Incoming,
    header::{ACCESS_CONTROL_ALLOW_HEADERS, ACCESS_CONTROL_ALLOW_METHODS, ACCESS_CONTROL_ALLOW_ORIGIN, CONNECTION, HOST, ORIGIN, REFERER, UPGRADE},
};
use hyper_util::{
    client::legacy::{Client, connect::HttpConnector},
    rt::TokioIo,
};
use serde_json::json;
use std::{
    collections::{HashMap, HashSet},
    net::{IpAddr, SocketAddr},
    sync::{Arc, Mutex},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tokio::{
    io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt},
    sync::{OwnedSemaphorePermit, Semaphore},
    time,
};

pub type HttpClient = Client<HttpConnector, ProxyBody>;

/// Shared immutable clients, configuration, limits, logs, and metrics for handlers.
#[derive(Clone)]
pub struct AppState {
    pub config: Config,
    pub client: HttpClient,
    pub metrics: ProxyMetrics,
    pub request_log: RequestLog,
    upstream_limits: Arc<Mutex<HashMap<String, Arc<Semaphore>>>>,
}

impl AppState {
    /// Creates proxy state around a configured Hyper client.
    pub fn new(config: Config, client: HttpClient, metrics: ProxyMetrics, request_log: RequestLog) -> Self {
        let upstream_limits = Arc::new(Mutex::new(HashMap::new()));
        Self { config, client, metrics, request_log, upstream_limits }
    }

    /// Acquires capacity from the selected target's independent concurrency pool.
    fn acquire_upstream(&self, route: &RouteDecision) -> Result<OwnedSemaphorePermit, ()> {
        let key = route.target.origin().ascii_serialization();
        let semaphore =
            self.upstream_limits.lock().map_err(|_| ())?.entry(key).or_insert_with(|| Arc::new(Semaphore::new(self.config.max_upstream_per_target))).clone();
        semaphore.try_acquire_owned().map_err(|_| ())
    }
}

struct PreparedForward {
    started: Instant,
    method: Method,
    original_path: String,
    route: RouteDecision,
    is_upgrade: bool,
    downstream_upgrade: Option<hyper::upgrade::OnUpgrade>,
    permit: OwnedSemaphorePermit,
}

/// Handles one downstream request, including diagnostics, preflight, streaming, and upgrades.
pub async fn handle_request(request: Request<Incoming>, peer: SocketAddr, state: AppState) -> Result<Response<ProxyBody>, BoxError> {
    if let Some(response) = diagnostic_response(request.uri().path(), peer.ip(), &state.config, &state.metrics) {
        return Ok(response);
    }
    if is_cors_preflight(&request) {
        return Ok(cors_preflight_response(&request));
    }
    let (context, outbound) = match prepare_forward_request(request, peer.ip(), &state) {
        Ok(prepared) => prepared,
        Err(response) => return Ok(*response),
    };
    let upstream = match request_upstream(&state, &context.route, outbound).await {
        Ok(response) => response,
        Err(message) => {
            return Ok(upstream_failure(&state, &context.route, &context.method, &context.original_path, context.started, context.permit, &message));
        }
    };
    Ok(finalize_upstream_response(upstream, context, &state))
}

/// Builds a validated streaming upstream request and its completion context.
fn prepare_forward_request(
    mut request: Request<Incoming>, peer: IpAddr, state: &AppState,
) -> Result<(PreparedForward, Request<ProxyBody>), Box<Response<ProxyBody>>> {
    let started = Instant::now();
    let method = request.method().clone();
    let original_path = request.uri().path_and_query().map_or("/", |value| value.as_str()).to_string();
    let route = route_request(&state.config, request.headers(), &original_path);
    let is_upgrade = is_upgrade_request(request.headers());
    let downstream_upgrade = is_upgrade.then(|| hyper::upgrade::on(&mut request));
    let permit = match state.acquire_upstream(&route) {
        Ok(permit) => permit,
        Err(_) => return Err(Box::new(capacity_response())),
    };
    state.metrics.request_started();
    let outbound = build_upstream_request(request, peer, &route, &state.metrics, is_upgrade).map_err(|error| {
        state.metrics.request_finished(route.class, method.as_str(), 400, started.elapsed());
        Box::new(json_response(StatusCode::BAD_REQUEST, json!({"error":"Bad Request","message":error,"requestId":request_id()})))
    })?;
    let context = PreparedForward { started, method, original_path, route, is_upgrade, downstream_upgrade, permit };
    Ok((context, outbound))
}

/// Sends a prepared request and applies Plex's bounded response-header wait.
async fn request_upstream(state: &AppState, route: &RouteDecision, outbound: Request<ProxyBody>) -> Result<Response<Incoming>, String> {
    if route.class == RouteClass::Plex {
        match time::timeout(state.config.plex_header_timeout, state.client.request(outbound)).await {
            Ok(result) => result.map_err(|error| error.to_string()),
            Err(_) => Err("upstream response header timeout".to_string()),
        }
    } else {
        state.client.request(outbound).await.map_err(|error| error.to_string())
    }
}

/// Converts an upstream response into a tracked body or an owned upgraded tunnel.
fn finalize_upstream_response(mut upstream: Response<Incoming>, context: PreparedForward, state: &AppState) -> Response<ProxyBody> {
    let status = upstream.status();
    let upstream_upgrade = (context.is_upgrade && status == StatusCode::SWITCHING_PROTOCOLS).then(|| hyper::upgrade::on(&mut upstream));
    remove_hop_by_hop(upstream.headers_mut(), upstream_upgrade.is_some());
    let (parts, body) = upstream.into_parts();
    let metrics = state.metrics.clone();
    let class = context.route.class;
    let details = RequestDetails {
        route: class,
        method: context.method.to_string(),
        path: context.original_path,
        host: context.route.original_host,
        status: status.as_u16(),
        started: context.started,
    };
    let lease = RequestLease::new(context.permit, metrics.clone(), state.request_log.clone(), details);
    let tracked_body = body.map_frame(move |frame| record_response_frame(frame, class, &metrics)).map_err(|error| -> BoxError { Box::new(error) });
    let mut response = Response::from_parts(parts, tracked_body.boxed_unsync());
    apply_cors(response.headers_mut());
    if let (Some(downstream), Some(upstream)) = (context.downstream_upgrade, upstream_upgrade) {
        spawn_upgrade_tunnel(downstream, upstream, state.config.upgrade_idle_timeout, state.metrics.clone(), class, lease);
        response
    } else {
        attach_response_lease(response, lease)
    }
}

/// Owns both HTTP upgrades until the bidirectional tunnel completes or idles out.
fn spawn_upgrade_tunnel(
    downstream: hyper::upgrade::OnUpgrade, upstream: hyper::upgrade::OnUpgrade, idle_timeout: Duration, metrics: ProxyMetrics, class: RouteClass,
    lease: RequestLease,
) {
    tokio::spawn(async move {
        drop(lease);
        match tokio::try_join!(downstream, upstream) {
            Ok((downstream, upstream)) => {
                let upgrade_lease = metrics.start_upgrade(class);
                if let Err(error) = tunnel_with_idle(TokioIo::new(downstream), TokioIo::new(upstream), idle_timeout, upgrade_lease).await {
                    tracing::debug!(route = class.as_str(), error = %error, "upgraded tunnel ended");
                }
            }
            Err(error) => tracing::warn!(route = class.as_str(), error = %error, "upgrade handshake failed"),
        }
    });
}

/// Keeps completion accounting alive until the downstream body is dropped.
fn attach_response_lease(response: Response<ProxyBody>, lease: RequestLease) -> Response<ProxyBody> {
    let (parts, body) = response.into_parts();
    let tracked = body.map_frame(move |frame| {
        let _keep_alive = &lease;
        frame
    });
    Response::from_parts(parts, tracked.boxed_unsync())
}

/// Rebuilds a streaming request for the selected upstream and applies forwarding policy.
fn build_upstream_request(
    request: Request<Incoming>, peer: IpAddr, route: &RouteDecision, metrics: &ProxyMetrics, preserve_upgrade: bool,
) -> Result<Request<ProxyBody>, String> {
    let (mut parts, body) = request.into_parts();
    parts.uri = upstream_uri(route)?;
    sanitize_request_headers(&mut parts.headers, peer, route, preserve_upgrade);
    let class = route.class;
    let metrics_for_body = metrics.clone();
    let body =
        body.map_frame(move |frame| record_request_frame(frame, class, &metrics_for_body)).map_err(|error| -> BoxError { Box::new(error) }).boxed_unsync();
    Ok(Request::from_parts(parts, body))
}

/// Builds an absolute HTTP URI from the configured target and rewritten path.
fn upstream_uri(route: &RouteDecision) -> Result<Uri, String> {
    let authority = match (route.target.host_str(), route.target.port_or_known_default()) {
        (Some(host), Some(port)) => format!("{host}:{port}"),
        _ => return Err("configured upstream has no authority".to_string()),
    };
    format!("http://{authority}{}", route.upstream_path).parse::<Uri>().map_err(|error| format!("invalid upstream URI: {error}"))
}

/// Removes connection-specific fields and sets the route-specific forwarding headers.
fn sanitize_request_headers(headers: &mut HeaderMap, peer: IpAddr, route: &RouteDecision, preserve_upgrade: bool) {
    remove_hop_by_hop(headers, preserve_upgrade);
    let authority = route.target.port_or_known_default().and_then(|port| route.target.host_str().map(|host| format!("{host}:{port}"))).unwrap_or_default();
    headers.insert(HOST, authority.parse().expect("validated target authority"));
    if route.plex_headers {
        headers.insert(REFERER, format!("http://{authority}").parse().unwrap());
        headers.insert(ORIGIN, format!("http://{authority}").parse().unwrap());
        headers.insert("x-forwarded-for", "127.0.0.1".parse().unwrap());
        headers.insert("x-real-ip", "127.0.0.1".parse().unwrap());
        headers.insert("x-forwarded-proto", "http".parse().unwrap());
        headers.remove("x-forwarded-host");
        return;
    }
    append_forwarded_for(headers, peer);
    let forwarded_proto =
        headers.get("x-forwarded-proto").and_then(|value| value.to_str().ok()).filter(|value| matches!(*value, "http" | "https")).unwrap_or("http").to_string();
    headers.insert("x-forwarded-proto", forwarded_proto.parse().unwrap());
    let forwarded_host = route.forwarded_host_override.unwrap_or(&route.original_host);
    if let Ok(value) = forwarded_host.parse() {
        headers.insert("x-forwarded-host", value);
    }
}

/// Removes RFC connection-specific fields, including fields nominated by `Connection`.
fn remove_hop_by_hop(headers: &mut HeaderMap, preserve_upgrade: bool) {
    let nominated = headers
        .get(CONNECTION)
        .and_then(|value| value.to_str().ok())
        .map(|value| value.split(',').map(|token| token.trim().to_ascii_lowercase()).collect::<HashSet<_>>())
        .unwrap_or_default();
    for name in nominated {
        if !(preserve_upgrade && name == "upgrade") {
            headers.remove(name);
        }
    }
    for name in ["keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding"] {
        headers.remove(name);
    }
    if !preserve_upgrade {
        headers.remove(CONNECTION);
        headers.remove(UPGRADE);
    }
}

/// Appends the real peer to an existing standards-compatible forwarding chain.
fn append_forwarded_for(headers: &mut HeaderMap, peer: IpAddr) {
    let existing = headers.get("x-forwarded-for").and_then(|value| value.to_str().ok()).filter(|value| !value.trim().is_empty());
    let combined = existing.map_or_else(|| peer.to_string(), |value| format!("{value}, {peer}"));
    if let Ok(value) = combined.parse() {
        headers.insert("x-forwarded-for", value);
    }
}

/// Detects a WebSocket or other HTTP/1.1 upgrade without parsing its application protocol.
fn is_upgrade_request(headers: &HeaderMap) -> bool {
    headers
        .get(CONNECTION)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| value.split(',').any(|token| token.trim().eq_ignore_ascii_case("upgrade")))
        && headers.contains_key(UPGRADE)
}

/// Detects the CORS preflight requests Nest's global middleware answered directly.
fn is_cors_preflight(request: &Request<Incoming>) -> bool {
    request.method() == Method::OPTIONS && request.headers().contains_key(ORIGIN) && request.headers().contains_key("access-control-request-method")
}

/// Returns the global CORS preflight response used by the Node service.
fn cors_preflight_response(request: &Request<Incoming>) -> Response<ProxyBody> {
    let mut response = Response::builder().status(StatusCode::NO_CONTENT).body(full_body(Bytes::new())).expect("preflight response");
    apply_cors(response.headers_mut());
    response.headers_mut().insert(ACCESS_CONTROL_ALLOW_METHODS, "GET,HEAD,PUT,PATCH,POST,DELETE".parse().unwrap());
    if let Some(requested) = request.headers().get("access-control-request-headers") {
        response.headers_mut().insert(ACCESS_CONTROL_ALLOW_HEADERS, requested.clone());
    }
    response
}

/// Adds wildcard CORS only when the upstream has not selected its own policy.
fn apply_cors(headers: &mut HeaderMap) {
    if !headers.contains_key(ACCESS_CONTROL_ALLOW_ORIGIN) {
        headers.insert(ACCESS_CONTROL_ALLOW_ORIGIN, "*".parse().unwrap());
    }
}

/// Builds a bounded overload response without waiting behind unbounded upstream work.
fn capacity_response() -> Response<ProxyBody> {
    let mut response =
        json_response(StatusCode::SERVICE_UNAVAILABLE, json!({"error":"Service Unavailable","message":"Proxy capacity reached","requestId":request_id()}));
    response.headers_mut().insert("retry-after", "1".parse().unwrap());
    apply_cors(response.headers_mut());
    response
}

/// Records an upstream failure and builds its public-safe 502 response.
fn upstream_failure(
    state: &AppState, route: &RouteDecision, method: &Method, path: &str, started: Instant, _permit: OwnedSemaphorePermit, message: &str,
) -> Response<ProxyBody> {
    state.metrics.upstream_error(route.class);
    state.metrics.request_finished(route.class, method.as_str(), 502, started.elapsed());
    state.request_log.upstream_error(method.as_str(), path, &route.original_host, route.class.as_str(), message);
    let mut response = json_response(StatusCode::BAD_GATEWAY, json!({"error":"Bad Gateway","message":route.class.failure_message(),"requestId":request_id()}));
    apply_cors(response.headers_mut());
    response
}

/// Records bytes on one request body frame without altering the frame.
fn record_request_frame(frame: Frame<Bytes>, route: RouteClass, metrics: &ProxyMetrics) -> Frame<Bytes> {
    if let Some(data) = frame.data_ref() {
        metrics.request_bytes(route, data.len());
    }
    frame
}

/// Records bytes on one response body frame without altering the frame.
fn record_response_frame(frame: Frame<Bytes>, route: RouteClass, metrics: &ProxyMetrics) -> Frame<Bytes> {
    if let Some(data) = frame.data_ref() {
        metrics.response_bytes(route, data.len());
    }
    frame
}

/// Runs a protocol-transparent tunnel and closes both halves after true bidirectional inactivity.
async fn tunnel_with_idle<A, B>(downstream: A, upstream: B, idle_timeout: Duration, lease: UpgradeLease) -> std::io::Result<()>
where
    A: AsyncRead + AsyncWrite + Unpin,
    B: AsyncRead + AsyncWrite + Unpin,
{
    let (downstream_read, downstream_write) = tokio::io::split(downstream);
    let (upstream_read, upstream_write) = tokio::io::split(upstream);
    let left = copy_direction(downstream_read, upstream_write, &lease);
    let right = copy_direction(upstream_read, downstream_write, &lease);
    tokio::pin!(left, right);
    let mut check = time::interval(Duration::from_secs(1).min(idle_timeout));
    loop {
        tokio::select! {
            result = &mut left => return result.map(|_| ()),
            result = &mut right => return result.map(|_| ()),
            _ = check.tick() => if lease.idle_for() >= idle_timeout { return Err(std::io::Error::new(std::io::ErrorKind::TimedOut, "upgraded tunnel idle timeout")); },
        }
    }
}

/// Copies one tunnel direction and marks activity after each successful write.
async fn copy_direction<R, W>(mut reader: R, mut writer: W, lease: &UpgradeLease) -> std::io::Result<u64>
where
    R: AsyncRead + Unpin,
    W: AsyncWrite + Unpin,
{
    let mut total = 0_u64;
    let mut buffer = vec![0_u8; 32 * 1024];
    loop {
        let count = reader.read(&mut buffer).await?;
        if count == 0 {
            writer.shutdown().await?;
            return Ok(total);
        }
        writer.write_all(&buffer[..count]).await?;
        total += count as u64;
        lease.touch();
    }
}

/// Creates a non-secret correlation identifier for deterministic error bodies.
fn request_id() -> String {
    static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
    let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis();
    format!("{now:x}-{:x}", NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed))
}

struct RequestLease {
    _permit: OwnedSemaphorePermit,
    metrics: ProxyMetrics,
    log: RequestLog,
    route: RouteClass,
    method: String,
    path: String,
    host: String,
    status: u16,
    started: Instant,
}

struct RequestDetails {
    route: RouteClass,
    method: String,
    path: String,
    host: String,
    status: u16,
    started: Instant,
}

impl RequestLease {
    /// Holds capacity and completion accounting for the exact lifetime of a response body.
    fn new(_permit: OwnedSemaphorePermit, metrics: ProxyMetrics, log: RequestLog, details: RequestDetails) -> Self {
        Self {
            _permit,
            metrics,
            log,
            route: details.route,
            method: details.method,
            path: details.path,
            host: details.host,
            status: details.status,
            started: details.started,
        }
    }
}

impl Drop for RequestLease {
    fn drop(&mut self) {
        let elapsed = self.started.elapsed();
        self.metrics.request_finished(self.route, &self.method, self.status, elapsed);
        self.log.completed(&self.method, &self.path, &self.host, self.route.as_str(), self.status, elapsed.as_millis());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn identifies_upgrade_tokens_case_insensitively() {
        let mut headers = HeaderMap::new();
        headers.insert(CONNECTION, "keep-alive, Upgrade".parse().unwrap());
        headers.insert(UPGRADE, "websocket".parse().unwrap());
        assert!(is_upgrade_request(&headers));
    }

    #[test]
    fn removes_connection_nominated_headers() {
        let mut headers = HeaderMap::new();
        headers.insert(CONNECTION, "keep-alive, x-private".parse().unwrap());
        headers.insert("x-private", "secret".parse().unwrap());
        headers.insert("keep-alive", "timeout=5".parse().unwrap());
        remove_hop_by_hop(&mut headers, false);
        assert!(!headers.contains_key(CONNECTION));
        assert!(!headers.contains_key("x-private"));
        assert!(!headers.contains_key("keep-alive"));
    }
}
