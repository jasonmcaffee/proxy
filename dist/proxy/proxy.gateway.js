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
var ProxyGateway_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.ProxyGateway = void 0;
const websockets_1 = require("@nestjs/websockets");
const common_1 = require("@nestjs/common");
const socket_io_1 = require("socket.io");
let ProxyGateway = ProxyGateway_1 = class ProxyGateway {
    constructor() {
        this.logger = new common_1.Logger(ProxyGateway_1.name);
    }
    afterInit(server) {
        this.logger.log('🔌 WebSocket Gateway initialized');
    }
    handleConnection(client, ...args) {
        const clientId = client.id;
        const clientIp = client.handshake.address;
        const userAgent = client.handshake.headers['user-agent'] || 'unknown';
        this.logger.log(`🔗 WebSocket client connected: ${clientId} from ${clientIp} - ${userAgent}`);
        client.emit('connected', {
            message: 'Connected to proxy service',
            clientId,
            timestamp: new Date().toISOString(),
        });
    }
    handleDisconnect(client) {
        const clientId = client.id;
        this.logger.log(`🔌 WebSocket client disconnected: ${clientId}`);
    }
    handlePing(client, payload) {
        this.logger.log(`🏓 Ping from client ${client.id}`);
        client.emit('pong', {
            message: 'Pong from proxy service',
            timestamp: new Date().toISOString(),
            payload,
        });
    }
    handleMessage(client, payload) {
        this.logger.log(`💬 Message from client ${client.id}: ${JSON.stringify(payload)}`);
        client.emit('message', {
            message: 'Message received by proxy service',
            originalPayload: payload,
            timestamp: new Date().toISOString(),
        });
    }
};
exports.ProxyGateway = ProxyGateway;
__decorate([
    (0, websockets_1.WebSocketServer)(),
    __metadata("design:type", socket_io_1.Server)
], ProxyGateway.prototype, "server", void 0);
__decorate([
    (0, websockets_1.SubscribeMessage)('ping'),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [socket_io_1.Socket, Object]),
    __metadata("design:returntype", void 0)
], ProxyGateway.prototype, "handlePing", null);
__decorate([
    (0, websockets_1.SubscribeMessage)('message'),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [socket_io_1.Socket, Object]),
    __metadata("design:returntype", void 0)
], ProxyGateway.prototype, "handleMessage", null);
exports.ProxyGateway = ProxyGateway = ProxyGateway_1 = __decorate([
    (0, websockets_1.WebSocketGateway)({
        cors: {
            origin: '*',
            methods: ['GET', 'POST'],
        },
    })
], ProxyGateway);
//# sourceMappingURL=proxy.gateway.js.map