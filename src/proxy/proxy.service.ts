import { Injectable } from '@nestjs/common';
import { Request, Response } from 'express';
import { createProxyMiddleware } from 'http-proxy-middleware';
import * as net from 'net';
import * as http from 'http';
import { RequestLoggerService } from './requestLogger.service';
import { sanitizeUrl } from './logSanitizer';
import { SocketGuardService, linkSocketLifetimes } from './socketGuard.service';

/**
 * Reads a positive integer environment variable, falling back when unset or malformed.
 * @param name - environment variable to read
 * @param fallback - value used when the variable is absent or not a positive integer
 */
function readPositiveInt(name: string, fallback: number): number {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

@Injectable()
export class ProxyService {
  constructor(
    private readonly requestLogger: RequestLoggerService,
    private readonly socketGuard: SocketGuardService,
  ) {}

  /** Personal home page (jasonmcaffee.com / www) and the default for any unrouted host. */
  private readonly nextjsTarget = process.env.NEXTJS_TARGET || 'http://localhost:3200';
  private readonly aiTarget = process.env.AI_TARGET || 'http://localhost:7070';
  private readonly aiServiceTarget = process.env.AI_SERVICE_TARGET || 'http://localhost:8081';
  private readonly mediaTarget = process.env.MEDIA_TARGET || 'http://localhost:5010';
  private readonly plexTarget = process.env.PLEX_TARGET || 'http://localhost:32400';
  /** Chordical community API (NestJS backend) — api.chordical.com */
  private readonly chordicalApiTarget = process.env.CHORDICAL_API_TARGET || 'http://localhost:4500';
  /** Chordical marketing UI (Next.js) — www.chordical.com */
  private readonly chordicalUiTarget = process.env.CHORDICAL_UI_TARGET || 'http://localhost:3100';
  /** Local GitHub (Gitea) — git.jasonmcaffee.com */
  private readonly gitTarget = process.env.GIT_TARGET || 'http://localhost:3000';
  /** Phone Sync backup server (API + web gallery, one process) — phone.jasonmcaffee.com */
  private readonly phoneSyncTarget = process.env.PHONE_SYNC_TARGET || 'http://localhost:7071';

  /** Path prefix that routes to the NestJS AI service backend (stripped before forwarding). */
  private readonly aiServicePathPrefix = '/ai-api';

  /** Path prefix for public news HTML pages, forwarded to the NestJS backend WITHOUT stripping. */
  private readonly newsPathPrefix = '/news';

  private readonly proxies: Map<string, any> = new Map();

  /**
   * The single upstream connection pool every proxied HTTP request goes through (task-1556).
   *
   * Without an explicit agent, http-proxy hands each request to Node's global agent and the number
   * of upstream sockets this process can hold is bounded only by how fast requests arrive. That is
   * the shape the AfdB pool blow-up actually had: 54 GB of nonpaged pool at roughly 2 MB per
   * allocation is about 26,700 allocations, which is tens of thousands of sockets rather than a few
   * hundred enormous ones — and it all went away the instant this process was restarted.
   *
   * `maxSockets` is set high enough that normal traffic never queues (the AI backend alone holds
   * many concurrent SSE streams) but low enough that a runaway can no longer reach five figures.
   * `keepAlive` matters for the same reason: reusing a socket is one fewer socket created and torn
   * down, and socket churn is what accumulates kernel buffers.
   */
  private readonly upstreamAgent = new http.Agent({
    keepAlive: true,
    keepAliveMsecs: 30_000,
    maxSockets: readPositiveInt('PROXY_MAX_UPSTREAM_SOCKETS', 512),
    maxFreeSockets: readPositiveInt('PROXY_MAX_FREE_UPSTREAM_SOCKETS', 32),
  });

  /**
   * Get the target URL based on the host header
   */
  getTargetUrl(host: string): string {
    if (host === 'ai.jasonmcaffee.com') {
      return this.aiTarget;
    } else if (host === 'media.jasonmcaffee.com') {
      return this.mediaTarget;
    } else if (host === 'plex.jasonmcaffee.com') {
      return this.plexTarget;
    } else if (host === 'git.jasonmcaffee.com') {
      return this.gitTarget;
    } else if (host === 'phone.jasonmcaffee.com') {
      return this.phoneSyncTarget;
    } else if (host.endsWith('jasonmcaffee.com')) {
      return this.nextjsTarget;
    } else if (host === 'api.chordical.com') {
      return this.chordicalApiTarget;
    } else if (host === 'chordical.com' || host === 'www.chordical.com') {
      return this.chordicalUiTarget;
    }

    // Default fallback
    return this.nextjsTarget;
  }

  /**
   * Proxy a WebSocket upgrade via a transparent TCP tunnel.
   * Routes /ai-api/* upgrades to the NestJS backend (stripping the prefix);
   * all other upgrades are routed by Host header.
   * @param req - the incoming upgrade request
   * @param socket - the client TCP socket
   * @param head - buffered bytes from the client after the HTTP headers
   */
  handleWsUpgrade(req: http.IncomingMessage, socket: any, head: Buffer) {
    const host = req.headers.host || '';
    let targetUrl: string;
    let forwardUrl = req.url || '/';

    if (req.url?.startsWith(this.aiServicePathPrefix)) {
      targetUrl = this.aiServiceTarget;
      forwardUrl = req.url.replace(this.aiServicePathPrefix, '') || '/';
    } else {
      targetUrl = this.getTargetUrl(host);
    }

    const parsed = new URL(targetUrl);
    const targetPort = parseInt(parsed.port) || (parsed.protocol === 'https:' ? 443 : 80);
    const targetHost = parsed.hostname;

    this.requestLogger.logInfo(`WS upgrade: ${sanitizeUrl(req.url || '/')} (${host}) -> ${targetUrl}`);

    // task-1556: a tunnel is a pair of sockets nothing else owns, so it is registered with the
    // socket guard for its whole life. Without this a client that vanishes leaves the upstream half
    // open and undrained, and the kernel buffers whatever the upstream keeps sending — the exact
    // shape of the 54 GB AfdB nonpaged-pool leak.
    const guard = this.socketGuard.track(`ws ${host}`, socket);

    const targetSocket = net.connect(targetPort, targetHost, () => {
      let requestLine = `${req.method} ${forwardUrl} HTTP/${req.httpVersion}\r\n`;
      for (const [key, value] of Object.entries(req.headers)) {
        const values = Array.isArray(value) ? value : [value];
        for (const v of values) {
          requestLine += `${key}: ${v}\r\n`;
        }
      }
      requestLine += '\r\n';

      targetSocket.write(requestLine);
      if (head && head.length > 0) {
        targetSocket.write(head);
      }

      socket.pipe(targetSocket);
      targetSocket.pipe(socket);
    });

    guard.attachUpstream(targetSocket);
    // Either half closing tears the other down immediately; a WebSocket has no meaningful
    // half-open state, and a lingering half is what accumulates kernel buffers.
    linkSocketLifetimes(socket, targetSocket);
    targetSocket.once('close', () => guard.release());
    socket.once('close', () => guard.release());

    targetSocket.on('error', (err: Error) => {
      this.requestLogger.logWarn(`WS tunnel error for ${host}: ${err.message}`);
      socket.destroy();
    });

    socket.on('error', (err: Error) => {
      this.requestLogger.logWarn(`WS client socket error for ${host}: ${err.message}`);
      targetSocket.destroy();
    });
  }

  /**
   * Registers an in-flight proxied HTTP request with the socket guard and guarantees the upstream
   * connection dies with it (task-1556).
   *
   * Two distinct failures are covered. The first is a client that goes away mid-response:
   * http-proxy only reacts to an explicit abort, so a response that is closed for any other reason
   * used to leave the upstream socket open and unread while the upstream carried on writing into
   * kernel buffers. The second is a client that neither aborts nor reads — nothing in the stack
   * notices that at all, which is what the guard's stall/idle sweep is for.
   * @param proxyReq - the outgoing request to the upstream
   * @param req - the incoming client request
   * @param res - the response being written back to the client
   * @param label - short, low-cardinality description used in guard log lines
   */
  private guardProxiedRequest(proxyReq: http.ClientRequest, req: any, res: any, label: string) {
    const guard = this.socketGuard.track(label, req.socket);

    if (proxyReq.socket) guard.attachUpstream(proxyReq.socket);
    else proxyReq.once('socket', (upstream) => guard.attachUpstream(upstream));

    let released = false;
    const finish = (truncated: boolean) => {
      if (released) return;
      released = true;
      guard.release();
      // A truncated response leaves the upstream connection unusable and, worse, still being
      // written to. Destroying it is what returns the pinned kernel buffers.
      if (truncated) proxyReq.destroy();
    };

    res.once('close', () => finish(!res.writableEnded));
    res.once('finish', () => finish(false));
    proxyReq.once('close', () => finish(false));
    proxyReq.once('error', () => finish(false));
  }

  /**
   * Get or create a proxy middleware for a target
   */
  private getProxyMiddleware(targetUrl: string, host: string) {
    const cacheKey = `${host}-${targetUrl}`;

    if (!this.proxies.has(cacheKey)) {
      const isPlex = host === 'plex.jasonmcaffee.com';
      const isAi = host === 'ai.jasonmcaffee.com';
      const isChordical = host === 'chordical.com' || host === 'api.chordical.com' || host === 'www.chordical.com';
      // Gitea: git clone/push stream large packfiles and can run well past 30s
      const isGit = host === 'git.jasonmcaffee.com';
      // Phone Sync: a phone uploading a multi-GB 4K video over a slow uplink is
      // a single POST that easily runs past 30s, so it must not be timed out.
      const isPhoneSync = host === 'phone.jasonmcaffee.com';
      // The personal site serves its own video files (task-1559). A visitor on a slow connection
      // pulling a 60 MB MP4 — or simply watching a long range request play out — runs past 30s
      // routinely, and being cut off mid-stream stalls the player.
      const isSite = targetUrl === this.nextjsTarget;

      const proxy = createProxyMiddleware({
        target: targetUrl,
        changeOrigin: true,
        // task-1556: bounded, reusing pool instead of Node's unbounded global agent. Only for
        // http targets — an http.Agent cannot serve an https one, and every target here is local.
        ...(targetUrl.startsWith('http://') ? { agent: this.upstreamAgent } : {}),
        // task-632: silence http-proxy-middleware's own logger. It emitted its own `[HPM] Error
        // occurred while proxying...` line for every failure, doubling an error storm; our
        // RequestLoggerService reports the same failures once per window instead.
        logLevel: 'silent',
        // No timeout for AI, Chordical, Git, Phone Sync or the personal site — SSE/WS streams,
        // git packfile transfers, phone media uploads and self-hosted video are all long-lived
        // and must not be cut off at 30s
        ...(isAi || isChordical || isGit || isPhoneSync || isSite ? {} : { timeout: 30000, proxyTimeout: 30000 }),
        onProxyReq: (proxyReq, req: any, res: any) => {
          this.guardProxiedRequest(proxyReq, req, res, `http ${host}`);

          if (isPlex) {
            // Plex-specific header modifications
            const targetHost = new URL(targetUrl).host;
            proxyReq.setHeader('host', targetHost);
            proxyReq.setHeader('referer', `http://${targetHost}`);
            proxyReq.setHeader('origin', `http://${targetHost}`);
            proxyReq.setHeader('x-forwarded-for', '127.0.0.1');
            proxyReq.setHeader('x-real-ip', '127.0.0.1');
            proxyReq.setHeader('x-forwarded-proto', 'http');
            proxyReq.removeHeader('x-forwarded-host');
          } else {
            // Preserve original forwarding info
            proxyReq.setHeader('x-forwarded-for', req.ip || req.connection?.remoteAddress || 'unknown');
            proxyReq.setHeader('x-forwarded-proto', req.protocol || 'http');
            proxyReq.setHeader('x-forwarded-host', host);
          }

          // Handle request body - if it has been parsed by middleware, re-stringify it
          // This is necessary because parsed bodies need to be sent as strings over HTTP
          // EXCEPT for multipart/form-data, which must be streamed as-is
          const contentType = req.headers['content-type'] || '';
          const isMultipart = contentType.includes('multipart/form-data');
          
          if (!isMultipart && req.body && !Buffer.isBuffer(req.body) && typeof req.body !== 'string') {
            let bodyData: string;
            
            if (contentType.includes('application/json')) {
              bodyData = JSON.stringify(req.body);
            } else {
              bodyData = String(req.body);
            }
            
            proxyReq.setHeader('Content-Type', contentType);
            proxyReq.setHeader('Content-Length', Buffer.byteLength(bodyData));
            proxyReq.write(bodyData);
          }
          // If body is multipart/form-data, string, Buffer, or hasn't been parsed, 
          // http-proxy-middleware will automatically handle it via streaming
        },
        onProxyRes: (proxyRes, req: any) => {
          this.requestLogger.logCompleted(req.method, req.url, host, targetUrl, proxyRes.statusCode, req.__proxyStartedAt);
        },
        onError: (err, req: any, res) => {
          this.requestLogger.logError(req.method, req.url, host, err.message);
          if (!res.headersSent) {
            res.writeHead(502, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
              error: 'Bad Gateway',
              message: 'Unable to proxy request to backend service',
              timestamp: new Date().toISOString(),
            }));
          }
        },
      });

      this.proxies.set(cacheKey, proxy);
    }

    return this.proxies.get(cacheKey);
  }

  /**
   * Returns a cached proxy middleware for NestJS backend calls that strips the /ai-api prefix.
   */
  private getAiServiceProxyMiddleware() {
    const cacheKey = 'ai-service';
    if (!this.proxies.has(cacheKey)) {
      const pathPrefix = this.aiServicePathPrefix;
      const target = this.aiServiceTarget;
      const proxy = createProxyMiddleware({
        target,
        changeOrigin: true,
        agent: this.upstreamAgent,
        logLevel: 'silent',
        pathRewrite: (path: string) => path.replace(pathPrefix, '') || '/',
        onProxyReq: (proxyReq, req: any, res: any) => {
          this.guardProxiedRequest(proxyReq, req, res, 'http ai-service');
          proxyReq.setHeader('x-forwarded-for', req.ip || req.connection?.remoteAddress || 'unknown');
          proxyReq.setHeader('x-forwarded-proto', req.protocol || 'http');
          const contentType = req.headers['content-type'] || '';
          const isMultipart = contentType.includes('multipart/form-data');
          if (!isMultipart && req.body && !Buffer.isBuffer(req.body) && typeof req.body !== 'string') {
            const bodyData = contentType.includes('application/json') ? JSON.stringify(req.body) : String(req.body);
            proxyReq.setHeader('Content-Type', contentType);
            proxyReq.setHeader('Content-Length', Buffer.byteLength(bodyData));
            proxyReq.write(bodyData);
          }
        },
        onProxyRes: (proxyRes, req: any) => {
          const host = req.headers?.host || 'unknown';
          this.requestLogger.logCompleted(req.method, req.url, host, 'ai-service', proxyRes.statusCode, req.__proxyStartedAt);
        },
        onError: (err, req: any, res: any) => {
          this.requestLogger.logError(req.method, req.url, req.headers?.host || 'unknown', `ai-service ${err.message}`);
          if (!res.headersSent) {
            res.writeHead(502, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Bad Gateway', message: 'Unable to reach AI service backend' }));
          }
        },
      });
      this.proxies.set(cacheKey, proxy);
    }
    return this.proxies.get(cacheKey);
  }

  /**
   * Returns a cached proxy middleware that forwards /news* to the NestJS backend
   * WITHOUT rewriting the path, so the backend receives /news/<date> unchanged.
   */
  private getNewsProxyMiddleware() {
    const cacheKey = 'news-service';
    if (!this.proxies.has(cacheKey)) {
      const proxy = createProxyMiddleware({
        target: this.aiServiceTarget,
        changeOrigin: true,
        agent: this.upstreamAgent,
        logLevel: 'silent',
        onProxyReq: (proxyReq, req: any, res: any) => {
          this.guardProxiedRequest(proxyReq, req, res, 'http news');
          proxyReq.setHeader('x-forwarded-for', req.ip || req.connection?.remoteAddress || 'unknown');
          proxyReq.setHeader('x-forwarded-proto', req.protocol || 'http');
        },
        onProxyRes: (proxyRes, req: any) => {
          const host = req.headers?.host || 'unknown';
          this.requestLogger.logCompleted(req.method, req.url, host, 'news', proxyRes.statusCode, req.__proxyStartedAt);
        },
        onError: (err, req: any, res: any) => {
          this.requestLogger.logError(req.method, req.url, req.headers?.host || 'unknown', `news ${err.message}`);
          if (!res.headersSent) {
            res.writeHead(502, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Bad Gateway', message: 'Unable to reach AI service backend' }));
          }
        },
      });
      this.proxies.set(cacheKey, proxy);
    }
    return this.proxies.get(cacheKey);
  }

  /**
   * Handle the proxy request, routing /ai-api/* and /news* to the NestJS backend and all else by host.
   */
  handleProxy(req: Request, res: Response) {
    let host = req.get('Host');

    if (!host) {
      this.requestLogger.logWarn('Request without Host header, defaulting to jasonmcaffee.com');
      host = 'jasonmcaffee.com';
    }

    // Stamp the arrival time so the single response-time log line can report duration.
    // task-632: routing is no longer logged on the way in — one sanitized line per request is
    // emitted on the way out (and routine reads are rolled up rather than logged individually).
    (req as any).__proxyStartedAt = Date.now();

    // Path-based routing: /ai-api/* → NestJS AI service backend (prefix stripped)
    if (req.url.startsWith(this.aiServicePathPrefix)) {
      const proxy = this.getAiServiceProxyMiddleware();
      proxy(req, res, (err: any) => {
        if (err) this.requestLogger.logError(req.method, req.url, host, `ai-service middleware ${err.message}`);
      });
      return;
    }

    // Path-based routing: /news* → NestJS AI service backend (path NOT stripped)
    if (req.url === this.newsPathPrefix || req.url.startsWith(`${this.newsPathPrefix}/`)) {
      const proxy = this.getNewsProxyMiddleware();
      proxy(req, res, (err: any) => {
        if (err) this.requestLogger.logError(req.method, req.url, host, `news middleware ${err.message}`);
      });
      return;
    }

    const targetUrl = this.getTargetUrl(host);
    const proxy = this.getProxyMiddleware(targetUrl, host);
    proxy(req, res, (err: any) => {
      if (err) this.requestLogger.logError(req.method, req.url, host, `middleware ${err.message}`);
    });
  }

  /**
   * Snapshot of the socket guard: how many proxied pairs are open, how long the oldest have been
   * open, and how many have been reaped as stalled or idle. Served only to loopback callers so a
   * runaway accumulation can be seen before it becomes a nonpaged-pool problem (task-1556).
   */
  socketStats() {
    return this.socketGuard.stats();
  }
}
