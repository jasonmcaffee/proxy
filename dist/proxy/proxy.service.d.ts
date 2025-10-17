import { Request, Response } from 'express';
export declare class ProxyService {
    private readonly logger;
    private readonly nextjsTarget;
    private readonly nestjsTarget;
    private readonly plexTarget;
    getTargetUrl(host: string): string;
    handleProxy(req: Request, res: Response): void;
}
