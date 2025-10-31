import { Injectable, Logger } from '@nestjs/common';
import { Request, Response } from 'express';
import { createProxyMiddleware } from 'http-proxy-middleware';

@Injectable()
export class ProxyService {
  private readonly logger = new Logger(ProxyService.name);

  private readonly nextjsTarget = process.env.NEXTJS_TARGET || 'http://localhost:8082';
  private readonly nestjsTarget = process.env.NESTJS_TARGET || 'http://localhost:8081';
  private readonly plexTarget = process.env.PLEX_TARGET || 'http://localhost:32400';

  private readonly proxies: Map<string, any> = new Map();

  /**
   * Get the target URL based on the host header
   */
  getTargetUrl(host: string): string {
    if (host === 'ai.jasonmcaffee.com') {
      return this.nestjsTarget;
    } else if (host === 'plex.jasonmcaffee.com') {
      return this.plexTarget;
    } else if (host.endsWith('jasonmcaffee.com')) {
      return this.nextjsTarget;
    }

    // Default fallback
    return this.nextjsTarget;
  }

  /**
   * Get or create a proxy middleware for a target
   */
  private getProxyMiddleware(targetUrl: string, host: string) {
    const cacheKey = `${host}-${targetUrl}`;

    if (!this.proxies.has(cacheKey)) {
      const isPlex = host === 'plex.jasonmcaffee.com';

      const proxy = createProxyMiddleware({
        target: targetUrl,
        changeOrigin: true,
        timeout: 30000, // 30 second timeout
        proxyTimeout: 30000,
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
          if (req.body && !Buffer.isBuffer(req.body) && typeof req.body !== 'string') {
            const contentType = req.headers['content-type'] || 'application/json';
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
          // If body is a string, Buffer, or hasn't been parsed, 
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
   * Handle the proxy request
   */
  handleProxy(req: Request, res: Response) {
    let host = req.get('Host');

    if (!host) {
      this.logger.warn('⚠️ Request without Host header, defaulting to jasonmcaffee.com');
      host = 'jasonmcaffee.com';
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
