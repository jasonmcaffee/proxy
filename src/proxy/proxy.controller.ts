import { Controller, All, Get, Req, Res } from '@nestjs/common';
import { Request, Response } from 'express';
import { ProxyService } from './proxy.service';

/** Loopback addresses allowed to read the proxy's own diagnostics. */
const LOOPBACK_ADDRESSES = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

@Controller()
export class ProxyController {
  constructor(private readonly proxyService: ProxyService) {}

  /**
   * Socket-guard diagnostics: open proxied pairs, the oldest of them, and the reap counters
   * (task-1556). This is the "is anything accumulating?" check that would have shown the 257 dead
   * upstream connections long before they cost 54 GB of kernel nonpaged pool.
   *
   * The proxy answers for real public hostnames, so this must never be readable from the internet
   * (task-632/696 lesson). A non-loopback caller is proxied like any other request, which means the
   * path simply behaves as if this route did not exist.
   * @param req - the incoming request
   * @param res - the response to write the stats to
   */
  @Get('__proxy/socket-stats')
  socketStats(@Req() req: Request, @Res() res: Response) {
    const remote = req.socket.remoteAddress || '';
    if (!LOOPBACK_ADDRESSES.has(remote)) {
      this.proxyService.handleProxy(req, res);
      return;
    }
    res.json(this.proxyService.socketStats());
  }

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
