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

/** Most frames held for a client whose backend connection has not come up yet (task-1556). */
const MAX_PENDING_MESSAGES = 200;

/** How long the pre-bridge backend probe may hang before it is destroyed (task-1556). */
const HEALTH_CHECK_TIMEOUT_MS = 5_000;

@WebSocketGateway({
  cors: {
    origin: '*',
    methods: ['GET', 'POST'],
  },
  path: '/socket.io',
})
/**
 * Bridges browser socket.io connections to the AI backend's socket.io server.
 *
 * task-1556: `pendingMessages` buffers frames that arrive before the backend connection is up. It
 * used to be unbounded, so a client talking to a backend that never came up could grow the queue
 * without limit — the heap version of the kernel-buffer leak this ticket fixes. It is now capped,
 * and the oldest frames are dropped rather than the newest, because a stream's recent frames are
 * the ones still worth delivering.
 */
export class ProxyGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer() server: Server;
  private readonly logger = new Logger(ProxyGateway.name);
  private readonly backendUrl = process.env.AI_TARGET || 'http://localhost:7070';

  /**
   * Probes the AI backend before bridging a client to it, so a browser is told the backend is down
   * instead of silently queueing frames at nothing.
   *
   * task-1556: this used to open an `http.request` with no timeout, no response drain and no
   * destroy, once per socket.io connection. A backend that accepts the TCP connection but never
   * answers — a wedged Node process, exactly the state this box gets into — left every one of those
   * sockets hung open for ever, one per browser reconnect attempt. That is a socket leak that
   * compounds silently for hours and ends as kernel Winsock (AfdB) buffers nobody can account for.
   * The probe now has a hard deadline, resolves once, drains the response and always destroys the
   * request.
   */
  async checkBackendHealth(): Promise<boolean> {
    return new Promise((resolve) => {
      const url = new URL(this.backendUrl);
      const options = {
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: '/',
        method: 'GET',
        timeout: HEALTH_CHECK_TIMEOUT_MS,
      };

      let settled = false;
      // Declared before the request so `settle` can never touch it before it exists — the response
      // callback can fire before `request()` has returned.
      let req: any;
      const settle = (healthy: boolean) => {
        if (settled) return;
        settled = true;
        req?.destroy();
        resolve(healthy);
      };

      req = require('http').request(options, (res) => {
        this.logger.log(`Backend health check: ${res.statusCode} ${res.statusMessage}`);
        // The body is irrelevant, but an undrained response holds the socket open.
        res.resume();
        settle(res.statusCode >= 200 && res.statusCode < 500);
      });

      req.on('timeout', () => {
        this.logger.warn(`Backend health check timed out after ${HEALTH_CHECK_TIMEOUT_MS}ms`);
        settle(false);
      });

      req.on('error', (error) => {
        this.logger.warn(`Backend health check failed: ${error.message}`);
        settle(false);
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
    // task-632: no per-event logging here — a single chat stream emits thousands of events and
    // each one produced a log line. Connection lifecycle below is logged; individual frames are not.
    (backendSocket as any).onAny((event: string, ...args: any[]) => {
      if (!['connect', 'disconnect', 'error', 'connect_error'].includes(event)) {
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

    // task-632: forwarding is silent. Event names and payloads can carry user content, and logging
    // one line per frame is what made this log unreadable; only queueing (a real anomaly) is noted.
    (client as any).onAny((event: string, ...args: any[]) => {
      if (client.data.backendConnected && backendSocket.connected) {
        backendSocket.emit(event, ...args);
      } else {
        client.data.pendingMessages.push({ event, payload: args });
        if (client.data.pendingMessages.length > MAX_PENDING_MESSAGES) {
          const dropped = client.data.pendingMessages.splice(0, client.data.pendingMessages.length - MAX_PENDING_MESSAGES);
          this.logger.warn(`Dropped ${dropped.length} queued frames for client ${clientId}: backend still not connected`);
        }
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
