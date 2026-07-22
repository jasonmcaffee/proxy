import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { redactSecrets, sanitizeUrl } from './logSanitizer';

/**
 * Volume-controlled, secret-safe request logging for the reverse proxy.
 *
 * task-632: the proxy was emitting 4 lines per request (a request line, a full header dump, a
 * forward line and a response line). One 20 MB log held 50,077 lines for 12,424 requests, of which
 * 99.4% were UI polling GETs (`/ai-api/tts/queue`, `/ai-api/comfy/queue`, `/ai-api/jobs/active`, …),
 * and the header dump alone accounted for 12.1 MB and every leaked session cookie.
 *
 * Policy (default level `quiet`):
 *   - suppress:   successful GET/HEAD reads (the polling noise) — counted into the rollup only
 *   - dedup:      every other outcome is logged ONCE per rollup window per distinct
 *                 method+path+status, so a repeating condition (e.g. a signed-out UI polling and
 *                 getting 401 ten times a second) is visible but can never storm the log again
 *   - rollup:     one summary line per minute with totals and the top repeated conditions
 *   - never log:  headers, cookies, bodies, or unsanitized URLs
 * Set `PROXY_LOG_LEVEL=normal` for one line per request, or `debug` to include the target.
 */
type LogLevel = 'quiet' | 'normal' | 'debug';

/** How often the suppressed-request rollup is emitted, in milliseconds. */
const ROLLUP_INTERVAL_MS = 60_000;

/** How many distinct repeated conditions the rollup line names. */
const ROLLUP_TOP_N = 3;

@Injectable()
export class RequestLoggerService implements OnModuleDestroy {
  private readonly logger = new Logger('Proxy');
  private readonly level: LogLevel = parseLogLevel(process.env.PROXY_LOG_LEVEL);
  private suppressedCount = 0;
  private loggedCount = 0;
  /** Completed responses with a >=400 status. */
  private nonOkCount = 0;
  /** Upstream/middleware failures, which never produced a response status. */
  private upstreamErrorCount = 0;
  /** Distinct method+path+status seen in the current window -> how many times it repeated. */
  private readonly windowCounts = new Map<string, number>();
  private readonly rollupTimer: NodeJS.Timeout;

  constructor() {
    this.rollupTimer = setInterval(() => this.flushRollup(), ROLLUP_INTERVAL_MS);
    this.rollupTimer.unref?.();
    this.logger.log(`request logging level=${this.level} (headers/cookies/bodies are never logged)`);
  }

  onModuleDestroy() {
    clearInterval(this.rollupTimer);
  }

  /**
   * Records a completed proxied request and logs a single sanitized line when policy allows.
   * @param method - HTTP method of the request
   * @param url - raw request URL (sanitized before it is logged)
   * @param host - Host header the request arrived on
   * @param target - short label for where the request was routed
   * @param statusCode - response status returned by the upstream
   * @param startedAt - Date.now() captured when the request arrived
   */
  logCompleted(method: string, url: string, host: string, target: string, statusCode: number, startedAt: number) {
    if (statusCode >= 400) this.nonOkCount++;

    const safeUrl = sanitizeUrl(url);
    const key = `${method} ${safeUrl} ${statusCode}`;
    const repeats = (this.windowCounts.get(key) ?? 0) + 1;
    this.windowCounts.set(key, repeats);

    // Routine successful reads never get their own line; and anything already reported this window
    // is folded into the rollup instead of repeating.
    if (!this.shouldLog(method, statusCode) || repeats > 1) {
      this.suppressedCount++;
      return;
    }

    this.loggedCount++;
    const duration = Date.now() - startedAt;
    const targetPart = this.level === 'debug' ? ` -> ${target}` : '';
    this.write(`${method} ${safeUrl} (${host})${targetPart} ${statusCode} ${duration}ms`);
  }

  /**
   * Logs a proxy/upstream failure. Errors are always logged regardless of level.
   * @param method - HTTP method of the request
   * @param url - raw request URL (sanitized before it is logged)
   * @param host - Host header the request arrived on
   * @param message - the upstream error message
   */
  logError(method: string, url: string, host: string, message: string) {
    this.upstreamErrorCount++;

    // Deduped exactly like completed requests: when the backend goes down, every poller fails at
    // once. The first failure of each distinct route is logged; the rest are counted in the rollup.
    const safeUrl = sanitizeUrl(url);
    const key = `${method} ${safeUrl} ERROR`;
    const repeats = (this.windowCounts.get(key) ?? 0) + 1;
    this.windowCounts.set(key, repeats);
    if (repeats > 1) return;

    this.logger.error(redactSecrets(`${method} ${safeUrl} (${host}) proxy error: ${message}`));
  }

  /**
   * Logs a low-volume informational event (startup, WebSocket upgrade, connection lifecycle).
   * @param message - the message to log
   */
  logInfo(message: string) {
    this.write(message);
  }

  /**
   * Logs a warning.
   * @param message - the message to log
   */
  logWarn(message: string) {
    this.logger.warn(redactSecrets(message));
  }

  /**
   * Decides whether a completed request earns its own log line under the current level.
   * @param method - HTTP method of the request
   * @param statusCode - response status returned by the upstream
   */
  private shouldLog(method: string, statusCode: number): boolean {
    if (this.level !== 'quiet') return true;
    if (statusCode >= 400) return true;
    return !isReadOnly(method);
  }

  /** Emits the periodic summary of requests that were suppressed, then resets the window. */
  private flushRollup() {
    const total = this.suppressedCount + this.loggedCount;
    if (total === 0) {
      this.windowCounts.clear();
      return;
    }

    this.write(
      `last ${ROLLUP_INTERVAL_MS / 1000}s: ${total} requests ` +
      `(${this.nonOkCount} non-ok, ${this.upstreamErrorCount} upstream errors), ` +
      `${this.suppressedCount} not individually logged${formatTopRepeats(this.windowCounts)}`,
    );

    this.suppressedCount = 0;
    this.loggedCount = 0;
    this.nonOkCount = 0;
    this.upstreamErrorCount = 0;
    this.windowCounts.clear();
  }

  /**
   * Writes a log line through the secret scrubber. Every line the proxy emits goes through here.
   * @param message - the composed log line
   */
  private write(message: string) {
    this.logger.log(redactSecrets(message));
  }
}

/**
 * Renders the most-repeated conditions of the window so a storm is still diagnosable from the
 * single rollup line without having logged every occurrence.
 * @param windowCounts - distinct method+path+status to repeat count for the window
 */
function formatTopRepeats(windowCounts: Map<string, number>): string {
  const repeated = [...windowCounts.entries()]
    .filter(([, count]) => count > 1)
    .sort((a, b) => b[1] - a[1])
    .slice(0, ROLLUP_TOP_N);

  if (repeated.length === 0) return '';
  return ` | top: ${repeated.map(([key, count]) => `${key} x${count}`).join(', ')}`;
}

/**
 * Returns true for methods that only read, and are therefore the high-frequency polling traffic
 * we suppress in quiet mode.
 * @param method - HTTP method of the request
 */
function isReadOnly(method: string): boolean {
  const upper = (method || '').toUpperCase();
  return upper === 'GET' || upper === 'HEAD' || upper === 'OPTIONS';
}

/**
 * Parses the PROXY_LOG_LEVEL environment variable, defaulting to the quiet policy.
 * @param value - raw environment variable value
 */
function parseLogLevel(value?: string): LogLevel {
  const normalized = (value || '').trim().toLowerCase();
  return normalized === 'normal' || normalized === 'debug' ? normalized : 'quiet';
}
