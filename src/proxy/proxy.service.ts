import { Injectable, Logger } from '@nestjs/common';
import { Request, Response } from 'express';
import * as http from 'http';
import * as url from 'url';

@Injectable()
export class ProxyService {
  private readonly logger = new Logger(ProxyService.name);

  private readonly nextjsTarget = process.env.NEXTJS_TARGET || 'http://localhost:8082';
  private readonly nestjsTarget = process.env.NESTJS_TARGET || 'http://localhost:8081';

  /**
   * Get the target URL based on the host header
   */
  getTargetUrl(host: string): string {
    if (host === 'ai.jasonmcaffee.com') {
      return this.nestjsTarget;
    } else if (host.endsWith('jasonmcaffee.com')) {
      return this.nextjsTarget;
    }
    
    // Default fallback
    return this.nextjsTarget;
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
    const targetUrlObj = url.parse(targetUrl);
    
    this.logger.log(`📥 ${req.method} ${req.url} (${host}) → ${targetUrl}`);
    
    // Create HTTP request options
    const options = {
      hostname: targetUrlObj.hostname,
      port: parseInt(targetUrlObj.port || '80', 10),
      path: req.url,
      method: req.method,
      headers: {
        ...req.headers,
        'x-forwarded-for': req.ip || req.connection.remoteAddress,
        'x-forwarded-proto': req.protocol,
        'x-forwarded-host': host,
      },
    };
    
    // Make the proxy request
    const proxyReq = http.request(options, (proxyRes) => {
      this.logger.log(`📤 ${req.method} ${req.url} (${host}) ← ${proxyRes.statusCode}`);
      
      // Copy response headers
      res.writeHead(proxyRes.statusCode, proxyRes.headers);
      
      // Pipe the response
      proxyRes.pipe(res);
    });
    
    // Handle proxy request errors
    proxyReq.on('error', (err) => {
      this.logger.error(`❌ ${req.method} ${req.url} (${host}) - Proxy error: ${err.message}`);
      
      if (!res.headersSent) {
        res.status(502).json({
          error: 'Bad Gateway',
          message: 'Unable to proxy request to backend service',
          timestamp: new Date().toISOString(),
        });
      }
    });
    
    // Handle client disconnect
    req.on('close', () => {
      proxyReq.destroy();
    });
    
    // Handle request body properly
    if (req.body && Object.keys(req.body).length > 0) {
      // Only write body if it exists and has content
      proxyReq.write(JSON.stringify(req.body));
    }
    
    // Send the request
    proxyReq.end();
  }
}
