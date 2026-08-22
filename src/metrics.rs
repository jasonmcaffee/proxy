use crate::routing::RouteClass;
use prometheus::{Encoder, HistogramOpts, HistogramVec, IntCounter, IntCounterVec, IntGauge, Registry, TextEncoder};
use serde::Serialize;
use std::{
    collections::BTreeMap,
    sync::{
        Arc, Mutex,
        atomic::{AtomicU64, Ordering},
    },
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

/// Prometheus metrics and active-tunnel metadata for one process.
#[derive(Clone)]
pub struct ProxyMetrics {
    inner: Arc<MetricsInner>,
}

struct MetricsInner {
    registry: Registry,
    requests: IntCounterVec,
    request_duration: HistogramVec,
    bytes_in: IntCounterVec,
    bytes_out: IntCounterVec,
    upstream_errors: IntCounterVec,
    active_requests: IntGauge,
    active_upgrades: IntGauge,
    accepted_connections: IntCounter,
    rejected_connections: IntCounter,
    peak_connections: AtomicU64,
    next_tunnel_id: AtomicU64,
    started: Instant,
    tunnels: Mutex<BTreeMap<u64, TunnelRecord>>,
}

struct TunnelRecord {
    route: &'static str,
    started_ms: u64,
    last_activity_ms: Arc<AtomicU64>,
}

/// JSON-compatible process and connection snapshot for loopback diagnostics.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SocketStats {
    pub active_http: i64,
    pub active_upgrades: i64,
    pub accepted_total: u64,
    pub rejected_total: u64,
    pub peak_connections: u64,
    pub uptime_seconds: u64,
    pub oldest: Vec<TunnelStats>,
}

/// One long-lived upgraded tunnel exposed without addresses or request content.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TunnelStats {
    pub route: &'static str,
    pub age_ms: u64,
    pub idle_ms: u64,
}

/// RAII handle that removes an upgraded tunnel from diagnostics on every exit path.
pub struct UpgradeLease {
    metrics: ProxyMetrics,
    id: u64,
    activity: Arc<AtomicU64>,
}

impl ProxyMetrics {
    /// Registers the complete fixed-cardinality metric set.
    pub fn new() -> Result<Self, prometheus::Error> {
        let registry = Registry::new();
        let requests = IntCounterVec::new(prometheus::Opts::new("proxy_requests_total", "Completed proxy requests"), &["route", "method", "status"])?;
        let request_duration = HistogramVec::new(
            HistogramOpts::new("proxy_request_duration_seconds", "Proxy request lifetime")
                .buckets(vec![0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1.0, 5.0, 30.0, 300.0]),
            &["route"],
        )?;
        let bytes_in = IntCounterVec::new(prometheus::Opts::new("proxy_request_bytes_total", "Request body bytes forwarded"), &["route"])?;
        let bytes_out = IntCounterVec::new(prometheus::Opts::new("proxy_response_bytes_total", "Response body bytes forwarded"), &["route"])?;
        let upstream_errors = IntCounterVec::new(prometheus::Opts::new("proxy_upstream_errors_total", "Upstream failures"), &["route"])?;
        let active_requests = IntGauge::new("proxy_active_requests", "Active HTTP exchanges")?;
        let active_upgrades = IntGauge::new("proxy_active_upgrades", "Active upgraded tunnels")?;
        let accepted_connections = IntCounter::new("proxy_accepted_connections_total", "Accepted downstream connections")?;
        let rejected_connections = IntCounter::new("proxy_rejected_connections_total", "Connections rejected by the global cap")?;
        registry.register(Box::new(requests.clone()))?;
        registry.register(Box::new(request_duration.clone()))?;
        registry.register(Box::new(bytes_in.clone()))?;
        registry.register(Box::new(bytes_out.clone()))?;
        registry.register(Box::new(upstream_errors.clone()))?;
        registry.register(Box::new(active_requests.clone()))?;
        registry.register(Box::new(active_upgrades.clone()))?;
        registry.register(Box::new(accepted_connections.clone()))?;
        registry.register(Box::new(rejected_connections.clone()))?;
        Ok(Self {
            inner: Arc::new(MetricsInner {
                registry,
                requests,
                request_duration,
                bytes_in,
                bytes_out,
                upstream_errors,
                active_requests,
                active_upgrades,
                accepted_connections,
                rejected_connections,
                peak_connections: AtomicU64::new(0),
                next_tunnel_id: AtomicU64::new(1),
                started: Instant::now(),
                tunnels: Mutex::new(BTreeMap::new()),
            }),
        })
    }

    /// Records one accepted downstream TCP connection and updates the peak.
    pub fn accepted_connection(&self, current: u64) {
        self.inner.accepted_connections.inc();
        self.inner.peak_connections.fetch_max(current, Ordering::Relaxed);
    }

    /// Records a connection refused because the configured global cap was reached.
    pub fn rejected_connection(&self) {
        self.inner.rejected_connections.inc();
    }

    /// Marks the start of one HTTP exchange.
    pub fn request_started(&self) {
        self.inner.active_requests.inc();
    }

    /// Records request bytes as streaming frames cross toward an upstream.
    pub fn request_bytes(&self, route: RouteClass, bytes: usize) {
        self.inner.bytes_in.with_label_values(&[route.as_str()]).inc_by(bytes as u64);
    }

    /// Records response bytes as streaming frames cross toward a downstream.
    pub fn response_bytes(&self, route: RouteClass, bytes: usize) {
        self.inner.bytes_out.with_label_values(&[route.as_str()]).inc_by(bytes as u64);
    }

    /// Completes one HTTP exchange and records its final dimensions.
    pub fn request_finished(&self, route: RouteClass, method: &str, status: u16, elapsed: Duration) {
        self.inner.active_requests.dec();
        self.inner.requests.with_label_values(&[route.as_str(), method, &status.to_string()]).inc();
        self.inner.request_duration.with_label_values(&[route.as_str()]).observe(elapsed.as_secs_f64());
    }

    /// Records an upstream failure before a response exists.
    pub fn upstream_error(&self, route: RouteClass) {
        self.inner.upstream_errors.with_label_values(&[route.as_str()]).inc();
    }

    /// Starts tracking one upgraded tunnel and returns its activity handle.
    pub fn start_upgrade(&self, route: RouteClass) -> UpgradeLease {
        let id = self.inner.next_tunnel_id.fetch_add(1, Ordering::Relaxed);
        let now = epoch_ms();
        let activity = Arc::new(AtomicU64::new(now));
        if let Ok(mut tunnels) = self.inner.tunnels.lock() {
            tunnels.insert(id, TunnelRecord { route: route.as_str(), started_ms: now, last_activity_ms: activity.clone() });
        }
        self.inner.active_upgrades.inc();
        UpgradeLease { metrics: self.clone(), id, activity }
    }

    /// Returns a loopback-safe snapshot of active work.
    pub fn socket_stats(&self) -> SocketStats {
        let now = epoch_ms();
        let mut oldest = self
            .inner
            .tunnels
            .lock()
            .map(|tunnels| {
                tunnels
                    .values()
                    .map(|record| TunnelStats {
                        route: record.route,
                        age_ms: now.saturating_sub(record.started_ms),
                        idle_ms: now.saturating_sub(record.last_activity_ms.load(Ordering::Relaxed)),
                    })
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        oldest.sort_by_key(|record| std::cmp::Reverse(record.age_ms));
        oldest.truncate(10);
        SocketStats {
            active_http: self.inner.active_requests.get(),
            active_upgrades: self.inner.active_upgrades.get(),
            accepted_total: self.inner.accepted_connections.get(),
            rejected_total: self.inner.rejected_connections.get(),
            peak_connections: self.inner.peak_connections.load(Ordering::Relaxed),
            uptime_seconds: self.inner.started.elapsed().as_secs(),
            oldest,
        }
    }

    /// Encodes the current registry in Prometheus text format.
    pub fn encode(&self) -> Result<Vec<u8>, prometheus::Error> {
        let mut output = Vec::new();
        TextEncoder::new().encode(&self.inner.registry.gather(), &mut output)?;
        Ok(output)
    }

    /// Returns process uptime for health responses.
    pub fn uptime(&self) -> Duration {
        self.inner.started.elapsed()
    }
}

impl UpgradeLease {
    /// Marks activity in either direction of this upgraded tunnel.
    pub fn touch(&self) {
        self.activity.store(epoch_ms(), Ordering::Relaxed);
    }

    /// Returns how long the tunnel has been idle.
    pub fn idle_for(&self) -> Duration {
        Duration::from_millis(epoch_ms().saturating_sub(self.activity.load(Ordering::Relaxed)))
    }
}

impl Drop for UpgradeLease {
    fn drop(&mut self) {
        if let Ok(mut tunnels) = self.metrics.inner.tunnels.lock() {
            tunnels.remove(&self.id);
        }
        self.metrics.inner.active_upgrades.dec();
    }
}

/// Returns a monotonic-enough wall timestamp for cross-task diagnostics.
fn epoch_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as u64
}
