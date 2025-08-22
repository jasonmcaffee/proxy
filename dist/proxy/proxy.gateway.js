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
const { io } = require('socket.io-client');
let ProxyGateway = ProxyGateway_1 = class ProxyGateway {
    constructor() {
        this.logger = new common_1.Logger(ProxyGateway_1.name);
        this.backendUrl = process.env.NEXTJS_TARGET || 'http://localhost:8081';
    }
    async checkBackendHealth() {
        return new Promise((resolve) => {
            const url = new URL(this.backendUrl);
            const options = {
                hostname: url.hostname,
                port: url.port || (url.protocol === 'https:' ? 443 : 80),
                path: '/',
                method: 'GET',
            };
            const req = require('http').request(options, (res) => {
                this.logger.log(`Backend health check: ${res.statusCode} ${res.statusMessage}`);
                resolve(res.statusCode >= 200 && res.statusCode < 500);
            });
            req.on('error', (error) => {
                this.logger.warn(`Backend health check failed: ${error.message}`);
                resolve(false);
            });
            req.end();
        });
    }
    async handleConnection(client) {
        const clientId = client.id;
        this.logger.log(`Client connected: ${clientId} from ${client.handshake.address}`);
        client.data.backendConnected = false;
        client.data.pendingMessages = [];
        const isBackendHealthy = await this.checkBackendHealth();
        if (!isBackendHealthy) {
            this.logger.error(`Backend server is not accessible at ${this.backendUrl}`);
            client.emit('error', { message: 'Backend server is not accessible' });
            client.disconnect();
            return;
        }
        const backendSocket = io(this.backendUrl, {
            path: '/socket.io',
            transports: ['websocket'],
            timeout: 15000,
            forceNew: true,
        });
        backendSocket.onAny((event, ...args) => {
            if (!['connect', 'disconnect', 'error', 'connect_error'].includes(event)) {
                this.logger.log(`Forwarding backend event '${event}' to client ${clientId}`);
                client.emit(event, ...args);
            }
        });
        backendSocket.on('connect', () => {
            this.logger.log(`Connected to backend for client ${clientId}`);
            client.data.backendConnected = true;
            client.emit('connectionSuccess', { message: 'Connected via proxy', clientId });
            if (client.data.pendingMessages.length) {
                this.logger.log(`Flushing ${client.data.pendingMessages.length} queued messages for client ${clientId}`);
                for (const { event, payload } of client.data.pendingMessages) {
                    backendSocket.emit(event, ...payload);
                }
                client.data.pendingMessages = [];
            }
        });
        backendSocket.on('connect_error', (error) => {
            this.logger.error(`Backend connection error for client ${clientId}: ${error.message}`);
            client.emit('error', { message: 'Failed to connect to backend', error: error.message });
            client.data.backendConnected = false;
        });
        backendSocket.on('disconnect', (reason) => {
            this.logger.log(`Backend disconnected for client ${clientId}: ${reason}`);
            client.emit('disconnected', { message: 'Backend disconnected', reason });
            client.data.backendConnected = false;
        });
        client.data.backendSocket = backendSocket;
        client.onAny((event, ...args) => {
            if (client.data.backendConnected && backendSocket.connected) {
                this.logger.log(`Forwarding client event '${event}' to backend for client ${clientId}`);
                backendSocket.emit(event, ...args);
            }
            else {
                this.logger.log(`Queueing event '${event}' for client ${clientId} (backend not connected)`);
                client.data.pendingMessages.push({ event, payload: args });
            }
        });
    }
    handleDisconnect(client) {
        const clientId = client.id;
        this.logger.log(`Client disconnected: ${clientId}`);
        if (client.data.backendSocket) {
            client.data.backendSocket.disconnect();
            this.logger.log(`Backend socket disconnected for client ${clientId}`);
        }
    }
};
exports.ProxyGateway = ProxyGateway;
__decorate([
    (0, websockets_1.WebSocketServer)(),
    __metadata("design:type", socket_io_1.Server)
], ProxyGateway.prototype, "server", void 0);
exports.ProxyGateway = ProxyGateway = ProxyGateway_1 = __decorate([
    (0, websockets_1.WebSocketGateway)({
        cors: {
            origin: '*',
            methods: ['GET', 'POST'],
        },
        path: '/socket.io',
    })
], ProxyGateway);
//# sourceMappingURL=proxy.gateway.js.map