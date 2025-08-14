import { Controller, All, Req, Res, Next, Logger } from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';
import { ProxyService } from './proxy.service';

@Controller()
export class ProxyController {
  private readonly logger = new Logger(ProxyController.name);

  constructor(private readonly proxyService: ProxyService) {}

  @All('*')
  async handleAllRequests(
    @Req() req: Request,
    @Res() res: Response,
  ) {
    // Log every incoming request
    const host = req.get('Host') || 'unknown';
    const method = req.method;
    const url = req.url;
    const userAgent = req.get('User-Agent') || 'unknown';
    const ip = req.ip || req.connection.remoteAddress || 'unknown';
    
    this.logger.log(`🌐 ${method} ${url} from ${ip} (${host}) - ${userAgent}`);
    this.logger.log(`🔍 Request headers: ${JSON.stringify(req.headers)}`);
    
    // Handle the proxy request
    this.proxyService.handleProxy(req, res);
  }
}
