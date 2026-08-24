use regex::Regex;
use std::{
    collections::HashMap,
    sync::{
        Arc, Mutex, OnceLock,
        atomic::{AtomicU64, Ordering},
    },
    time::Duration,
};
use tokio::time;
use tracing::{error, info, warn};

const MAX_URL_LENGTH: usize = 200;
const ROLLUP_INTERVAL: Duration = Duration::from_secs(60);
const SENSITIVE_QUERY_KEYS: &[&str] = &[
    "token",
    "access_token",
    "refresh_token",
    "id_token",
    "jwt",
    "auth",
    "authorization",
    "api_key",
    "apikey",
    "key",
    "secret",
    "client_secret",
    "password",
    "pass",
    "pwd",
    "sig",
    "signature",
    "code",
    "session",
    "sid",
    "x-skip-token",
    "skiptoken",
    "prompt",
    "imageurl",
    "image_url",
    "q",
    "query",
    "text",
];

/// Counts suppressed request logs and emits bounded periodic summaries.
#[derive(Clone)]
pub struct RequestLog {
    inner: Arc<RequestLogInner>,
}

struct RequestLogInner {
    level: LogLevel,
    total: AtomicU64,
    suppressed: AtomicU64,
    non_ok: AtomicU64,
    upstream_errors: AtomicU64,
    /// Distinct method+path+status seen this window, and how many times each repeated.
    seen: Mutex<HashMap<String, u64>>,
}

/// How many distinct repeated conditions the rollup line names, so a storm stays diagnosable.
const ROLLUP_TOP_N: usize = 3;

#[derive(Clone, Copy, Eq, PartialEq)]
enum LogLevel {
    Quiet,
    Normal,
    Debug,
}

impl RequestLog {
    /// Creates the request logger and its once-per-minute rollup task.
    pub fn new() -> Self {
        let logger = Self {
            inner: Arc::new(RequestLogInner {
                level: parse_level(std::env::var("PROXY_LOG_LEVEL").ok().as_deref()),
                total: AtomicU64::new(0),
                suppressed: AtomicU64::new(0),
                non_ok: AtomicU64::new(0),
                upstream_errors: AtomicU64::new(0),
                seen: Mutex::new(HashMap::new()),
            }),
        };
        logger.spawn_rollup();
        logger
    }

    /// Records a completed response without retaining raw request data.
    pub fn completed(&self, method: &str, url: &str, host: &str, route: &str, status: u16, duration_ms: u128) {
        self.inner.total.fetch_add(1, Ordering::Relaxed);
        if status >= 400 {
            self.inner.non_ok.fetch_add(1, Ordering::Relaxed);
        }
        let safe_url = sanitize_url(url);
        let key = format!("{method} {safe_url} {status}");
        let first = self.record_occurrence(key);
        if !should_log(self.inner.level, method, status) || !first {
            self.inner.suppressed.fetch_add(1, Ordering::Relaxed);
            return;
        }
        info!(method, url = %safe_url, host, route, status, duration_ms = duration_ms as u64, "proxied request");
    }

    /// Records one upstream failure with URL and error text scrubbed.
    pub fn upstream_error(&self, method: &str, url: &str, host: &str, route: &str, message: &str) {
        self.inner.total.fetch_add(1, Ordering::Relaxed);
        self.inner.non_ok.fetch_add(1, Ordering::Relaxed);
        self.inner.upstream_errors.fetch_add(1, Ordering::Relaxed);
        let safe_url = sanitize_url(url);
        let key = format!("{method} {safe_url} ERROR");
        let first = self.record_occurrence(key);
        if first {
            error!(method, url = %safe_url, host, route, error = %redact_secrets(message), "upstream proxy error");
        }
    }

    /// Counts one occurrence of a distinct condition, reporting whether this was its first.
    fn record_occurrence(&self, key: String) -> bool {
        self.inner
            .seen
            .lock()
            .map(|mut seen| {
                let count = seen.entry(key).or_insert(0);
                *count += 1;
                *count == 1
            })
            .unwrap_or(false)
    }

    /// Emits a low-volume lifecycle message.
    pub fn lifecycle(&self, message: &str) {
        info!(message = %redact_secrets(message), "proxy lifecycle");
    }

    /// Emits a sanitized warning.
    pub fn warning(&self, message: &str) {
        warn!(message = %redact_secrets(message), "proxy warning");
    }

    /// Starts the single shared task that emits and resets rollup counters.
    fn spawn_rollup(&self) {
        let inner = self.inner.clone();
        tokio::spawn(async move {
            let mut interval = time::interval(ROLLUP_INTERVAL);
            interval.tick().await;
            loop {
                interval.tick().await;
                let total = inner.total.swap(0, Ordering::Relaxed);
                let suppressed = inner.suppressed.swap(0, Ordering::Relaxed);
                let non_ok = inner.non_ok.swap(0, Ordering::Relaxed);
                let upstream_errors = inner.upstream_errors.swap(0, Ordering::Relaxed);
                let top = inner
                    .seen
                    .lock()
                    .map(|mut seen| {
                        let rendered = format_top_repeats(&seen);
                        seen.clear();
                        rendered
                    })
                    .unwrap_or_default();
                if total > 0 {
                    info!(total, non_ok, upstream_errors, suppressed, top = %top, "request rollup for last 60s");
                }
            }
        });
    }
}

impl Default for RequestLog {
    fn default() -> Self {
        Self::new()
    }
}

/// Removes sensitive query values and bounds a URL before storage or output.
pub fn sanitize_url(url: &str) -> String {
    let (path, query) = match url.split_once('?') {
        Some(parts) => parts,
        None => return truncate(url),
    };
    let pairs = query
        .split('&')
        .map(|pair| {
            let (key, value) = pair.split_once('=').map_or((pair, None), |(key, value)| (key, Some(value)));
            match value {
                Some(_) if SENSITIVE_QUERY_KEYS.iter().any(|sensitive| key.eq_ignore_ascii_case(sensitive)) => {
                    format!("{key}=***")
                }
                Some(value) => format!("{key}={value}"),
                None => key.to_string(),
            }
        })
        .collect::<Vec<_>>()
        .join("&");
    truncate(&format!("{path}?{pairs}"))
}

/// Scrubs credential-shaped text as a defense in depth for every log message.
pub fn redact_secrets(message: &str) -> String {
    secret_patterns().iter().fold(message.to_string(), |text, (pattern, replacement)| pattern.replace_all(&text, *replacement).to_string())
}

/// Compiles the bounded set of secret patterns once per process.
fn secret_patterns() -> &'static Vec<(Regex, &'static str)> {
    static PATTERNS: OnceLock<Vec<(Regex, &'static str)>> = OnceLock::new();
    PATTERNS.get_or_init(|| {
        vec![
            (Regex::new(r"\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]+").unwrap(), "<jwt-redacted>"),
            (Regex::new(r#"(?i)\b(ai_studio_jwt|connect\.sid|session)=[^;\s"']+"#).unwrap(), "$1=<redacted>"),
            (Regex::new(r"(?i)\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}").unwrap(), "$1 <redacted>"),
            (Regex::new(r#"(?i)\b(api[_-]?key|token|secret|password)[\"'\s:=]+[A-Za-z0-9._~+/=-]{8,}"#).unwrap(), "$1=<redacted>"),
            (Regex::new(r"(?i)data:[a-z]+/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=]+").unwrap(), "<data-uri-redacted>"),
        ]
    })
}

/// Renders the most-repeated conditions of the window, so a storm is diagnosable from the single
/// rollup line without having logged every occurrence of it.
fn format_top_repeats(seen: &HashMap<String, u64>) -> String {
    let mut repeated = seen.iter().filter(|(_, count)| **count > 1).collect::<Vec<_>>();
    repeated.sort_by(|left, right| right.1.cmp(left.1).then_with(|| left.0.cmp(right.0)));
    repeated.truncate(ROLLUP_TOP_N);
    repeated.iter().map(|(key, count)| format!("{key} x{count}")).collect::<Vec<_>>().join(", ")
}

/// Caps sanitized URL text to keep logs and aggregation keys bounded.
fn truncate(value: &str) -> String {
    if value.chars().count() <= MAX_URL_LENGTH {
        return value.to_string();
    }
    format!("{}...(truncated)", value.chars().take(MAX_URL_LENGTH).collect::<String>())
}

/// Applies the configured logging policy to one completed request.
fn should_log(level: LogLevel, method: &str, status: u16) -> bool {
    level != LogLevel::Quiet || status >= 400 || !matches!(method, "GET" | "HEAD" | "OPTIONS")
}

/// Parses the three supported logging levels.
fn parse_level(value: Option<&str>) -> LogLevel {
    match value.unwrap_or_default().trim().to_ascii_lowercase().as_str() {
        "normal" => LogLevel::Normal,
        "debug" => LogLevel::Debug,
        _ => LogLevel::Quiet,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitizes_sensitive_queries_without_changing_safe_values() {
        assert_eq!(sanitize_url("/x?token=secret&mode=fast&prompt=hello"), "/x?token=***&mode=fast&prompt=***");
    }

    #[test]
    fn redacts_tokens_cookies_and_data_uris() {
        let input = "bearer abcdefghijk ai_studio_jwt=secretvalue data:image/png;base64,AAAAAA==";
        let output = redact_secrets(input);
        assert!(!output.contains("abcdefghijk"));
        assert!(!output.contains("secretvalue"));
        assert!(!output.contains("AAAAAA"));
    }

    #[test]
    fn truncates_long_urls() {
        assert!(sanitize_url(&format!("/{}", "a".repeat(300))).ends_with("...(truncated)"));
    }
}
