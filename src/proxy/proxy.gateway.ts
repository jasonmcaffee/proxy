import {
  WebSocketGateway,
  WebSocketServer,
  OnGatewayConnection,
  OnGatewayDisconnect,
} from '@nestjs/websockets';
import { Logger } from '@nestjs/common';
import { Server, Socket } from 'socket.io';
// Import socket.io-client using require to avoid type issues
const { io } = require('socket.io-client');
import type { Socket as ClientSocketType } from 'socket.io-client';  // <- type-only import

@WebSocketGateway({
  cors: {
    origin: '*',
    methods: ['GET', 'POST'],
  },
  path: '/socket.io',
})
export class ProxyGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer() server: Server;
  private readonly logger = new Logger(ProxyGateway.name);
  private readonly backendUrl = process.env.NEXTJS_TARGET || 'http://localhost:8081';

  async checkBackendHealth(): Promise<boolean> {
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

  async handleConnection(client: Socket) {
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

    // Create backendSocket with correct typing
    const backendSocket = io(this.backendUrl, {
      path: '/socket.io',
      transports: ['websocket'],
      timeout: 15000,
      forceNew: true,
    });

    // Use `onAny` casting to any to avoid possible TS issues
    (backendSocket as any).onAny((event: string, ...args: any[]) => {
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
        this.logger.log(
            `Flushing ${client.data.pendingMessages.length} queued messages for client ${clientId}`
        );
        for (const { event, payload } of client.data.pendingMessages) {
          backendSocket.emit(event, ...payload);
        }
        client.data.pendingMessages = [];
      }
    });

    backendSocket.on('connect_error', (error: Error) => {
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

    (client as any).onAny((event: string, ...args: any[]) => {
      if (client.data.backendConnected && backendSocket.connected) {
        this.logger.log(`Forwarding client event '${event}' to backend for client ${clientId}`);
        backendSocket.emit(event, ...args);
      } else {
        this.logger.log(
            `Queueing event '${event}' for client ${clientId} (backend not connected)`
        );
        client.data.pendingMessages.push({ event, payload: args });
      }
    });
  }

  handleDisconnect(client: Socket) {
    const clientId = client.id;
    this.logger.log(`Client disconnected: ${clientId}`);

    if (client.data.backendSocket) {
      client.data.backendSocket.disconnect();
      this.logger.log(`Backend socket disconnected for client ${clientId}`);
    }
  }
}
