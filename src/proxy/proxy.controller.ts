import { Controller, All, Req, Res } from '@nestjs/common';
import { Request, Response } from 'express';
import { ProxyService } from './proxy.service';

@Controller()
export class ProxyController {
  constructor(private readonly proxyService: ProxyService) {}

  /**
   * Entry point for every proxied HTTP request.
   *
   * task-632: this used to log the request line AND `JSON.stringify(req.headers)` here, which wrote
   * the caller's live `ai_studio_jwt` session cookie to disk on every request. Request logging now
   * happens once, on response, in ProxyService via RequestLoggerService — headers are never logged.
   * @param req - the incoming request
   * @param res - the response to write the proxied result to
   */
  @All('*')
  async handleAllRequests(@Req() req: Request, @Res() res: Response) {
    this.proxyService.handleProxy(req, res);
  }
}
