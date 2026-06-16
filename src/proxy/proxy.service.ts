import { Injectable, Logger } from '@nestjs/common';
import { Request, Response } from 'express';
import { createProxyMiddleware } from 'http-proxy-middleware';
import * as net from 'net';
import * as http from 'http';

@Injectable()
export class ProxyService {
  private readonly logger = new Logger(ProxyService.name);

  private readonly nextjsTarget = process.env.NEXTJS_TARGET || 'http://localhost:8082';
  private readonly aiTarget = process.env.AI_TARGET || 'http://localhost:7070';
  private readonly aiServiceTarget = process.env.AI_SERVICE_TARGET || 'http://localhost:8081';
  private readonly mediaTarget = process.env.MEDIA_TARGET || 'http://localhost:5010';
  private readonly plexTarget = process.env.PLEX_TARGET || 'http://localhost:32400';
  /** Chordical community API (NestJS backend) — api.chordical.com */
  private readonly chordicalApiTarget = process.env.CHORDICAL_API_TARGET || 'http://localhost:4500';
  /** Chordical marketing UI (Next.js) — www.chordical.com */
  private readonly chordicalUiTarget = process.env.CHORDICAL_UI_TARGET || 'http://localhost:3100';

  /** Path prefix that routes to the NestJS AI service backend (stripped before forwarding). */
  private readonly aiServicePathPrefix = '/ai-api';

  /** Path prefix for public news HTML pages, forwarded to the NestJS backend WITHOUT stripping. */
  private readonly newsPathPrefix = '/news';

  private readonly proxies: Map<string, any> = new Map();

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

    this.logger.log(`🔌 WS upgrade: ${req.url} (${host}) → ${targetUrl}${forwardUrl}`);

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

    targetSocket.on('error', (err: Error) => {
      this.logger.error(`WS tunnel error for ${host}: ${err.message}`);
      socket.destroy();
    });

    socket.on('error', (err: Error) => {
      this.logger.error(`WS client socket error for ${host}: ${err.message}`);
      targetSocket.destroy();
    });
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

      const proxy = createProxyMiddleware({
        target: targetUrl,
        changeOrigin: true,
        // No timeout for AI or Chordical — SSE/WS streams can be long-lived
        ...(isAi || isChordical ? {} : { timeout: 30000, proxyTimeout: 30000 }),
        onProxyReq: (proxyReq, req: any) => {
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
          this.logger.log(`📤 ${req.method} ${req.url} (${host}) ← ${proxyRes.statusCode}`);
        },
        onError: (err, req: any, res) => {
          this.logger.error(`❌ ${req.method} ${req.url} (${host}) - Proxy error: ${err.message}`);
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
        pathRewrite: (path: string) => path.replace(pathPrefix, '') || '/',
        onProxyReq: (proxyReq, req: any) => {
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
          this.logger.log(`📤 ${req.method} ${req.url} (ai-service) ← ${proxyRes.statusCode}`);
        },
        onError: (err, req: any, res: any) => {
          this.logger.error(`❌ ai-service proxy error: ${err.message}`);
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
        onProxyReq: (proxyReq, req: any) => {
          proxyReq.setHeader('x-forwarded-for', req.ip || req.connection?.remoteAddress || 'unknown');
          proxyReq.setHeader('x-forwarded-proto', req.protocol || 'http');
        },
        onProxyRes: (proxyRes, req: any) => {
          this.logger.log(`📤 ${req.method} ${req.url} (news) ← ${proxyRes.statusCode}`);
        },
        onError: (err, req: any, res: any) => {
          this.logger.error(`❌ news proxy error: ${err.message}`);
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
      this.logger.warn('⚠️ Request without Host header, defaulting to jasonmcaffee.com');
      host = 'jasonmcaffee.com';
    }

    // Path-based routing: /ai-api/* → NestJS AI service backend (prefix stripped)
    if (req.url.startsWith(this.aiServicePathPrefix)) {
      this.logger.log(`📥 ${req.method} ${req.url} (${host}) → ai-service ${this.aiServiceTarget}`);
      const proxy = this.getAiServiceProxyMiddleware();
      proxy(req, res, (err: any) => {
        if (err) this.logger.error(`❌ ai-service proxy middleware error: ${err.message}`);
      });
      return;
    }

    // Path-based routing: /news* → NestJS AI service backend (path NOT stripped)
    if (req.url === this.newsPathPrefix || req.url.startsWith(`${this.newsPathPrefix}/`)) {
      this.logger.log(`📥 ${req.method} ${req.url} (${host}) → news ${this.aiServiceTarget}`);
      const proxy = this.getNewsProxyMiddleware();
      proxy(req, res, (err: any) => {
        if (err) this.logger.error(`❌ news proxy middleware error: ${err.message}`);
      });
      return;
    }

    const targetUrl = this.getTargetUrl(host);
    this.logger.log(`📥 ${req.method} ${req.url} (${host}) → ${targetUrl}`);

    const proxy = this.getProxyMiddleware(targetUrl, host);
    proxy(req, res, (err: any) => {
      if (err) {
        this.logger.error(`❌ Proxy middleware error: ${err.message}`);
      }
    });
  }

}
