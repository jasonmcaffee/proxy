import { OnGatewayConnection, OnGatewayDisconnect } from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
export declare class ProxyGateway implements OnGatewayConnection, OnGatewayDisconnect {
    server: Server;
    private readonly logger;
    private readonly backendUrl;
    checkBackendHealth(): Promise<boolean>;
    handleConnection(client: Socket): Promise<void>;
    handleDisconnect(client: Socket): void;
}
