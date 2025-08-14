import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  OnGatewayConnection,
  OnGatewayDisconnect,
  OnGatewayInit,
} from '@nestjs/websockets';
import { Logger } from '@nestjs/common';
import { Server, Socket } from 'socket.io';

@WebSocketGateway({
  cors: {
    origin: '*',
    methods: ['GET', 'POST'],
  },
})
export class ProxyGateway implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer() server: Server;
  private readonly logger = new Logger(ProxyGateway.name);

  afterInit(server: Server) {
    this.logger.log('🔌 WebSocket Gateway initialized');
  }

  handleConnection(client: Socket, ...args: any[]) {
    const clientId = client.id;
    const clientIp = client.handshake.address;
    const userAgent = client.handshake.headers['user-agent'] || 'unknown';
    
    this.logger.log(`🔗 WebSocket client connected: ${clientId} from ${clientIp} - ${userAgent}`);
    
    // Send welcome message
    client.emit('connected', {
      message: 'Connected to proxy service',
      clientId,
      timestamp: new Date().toISOString(),
    });
  }

  handleDisconnect(client: Socket) {
    const clientId = client.id;
    this.logger.log(`🔌 WebSocket client disconnected: ${clientId}`);
  }

  @SubscribeMessage('ping')
  handlePing(client: Socket, payload: any) {
    this.logger.log(`🏓 Ping from client ${client.id}`);
    client.emit('pong', {
      message: 'Pong from proxy service',
      timestamp: new Date().toISOString(),
      payload,
    });
  }

  @SubscribeMessage('message')
  handleMessage(client: Socket, payload: any) {
    this.logger.log(`💬 Message from client ${client.id}: ${JSON.stringify(payload)}`);
    
    // Echo the message back (you can modify this to proxy to backend services)
    client.emit('message', {
      message: 'Message received by proxy service',
      originalPayload: payload,
      timestamp: new Date().toISOString(),
    });
  }
}

