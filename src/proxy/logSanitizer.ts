/**
 * Log sanitization helpers for the reverse proxy.
 *
 * task-632: this proxy previously logged `JSON.stringify(req.headers)` on every request, which wrote
 * the live `ai_studio_jwt` session cookie to the Service Manager's plaintext log on the C: SSD
 * (10,390 occurrences / 2 distinct live tokens in a single 20 MB log). A session cookie is a
 * credential: anyone who can read the log can replay it and decrypt everything the encryption work
 * in task-607/628 protects at rest. So nothing that could carry a secret may ever reach a log line.
 *
 * The rule enforced here: headers and bodies are NEVER logged, URLs are always sanitized, and every
 * emitted line is passed through a final regex scrub as a backstop against future regressions.
 */

/** Query-string parameters whose values are secrets or user content and must never be logged. */
const SENSITIVE_QUERY_PARAMS = new Set([
  'token', 'access_token', 'refresh_token', 'id_token', 'jwt', 'auth', 'authorization',
  'api_key', 'apikey', 'key', 'secret', 'client_secret', 'password', 'pass', 'pwd',
  'sig', 'signature', 'code', 'session', 'sid', 'x-skip-token', 'skiptoken',
  // user content — not credentials, but prompts/images must not land on disk either
  'prompt', 'imageurl', 'image_url', 'q', 'query', 'text',
]);

/** Longest URL we will put in a log line; longer ones are truncated (blocks base64 data-URI spill). */
const MAX_URL_LENGTH = 200;

/**
 * Removes the values of sensitive query parameters from a URL and caps its length.
 * Falls back to the path portion alone if the URL cannot be parsed.
 * @param url - the raw request URL (path + optional query string)
 */
export function sanitizeUrl(url: string): string {
  if (!url) return '';
  const [path, queryString] = splitOnce(url, '?');
  if (!queryString) return truncate(path, MAX_URL_LENGTH);

  const sanitizedPairs = queryString.split('&').map((pair) => {
    const [rawKey, rawValue] = splitOnce(pair, '=');
    if (rawValue === undefined) return rawKey;
    return SENSITIVE_QUERY_PARAMS.has(rawKey.toLowerCase()) ? `${rawKey}=***` : `${rawKey}=${rawValue}`;
  });

  return truncate(`${path}?${sanitizedPairs.join('&')}`, MAX_URL_LENGTH);
}

/** Patterns for credential-shaped substrings that must be scrubbed from any log line. */
const SECRET_PATTERNS: Array<{ pattern: RegExp; replacement: string }> = [
  { pattern: /\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]+/g, replacement: '<jwt-redacted>' },
  { pattern: /\b(ai_studio_jwt|connect\.sid|session)=[^;\s"']+/gi, replacement: '$1=<redacted>' },
  { pattern: /\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, replacement: '$1 <redacted>' },
  { pattern: /\b(api[_-]?key|token|secret|password)["'\s:=]+[A-Za-z0-9._~+/=-]{8,}/gi, replacement: '$1=<redacted>' },
  { pattern: /data:[a-z]+\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=]+/gi, replacement: '<data-uri-redacted>' },
];

/**
 * Final backstop scrub applied to every log line the proxy emits, so a credential can never reach
 * disk even if a future code path logs something that unexpectedly contains one.
 * @param message - the fully composed log line
 */
export function redactSecrets(message: string): string {
  if (!message) return '';
  return SECRET_PATTERNS.reduce((acc, { pattern, replacement }) => acc.replace(pattern, replacement), message);
}

/**
 * Splits a string on the first occurrence of a separator only.
 * @param value - the string to split
 * @param separator - the separator to split on
 */
function splitOnce(value: string, separator: string): [string, string | undefined] {
  const index = value.indexOf(separator);
  if (index === -1) return [value, undefined];
  return [value.slice(0, index), value.slice(index + separator.length)];
}

/**
 * Truncates a string to a maximum length, marking that it was shortened.
 * @param value - the string to truncate
 * @param maxLength - maximum allowed length
 */
function truncate(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength)}…(truncated)`;
}
