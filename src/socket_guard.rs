use serde::Serialize;
use std::{
    collections::BTreeMap,
    sync::{
        Arc, Mutex,
        atomic::{AtomicU64, Ordering},
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tokio::{sync::oneshot, time};

/// Bounds every proxied HTTP exchange in time, so a wedged upstream can never pin one forever
/// (task-1556, ported to Rust by task-1637).
///
/// The Node proxy this replaced ran three independent mechanisms. Two of them survived the rewrite
/// on their own: TCP keepalive is applied to both halves by `server::configure_stream` and the
/// upstream connector, and upgraded tunnels are bounded by `proxy::tunnel_with_idle`. The third — a
/// shared sweep that reaped **plain HTTP** pairs which had stopped moving bytes — was not ported,
/// and without it a request to an upstream that accepts the connection and then answers nothing
/// stays in flight for the life of the process. Measured on task-1637: four such requests against a
/// deliberately wedged upstream permanently consumed that target's concurrency permits, and every
/// later request to the same upstream answered 503 until the proxy was restarted.
///
/// Only the idle reaper is ported. The Node guard's second reaper keyed on "one half is holding
/// buffered data the other half is not draining", read from `socket.writableLength` — a userland
/// write queue that exists because Node's stream layer accepts writes faster than the peer drains
/// them. Hyper has no such queue: a response body is polled only when the downstream connection can
/// take it, so the condition that reaper detected cannot arise here. Inventing a shorter "the
/// upstream has not answered yet" timer in its place would be a different rule with a different
/// victim — a genuinely slow backend call — so it is deliberately not done.
#[derive(Clone)]
pub struct SocketGuard {
    inner: Arc<GuardInner>,
}

struct GuardInner {
    config: GuardConfig,
    tracked: Mutex<BTreeMap<u64, Tracked>>,
    next_id: AtomicU64,
    tracked_total: AtomicU64,
    peak_tracked: AtomicU64,
    reaped_idle: AtomicU64,
    reaped_stalled: AtomicU64,
}

/// One in-flight exchange while the guard is watching it.
struct Tracked {
    label: String,
    started_ms: u64,
    last_activity_ms: Arc<AtomicU64>,
    cancel: Option<oneshot::Sender<()>>,
}

/// Guard tunables, read from the same environment variables the Node guard used.
#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GuardConfig {
    pub keep_alive_ms: u64,
    pub idle_timeout_ms: u64,
    pub sweep_interval_ms: u64,
}

/// Loopback-only snapshot of what the guard is currently watching.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GuardSnapshot {
    pub config: GuardConfig,
    pub tracked_now: usize,
    pub tracked_total: u64,
    pub peak_tracked: u64,
    pub reaped_idle: u64,
    pub reaped_stalled: u64,
    pub oldest: Vec<TrackedSnapshot>,
}

/// One watched exchange, described without addresses, headers, or request content.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrackedSnapshot {
    pub label: String,
    pub age_ms: u64,
    pub idle_ms: u64,
}

/// Keeps one exchange registered for exactly as long as it is in flight.
pub struct GuardHandle {
    guard: SocketGuard,
    id: u64,
    activity: Arc<AtomicU64>,
}

impl SocketGuard {
    /// Creates a guard and starts its single shared sweep task.
    pub fn new(config: GuardConfig) -> Self {
        let guard = Self {
            inner: Arc::new(GuardInner {
                config,
                tracked: Mutex::new(BTreeMap::new()),
                next_id: AtomicU64::new(1),
                tracked_total: AtomicU64::new(0),
                peak_tracked: AtomicU64::new(0),
                reaped_idle: AtomicU64::new(0),
                reaped_stalled: AtomicU64::new(0),
            }),
        };
        guard.spawn_sweep();
        guard
    }

    /// Starts watching one exchange, returning its activity handle and its cancellation channel.
    pub fn track(&self, label: String) -> (GuardHandle, oneshot::Receiver<()>) {
        let id = self.inner.next_id.fetch_add(1, Ordering::Relaxed);
        let now = epoch_ms();
        let activity = Arc::new(AtomicU64::new(now));
        let (cancel, cancelled) = oneshot::channel();
        if let Ok(mut tracked) = self.inner.tracked.lock() {
            tracked.insert(id, Tracked { label, started_ms: now, last_activity_ms: activity.clone(), cancel: Some(cancel) });
            self.inner.peak_tracked.fetch_max(tracked.len() as u64, Ordering::Relaxed);
        }
        self.inner.tracked_total.fetch_add(1, Ordering::Relaxed);
        (GuardHandle { guard: self.clone(), id, activity }, cancelled)
    }

    /// Returns the guard tuning, so diagnostics can show what the reaper is actually enforcing.
    pub fn config(&self) -> GuardConfig {
        self.inner.config
    }

    /// Returns what the guard is watching now, oldest exchange first.
    pub fn snapshot(&self, limit: usize) -> GuardSnapshot {
        let now = epoch_ms();
        let (tracked_now, mut oldest) = self
            .inner
            .tracked
            .lock()
            .map(|tracked| {
                let rows = tracked
                    .values()
                    .map(|entry| TrackedSnapshot {
                        label: entry.label.clone(),
                        age_ms: now.saturating_sub(entry.started_ms),
                        idle_ms: now.saturating_sub(entry.last_activity_ms.load(Ordering::Relaxed)),
                    })
                    .collect::<Vec<_>>();
                (tracked.len(), rows)
            })
            .unwrap_or((0, Vec::new()));
        oldest.sort_by_key(|row| std::cmp::Reverse(row.age_ms));
        oldest.truncate(limit);
        GuardSnapshot {
            config: self.inner.config,
            tracked_now,
            tracked_total: self.inner.tracked_total.load(Ordering::Relaxed),
            peak_tracked: self.inner.peak_tracked.load(Ordering::Relaxed),
            reaped_idle: self.inner.reaped_idle.load(Ordering::Relaxed),
            reaped_stalled: self.inner.reaped_stalled.load(Ordering::Relaxed),
            oldest,
        }
    }

    /// Stops watching one exchange, which happens on every completion and failure path.
    fn release(&self, id: u64) {
        if let Ok(mut tracked) = self.inner.tracked.lock() {
            tracked.remove(&id);
        }
    }

    /// Cancels every exchange that has moved no bytes for longer than the idle window.
    ///
    /// Runs on one shared timer rather than a timer per request, so thousands of live streams cost
    /// a single wakeup. Returns the labels it reaped so a sweep can be asserted in tests.
    pub fn sweep_once(&self) -> Vec<String> {
        let idle_timeout = self.inner.config.idle_timeout_ms;
        if idle_timeout == 0 {
            return Vec::new();
        }
        let now = epoch_ms();
        let mut reaped = Vec::new();
        if let Ok(mut tracked) = self.inner.tracked.lock() {
            let expired = tracked
                .iter()
                .filter(|(_, entry)| now.saturating_sub(entry.last_activity_ms.load(Ordering::Relaxed)) >= idle_timeout)
                .map(|(id, _)| *id)
                .collect::<Vec<_>>();
            for id in expired {
                if let Some(mut entry) = tracked.remove(&id) {
                    let idle_seconds = now.saturating_sub(entry.last_activity_ms.load(Ordering::Relaxed)) / 1_000;
                    let age_seconds = now.saturating_sub(entry.started_ms) / 1_000;
                    tracing::warn!(label = %entry.label, age_s = age_seconds, idle_s = idle_seconds, "reaped idle proxied exchange");
                    if let Some(cancel) = entry.cancel.take() {
                        let _ = cancel.send(());
                    }
                    self.inner.reaped_idle.fetch_add(1, Ordering::Relaxed);
                    reaped.push(entry.label);
                }
            }
        }
        reaped
    }

    /// Starts the single shared task that sweeps every tracked exchange.
    fn spawn_sweep(&self) {
        let interval_ms = self.inner.config.sweep_interval_ms.max(1);
        let guard = self.clone();
        tokio::spawn(async move {
            let mut ticker = time::interval(Duration::from_millis(interval_ms));
            ticker.tick().await;
            loop {
                ticker.tick().await;
                guard.sweep_once();
            }
        });
    }
}

/// A cloneable activity marker for an exchange whose two directions are driven by separate tasks.
#[derive(Clone)]
pub struct ActivityMark(Arc<AtomicU64>);

impl GuardHandle {
    /// Records that bytes crossed this exchange, which is the definition of "still doing work".
    pub fn touch(&self) {
        self.activity.store(epoch_ms(), Ordering::Relaxed);
    }

    /// Returns a marker the request-body direction can hold independently of the response body.
    pub fn activity(&self) -> ActivityMark {
        ActivityMark(self.activity.clone())
    }
}

impl ActivityMark {
    /// Records that bytes crossed this exchange in the direction this marker watches.
    pub fn touch(&self) {
        self.0.store(epoch_ms(), Ordering::Relaxed);
    }
}

impl Drop for GuardHandle {
    fn drop(&mut self) {
        self.guard.release(self.id);
    }
}

/// Returns a wall timestamp shared by the sweep and every activity marker.
fn epoch_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as u64
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn a_disabled_idle_window_never_reaps() {
        let guard = SocketGuard::new(GuardConfig { keep_alive_ms: 1_000, idle_timeout_ms: 0, sweep_interval_ms: 3_600_000 });
        let (_handle, _cancelled) = guard.track("http test".to_string());
        assert!(guard.sweep_once().is_empty());
    }

    #[tokio::test]
    async fn reaps_an_exchange_that_stopped_moving_and_cancels_it() {
        let guard = SocketGuard::new(GuardConfig { keep_alive_ms: 1_000, idle_timeout_ms: 1, sweep_interval_ms: 3_600_000 });
        let (handle, cancelled) = guard.track("http ai-api".to_string());
        tokio::time::sleep(Duration::from_millis(15)).await;
        assert_eq!(guard.sweep_once(), vec!["http ai-api".to_string()]);
        assert!(cancelled.await.is_ok(), "a reaped exchange must be cancelled, not merely forgotten");
        assert_eq!(guard.snapshot(10).reaped_idle, 1);
        drop(handle);
        assert_eq!(guard.snapshot(10).tracked_now, 0);
    }

    #[tokio::test]
    async fn an_exchange_that_keeps_moving_is_never_reaped() {
        let guard = SocketGuard::new(GuardConfig { keep_alive_ms: 1_000, idle_timeout_ms: 50, sweep_interval_ms: 3_600_000 });
        let (handle, _cancelled) = guard.track("http media-asset".to_string());
        for _ in 0..5 {
            tokio::time::sleep(Duration::from_millis(20)).await;
            handle.touch();
            assert!(guard.sweep_once().is_empty());
        }
        assert_eq!(guard.snapshot(10).tracked_now, 1);
    }

    #[tokio::test]
    async fn releases_its_registry_slot_when_the_handle_drops() {
        let guard = SocketGuard::new(GuardConfig { keep_alive_ms: 1_000, idle_timeout_ms: 900_000, sweep_interval_ms: 3_600_000 });
        {
            let (_handle, _cancelled) = guard.track("http git".to_string());
            assert_eq!(guard.snapshot(10).tracked_now, 1);
        }
        let snapshot = guard.snapshot(10);
        assert_eq!(snapshot.tracked_now, 0);
        assert_eq!(snapshot.tracked_total, 1);
        assert_eq!(snapshot.peak_tracked, 1);
    }
}
