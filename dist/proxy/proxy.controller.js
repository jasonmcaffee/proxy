"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
var __param = (this && this.__param) || function (paramIndex, decorator) {
    return function (target, key) { decorator(target, key, paramIndex); }
};
var ProxyController_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.ProxyController = void 0;
const common_1 = require("@nestjs/common");
const proxy_service_1 = require("./proxy.service");
let ProxyController = ProxyController_1 = class ProxyController {
    constructor(proxyService) {
        this.proxyService = proxyService;
        this.logger = new common_1.Logger(ProxyController_1.name);
    }
    async handleAllRequests(req, res) {
        const host = req.get('Host') || 'unknown';
        const method = req.method;
        const url = req.url;
        const userAgent = req.get('User-Agent') || 'unknown';
        const ip = req.ip || req.connection.remoteAddress || 'unknown';
        this.logger.log(`🌐 ${method} ${url} from ${ip} (${host}) - ${userAgent}`);
        this.logger.log(`🔍 Request headers: ${JSON.stringify(req.headers)}`);
        this.proxyService.handleProxy(req, res);
    }
};
exports.ProxyController = ProxyController;
__decorate([
    (0, common_1.All)('*'),
    __param(0, (0, common_1.Req)()),
    __param(1, (0, common_1.Res)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object]),
    __metadata("design:returntype", Promise)
], ProxyController.prototype, "handleAllRequests", null);
exports.ProxyController = ProxyController = ProxyController_1 = __decorate([
    (0, common_1.Controller)(),
    __metadata("design:paramtypes", [proxy_service_1.ProxyService])
], ProxyController);
//# sourceMappingURL=proxy.controller.js.map