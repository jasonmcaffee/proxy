"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var ProxyService_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.ProxyService = void 0;
const common_1 = require("@nestjs/common");
const http = require("http");
const url = require("url");
let ProxyService = ProxyService_1 = class ProxyService {
    constructor() {
        this.logger = new common_1.Logger(ProxyService_1.name);
        this.nextjsTarget = process.env.NEXTJS_TARGET || 'http://localhost:8080';
        this.nestjsTarget = process.env.NESTJS_TARGET || 'http://localhost:8081';
    }
    getTargetUrl(host) {
        if (host === 'ai.jasonmcaffee.com') {
            return this.nestjsTarget;
        }
        else if (host.endsWith('jasonmcaffee.com')) {
            return this.nextjsTarget;
        }
        return this.nextjsTarget;
    }
    handleProxy(req, res) {
        let host = req.get('Host');
        if (!host) {
            this.logger.warn('⚠️ Request without Host header, defaulting to jasonmcaffee.com');
            host = 'jasonmcaffee.com';
        }
        const targetUrl = this.getTargetUrl(host);
        const targetUrlObj = url.parse(targetUrl);
        this.logger.log(`📥 ${req.method} ${req.url} (${host}) → ${targetUrl}`);
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
        const proxyReq = http.request(options, (proxyRes) => {
            this.logger.log(`📤 ${req.method} ${req.url} (${host}) ← ${proxyRes.statusCode}`);
            res.writeHead(proxyRes.statusCode, proxyRes.headers);
            proxyRes.pipe(res);
        });
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
        req.on('close', () => {
            proxyReq.destroy();
        });
        if (req.body && Object.keys(req.body).length > 0) {
            proxyReq.write(JSON.stringify(req.body));
        }
        proxyReq.end();
    }
};
exports.ProxyService = ProxyService;
exports.ProxyService = ProxyService = ProxyService_1 = __decorate([
    (0, common_1.Injectable)()
], ProxyService);
//# sourceMappingURL=proxy.service.js.map