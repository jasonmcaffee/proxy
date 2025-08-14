import { Request, Response } from 'express';
import { ProxyService } from './proxy.service';
export declare class ProxyController {
    private readonly proxyService;
    private readonly logger;
    constructor(proxyService: ProxyService);
    handleAllRequests(req: Request, res: Response): Promise<void>;
}
