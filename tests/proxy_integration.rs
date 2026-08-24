use bytes::Bytes;
use futures_util::stream;
use http_body_util::{BodyExt, Full, StreamBody, combinators::UnsyncBoxBody};
use hyper::{
    Method, Request, Response, StatusCode,
    body::{Frame, Incoming},
    header::{CONNECTION, CONTENT_RANGE, CONTENT_TYPE, HOST, UPGRADE},
    server::conn::http1,
    service::service_fn,
};
use hyper_util::{
    client::legacy::{Client, connect::HttpConnector},
    rt::{TokioExecutor, TokioIo},
};
use proxy_rs::{Config, build_state, run_with_listener};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    convert::Infallible,
    error::Error,
    net::{Ipv4Addr, SocketAddr},
    time::Duration,
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
    task::JoinHandle,
    time,
};
use url::Url;

type TestError = Box<dyn Error + Send + Sync>;
type TestBody = UnsyncBoxBody<Bytes, TestError>;
type TestClient = Client<HttpConnector, Full<Bytes>>;

struct TestStack {
    proxy_addr: SocketAddr,
    proxy_task: JoinHandle<Result<(), TestError>>,
    upstream_task: JoinHandle<()>,
}

impl Drop for TestStack {
    fn drop(&mut self) {
        self.proxy_task.abort();
        self.upstream_task.abort();
    }
}

/// Starts one fake streaming upstream and a real Rust proxy on ephemeral ports.
async fn start_stack() -> TestStack {
    let upstream = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
    let upstream_addr = upstream.local_addr().unwrap();
    let upstream_task = tokio::spawn(serve_upstream(upstream));
    let proxy = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
    let proxy_addr = proxy.local_addr().unwrap();
    let target = Url::parse(&format!("http://{upstream_addr}")).unwrap();
    let state = build_state(Config::for_tests(proxy_addr, target)).unwrap();
    let proxy_task = tokio::spawn(run_with_listener(proxy, state));
    TestStack { proxy_addr, proxy_task, upstream_task }
}

/// Starts a proxy against an explicitly selected target, including an unavailable port.
async fn start_proxy_for_target(target: Url) -> TestStack {
    let proxy = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
    let proxy_addr = proxy.local_addr().unwrap();
    let state = build_state(Config::for_tests(proxy_addr, target)).unwrap();
    let proxy_task = tokio::spawn(run_with_listener(proxy, state));
    let upstream_task = tokio::spawn(async {});
    TestStack { proxy_addr, proxy_task, upstream_task }
}

/// Starts a proxy in front of an upstream that accepts connections and then answers nothing.
///
/// This is the wedged-Node-process shape that cost 54 GB of kernel nonpaged pool in task-1556, and
/// the shape the socket guard exists to bound. The permit pool is deliberately tiny so a guard that
/// failed to release its permits would be visible as a 503 on the very next request.
async fn start_stack_with_a_wedged_upstream(idle: Duration, sweep: Duration, permits: usize) -> TestStack {
    let upstream = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
    let upstream_addr = upstream.local_addr().unwrap();
    let upstream_task = tokio::spawn(async move {
        let mut wedged = Vec::new();
        while let Ok((stream, _)) = upstream.accept().await {
            wedged.push(stream);
        }
    });
    let proxy = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
    let proxy_addr = proxy.local_addr().unwrap();
    let mut config = Config::for_tests(proxy_addr, Url::parse(&format!("http://{upstream_addr}")).unwrap());
    config.http_idle_timeout = idle;
    config.guard_sweep_interval = sweep;
    config.max_upstream_per_target = permits;
    let state = build_state(config).unwrap();
    let proxy_task = tokio::spawn(run_with_listener(proxy, state));
    TestStack { proxy_addr, proxy_task, upstream_task }
}

/// Accepts fake-upstream connections and gives each an independent HTTP/1 task.
async fn serve_upstream(listener: TcpListener) {
    while let Ok((stream, _)) = listener.accept().await {
        tokio::spawn(async move {
            let service = service_fn(upstream_response);
            let _ = http1::Builder::new().serve_connection(TokioIo::new(stream), service).with_upgrades().await;
        });
    }
}

/// Produces echo, range, SSE, and upgrade responses used by integration tests.
async fn upstream_response(mut request: Request<Incoming>) -> Result<Response<TestBody>, Infallible> {
    if request.uri().path() == "/socket.io/" {
        let upgrade = hyper::upgrade::on(&mut request);
        tokio::spawn(async move {
            if let Ok(upgraded) = upgrade.await {
                let _ = echo_upgraded(TokioIo::new(upgraded)).await;
            }
        });
        return Ok(Response::builder()
            .status(StatusCode::SWITCHING_PROTOCOLS)
            .header(CONNECTION, "Upgrade")
            .header(UPGRADE, "websocket")
            .body(empty_body())
            .unwrap());
    }
    match request.uri().path() {
        "/range" => Ok(Response::builder()
            .status(StatusCode::PARTIAL_CONTENT)
            .header(CONTENT_RANGE, "bytes 2-5/10")
            .header(CONTENT_TYPE, "application/octet-stream")
            .body(full_body("2345"))
            .unwrap()),
        "/sse" => Ok(Response::builder().status(StatusCode::OK).header(CONTENT_TYPE, "text/event-stream").body(sse_body()).unwrap()),
        "/drip" => Ok(Response::builder().status(StatusCode::OK).header(CONTENT_TYPE, "text/event-stream").body(drip_body()).unwrap()),
        _ => Ok(echo_response(request).await),
    }
}

/// Echoes application-visible request properties without exposing unrelated headers.
async fn echo_response(request: Request<Incoming>) -> Response<TestBody> {
    let (parts, body) = request.into_parts();
    let bytes = body.collect().await.unwrap().to_bytes();
    let value = json!({
        "method": parts.method.as_str(),
        "path": parts.uri.path_and_query().map_or("/", |value| value.as_str()),
        "host": header(&parts.headers, "host"),
        "forwardedFor": header(&parts.headers, "x-forwarded-for"),
        "forwardedHost": header(&parts.headers, "x-forwarded-host"),
        "privateHeader": header(&parts.headers, "x-private"),
        "contentType": header(&parts.headers, "content-type"),
        "bodyLength": bytes.len(),
        "bodySha256": format!("{:x}", Sha256::digest(&bytes)),
    });
    Response::builder().status(StatusCode::CREATED).header("x-upstream", "echo").body(full_body(serde_json::to_vec(&value).unwrap())).unwrap()
}

/// Returns one header as printable test text.
fn header(headers: &hyper::HeaderMap, name: &str) -> String {
    headers.get(name).and_then(|value| value.to_str().ok()).unwrap_or_default().to_string()
}

/// Returns an SSE body whose second frame is deliberately delayed.
fn sse_body() -> TestBody {
    let frames = stream::unfold(0_u8, |step| async move {
        match step {
            0 => Some((Ok::<_, TestError>(Frame::data(Bytes::from_static(b"data: one\n\n"))), 1)),
            1 => {
                time::sleep(Duration::from_millis(100)).await;
                Some((Ok(Frame::data(Bytes::from_static(b"data: two\n\n"))), 2))
            }
            _ => None,
        }
    });
    StreamBody::new(frames).boxed_unsync()
}

/// Returns a long-lived stream whose frames are spaced well inside a short idle window.
///
/// Its total lifetime is several times the guard's idle window in the test that uses it, so a guard
/// that reaped on age rather than on activity would cut it off part way through.
fn drip_body() -> TestBody {
    let frames = stream::unfold(0_u8, |step| async move {
        if step >= DRIP_FRAMES {
            return None;
        }
        time::sleep(Duration::from_millis(60)).await;
        Some((Ok::<_, TestError>(Frame::data(Bytes::from_static(b"data: drip\n\n"))), step + 1))
    });
    StreamBody::new(frames).boxed_unsync()
}

/// How many frames the drip stream emits before completing.
const DRIP_FRAMES: u8 = 6;

/// Echoes opaque upgraded bytes until either endpoint closes.
async fn echo_upgraded<T: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin>(mut stream: T) -> std::io::Result<()> {
    let mut buffer = [0_u8; 4096];
    loop {
        let count = stream.read(&mut buffer).await?;
        if count == 0 {
            return Ok(());
        }
        stream.write_all(&buffer[..count]).await?;
    }
}

/// Creates the pooled HTTP client used by black-box proxy tests.
fn client() -> TestClient {
    let mut connector = HttpConnector::new();
    connector.enforce_http(true);
    Client::builder(TokioExecutor::new()).build(connector)
}

/// Sends one body-bearing request through the proxy with an explicit public Host.
async fn send(stack: &TestStack, method: Method, path: &str, host: &str, content_type: Option<&str>, body: Bytes) -> hyper::Response<Incoming> {
    let uri = format!("http://{}{}", stack.proxy_addr, path);
    let mut builder = Request::builder().method(method).uri(uri).header(HOST, host);
    if let Some(value) = content_type {
        builder = builder.header(CONTENT_TYPE, value);
    }
    client().request(builder.body(Full::new(body)).unwrap()).await.unwrap()
}

/// Boxes a fixed fake-upstream body.
fn full_body<T: Into<Bytes>>(value: T) -> TestBody {
    Full::new(value.into()).map_err(|never: Infallible| -> TestError { match never {} }).boxed_unsync()
}

/// Boxes an empty fake-upstream body.
fn empty_body() -> TestBody {
    full_body(Bytes::new())
}

#[tokio::test]
async fn forwards_methods_binary_bodies_and_headers_without_buffer_corruption() {
    let stack = start_stack().await;
    let body = Bytes::from_static(b"\0binary\xffmultipart-boundary");
    let response = send(&stack, Method::POST, "/ai-api/echo?mode=test", "ai.jasonmcaffee.com", Some("multipart/form-data; boundary=x"), body.clone()).await;
    assert_eq!(response.status(), StatusCode::CREATED);
    assert_eq!(header(response.headers(), "access-control-allow-origin"), "*");
    let value: Value = serde_json::from_slice(&response.into_body().collect().await.unwrap().to_bytes()).unwrap();
    assert_eq!(value["method"], "POST");
    assert_eq!(value["path"], "/echo?mode=test");
    assert_eq!(value["forwardedHost"], "ai.jasonmcaffee.com");
    assert_eq!(value["contentType"], "multipart/form-data; boundary=x");
    assert_eq!(value["bodyLength"], body.len());
    assert_eq!(value["bodySha256"], format!("{:x}", Sha256::digest(&body)));
}

#[tokio::test]
async fn applies_media_and_news_rewrites_on_segment_boundaries() {
    let stack = start_stack().await;
    let cases = [
        ("media.jasonmcaffee.com", "/m/a.mp4?download=1", "/public/a.mp4?download=1"),
        ("media.jasonmcaffee.com", "/s/token.jpg", "/social/public-media/token.jpg"),
        ("unrelated.example", "/news/2026-08-21", "/news/2026-08-21"),
        ("media.jasonmcaffee.com", "/mismatch", "/mismatch"),
    ];
    for (host, path, expected) in cases {
        let response = send(&stack, Method::GET, path, host, None, Bytes::new()).await;
        let value: Value = serde_json::from_slice(&response.into_body().collect().await.unwrap().to_bytes()).unwrap();
        assert_eq!(value["path"], expected, "{host}{path}");
    }
}

#[tokio::test]
async fn preserves_range_status_headers_and_body() {
    let stack = start_stack().await;
    let response = send(&stack, Method::GET, "/range", "jasonmcaffee.com", None, Bytes::new()).await;
    assert_eq!(response.status(), StatusCode::PARTIAL_CONTENT);
    assert_eq!(header(response.headers(), "content-range"), "bytes 2-5/10");
    assert_eq!(response.into_body().collect().await.unwrap().to_bytes(), "2345");
}

#[tokio::test]
async fn streams_sse_frames_before_the_response_completes() {
    let stack = start_stack().await;
    let response = send(&stack, Method::GET, "/sse", "ai.jasonmcaffee.com", None, Bytes::new()).await;
    assert_eq!(header(response.headers(), "content-type"), "text/event-stream");
    let mut body = response.into_body();
    let first = time::timeout(Duration::from_millis(50), body.frame()).await.unwrap().unwrap().unwrap().into_data().unwrap();
    assert_eq!(first, "data: one\n\n");
    let second = time::timeout(Duration::from_millis(250), body.frame()).await.unwrap().unwrap().unwrap().into_data().unwrap();
    assert_eq!(second, "data: two\n\n");
}

#[tokio::test]
async fn exposes_health_metrics_and_socket_stats_to_loopback() {
    let stack = start_stack().await;
    for path in ["/__proxy/health", "/__proxy/ready", "/__proxy/socket-stats", "/__proxy/metrics"] {
        let response = send(&stack, Method::GET, path, "jasonmcaffee.com", None, Bytes::new()).await;
        assert_eq!(response.status(), StatusCode::OK, "{path}");
        assert!(!response.into_body().collect().await.unwrap().to_bytes().is_empty(), "{path}");
    }
}

#[tokio::test]
async fn answers_cors_preflight_without_contacting_an_upstream() {
    let closed = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
    let closed_addr = closed.local_addr().unwrap();
    drop(closed);
    let stack = start_proxy_for_target(Url::parse(&format!("http://{closed_addr}")).unwrap()).await;
    let request = Request::builder()
        .method(Method::OPTIONS)
        .uri(format!("http://{}/anything", stack.proxy_addr))
        .header(HOST, "ai.jasonmcaffee.com")
        .header("origin", "https://example.com")
        .header("access-control-request-method", "POST")
        .header("access-control-request-headers", "content-type,x-test")
        .body(Full::new(Bytes::new()))
        .unwrap();
    let response = client().request(request).await.unwrap();
    assert_eq!(response.status(), StatusCode::NO_CONTENT);
    assert_eq!(header(response.headers(), "access-control-allow-origin"), "*");
    assert_eq!(header(response.headers(), "access-control-allow-headers"), "content-type,x-test");
}

#[tokio::test]
async fn returns_a_safe_cors_enabled_502_for_an_unavailable_upstream() {
    let closed = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
    let closed_addr = closed.local_addr().unwrap();
    drop(closed);
    let stack = start_proxy_for_target(Url::parse(&format!("http://{closed_addr}")).unwrap()).await;
    let response = send(&stack, Method::GET, "/", "ai.jasonmcaffee.com", None, Bytes::new()).await;
    assert_eq!(response.status(), StatusCode::BAD_GATEWAY);
    assert_eq!(header(response.headers(), "access-control-allow-origin"), "*");
    let body = String::from_utf8(response.into_body().collect().await.unwrap().to_bytes().to_vec()).unwrap();
    assert!(body.contains("Unable to proxy request to backend service"));
    assert!(!body.contains(&closed_addr.to_string()));
}

#[tokio::test]
async fn strips_connection_nominated_headers_before_the_upstream() {
    let stack = start_stack().await;
    let request = Request::builder()
        .method(Method::GET)
        .uri(format!("http://{}/echo", stack.proxy_addr))
        .header(HOST, "jasonmcaffee.com")
        .header(CONNECTION, "keep-alive, x-private")
        .header("x-private", "must-not-cross")
        .body(Full::new(Bytes::new()))
        .unwrap();
    let response = client().request(request).await.unwrap();
    let body = response.into_body().collect().await.unwrap().to_bytes();
    let value: Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(value["privateHeader"], "");
}

#[tokio::test]
async fn tunnels_ai_api_websocket_bytes_bidirectionally() {
    let stack = start_stack().await;
    let mut socket = TcpStream::connect(stack.proxy_addr).await.unwrap();
    socket.write_all(b"GET /ai-api/socket.io/?EIO=4&transport=websocket HTTP/1.1\r\nHost: ai.jasonmcaffee.com\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n").await.unwrap();
    let headers = read_headers(&mut socket).await;
    assert!(headers.starts_with("HTTP/1.1 101"), "{headers}");
    socket.write_all(b"opaque-socket-io-frame").await.unwrap();
    let mut echoed = vec![0_u8; 22];
    time::timeout(Duration::from_secs(1), socket.read_exact(&mut echoed)).await.unwrap().unwrap();
    assert_eq!(echoed, b"opaque-socket-io-frame");
}

/// Reads one HTTP response head without consuming tunneled bytes after the delimiter.
async fn read_headers(stream: &mut TcpStream) -> String {
    let mut bytes = Vec::new();
    let mut byte = [0_u8; 1];
    while bytes.len() < 8192 {
        stream.read_exact(&mut byte).await.unwrap();
        bytes.push(byte[0]);
        if bytes.ends_with(b"\r\n\r\n") {
            break;
        }
    }
    String::from_utf8(bytes).unwrap()
}

#[tokio::test]
async fn replaces_a_caller_supplied_forwarded_for_chain_instead_of_appending_to_it() {
    let stack = start_stack().await;
    let request = Request::builder()
        .method(Method::GET)
        .uri(format!("http://{}/ai-api/echo", stack.proxy_addr))
        .header(HOST, "ai.jasonmcaffee.com")
        .header("x-forwarded-for", "9.9.9.9")
        .header("x-forwarded-host", "evil.example")
        .body(Full::new(Bytes::new()))
        .unwrap();
    let response = client().request(request).await.unwrap();
    let value: Value = serde_json::from_slice(&response.into_body().collect().await.unwrap().to_bytes()).unwrap();
    // The AI backend keys its login throttle on the FIRST entry of this header, so a caller must
    // never be able to put a value there (task-696 H2, re-opened by the rewrite, closed again here).
    assert_eq!(value["forwardedFor"], "127.0.0.1");
    assert_eq!(value["forwardedHost"], "ai.jasonmcaffee.com");
}

#[tokio::test]
async fn reaps_exchanges_against_a_wedged_upstream_and_returns_their_permits() {
    let stack = start_stack_with_a_wedged_upstream(Duration::from_millis(200), Duration::from_millis(50), 2).await;
    for round in 0..2 {
        let first = send(&stack, Method::GET, "/ai-api/wedged", "ai.jasonmcaffee.com", None, Bytes::new());
        let second = send(&stack, Method::GET, "/ai-api/wedged", "ai.jasonmcaffee.com", None, Bytes::new());
        let (first, second) = tokio::join!(first, second);
        // Every round must be reaped on its own merits; a leaked permit would surface as a 503.
        assert_eq!(first.status(), StatusCode::GATEWAY_TIMEOUT, "round {round}");
        assert_eq!(second.status(), StatusCode::GATEWAY_TIMEOUT, "round {round}");
        let body = String::from_utf8(first.into_body().collect().await.unwrap().to_bytes().to_vec()).unwrap();
        assert!(body.contains("Unable to reach AI service backend"), "round {round}: {body}");
        assert!(body.contains("timestamp"), "round {round}: the pre-rewrite error contract carries a timestamp");
    }
}

#[tokio::test]
async fn reports_guard_reap_counters_on_socket_stats() {
    let stack = start_stack_with_a_wedged_upstream(Duration::from_millis(200), Duration::from_millis(50), 4).await;
    assert_eq!(send(&stack, Method::GET, "/ai-api/wedged", "ai.jasonmcaffee.com", None, Bytes::new()).await.status(), StatusCode::GATEWAY_TIMEOUT);
    let response = send(&stack, Method::GET, "/__proxy/socket-stats", "jasonmcaffee.com", None, Bytes::new()).await;
    let stats: Value = serde_json::from_slice(&response.into_body().collect().await.unwrap().to_bytes()).unwrap();
    // The AI service's kernel-pool watchdog tells an operator to read exactly these fields.
    assert_eq!(stats["reapedIdle"], 1);
    assert_eq!(stats["reapedStalled"], 0);
    assert_eq!(stats["trackedNow"], 0);
    assert!(stats["trackedTotal"].as_u64().unwrap() >= 1);
    assert!(stats["config"]["idleTimeoutMs"].as_u64().unwrap() > 0);
}

#[tokio::test]
async fn never_reaps_a_stream_that_is_still_producing_frames() {
    let upstream = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
    let upstream_addr = upstream.local_addr().unwrap();
    let upstream_task = tokio::spawn(serve_upstream(upstream));
    let proxy = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
    let proxy_addr = proxy.local_addr().unwrap();
    let mut config = Config::for_tests(proxy_addr, Url::parse(&format!("http://{upstream_addr}")).unwrap());
    // The drip stream runs about 360ms in total, so an age-based reaper would cut it off; frames
    // arrive every 60ms, so an activity-based one must leave it entirely alone.
    config.http_idle_timeout = Duration::from_millis(150);
    config.guard_sweep_interval = Duration::from_millis(25);
    let state = build_state(config).unwrap();
    let proxy_task = tokio::spawn(run_with_listener(proxy, state));
    let stack = TestStack { proxy_addr, proxy_task, upstream_task };

    let response = send(&stack, Method::GET, "/drip", "ai.jasonmcaffee.com", None, Bytes::new()).await;
    assert_eq!(response.status(), StatusCode::OK);
    let mut body = response.into_body();
    let mut frames = 0_u8;
    while let Some(frame) = body.frame().await {
        assert_eq!(frame.unwrap().into_data().unwrap(), "data: drip\n\n");
        frames += 1;
    }
    assert_eq!(frames, DRIP_FRAMES, "an active stream must survive an idle window shorter than its lifetime");
}
