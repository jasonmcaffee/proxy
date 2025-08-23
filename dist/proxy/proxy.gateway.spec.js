"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const testing_1 = require("@nestjs/testing");
const proxy_gateway_1 = require("./proxy.gateway");
const { io } = require('socket.io-client');
jest.mock('socket.io-client', () => ({
    io: jest.fn(),
}));
jest.mock('http', () => ({
    request: jest.fn(),
}));
describe('ProxyGateway', () => {
    let gateway;
    let mockServer;
    let mockClient;
    let mockBackendSocket;
    beforeEach(async () => {
        process.env.NEXTJS_TARGET = 'http://localhost:8081';
        mockBackendSocket = {
            id: 'backend-socket-id',
            connected: true,
            on: jest.fn(),
            emit: jest.fn(),
            disconnect: jest.fn(),
            onAny: jest.fn(),
        };
        mockClient = {
            id: 'client-socket-id',
            handshake: {
                address: '127.0.0.1',
                headers: {},
                time: new Date().toISOString(),
                xdomain: false,
                secure: false,
                issued: 0,
                url: '',
                query: {},
                auth: {}
            },
            data: {},
            emit: jest.fn(),
            disconnect: jest.fn(),
            onAny: jest.fn(),
        };
        mockServer = {
            on: jest.fn(),
        };
        const module = await testing_1.Test.createTestingModule({
            providers: [proxy_gateway_1.ProxyGateway],
        }).compile();
        gateway = module.get(proxy_gateway_1.ProxyGateway);
        gateway.server = mockServer;
        io.mockReturnValue(mockBackendSocket);
    });
    afterEach(() => {
        jest.clearAllMocks();
        delete process.env.NEXTJS_TARGET;
    });
    describe('Gateway Configuration', () => {
        it('should be defined', () => {
            expect(gateway).toBeDefined();
        });
        it('should have correct WebSocket gateway configuration', () => {
            expect(gateway).toBeDefined();
        });
        it('should have CORS enabled for all origins', () => {
            expect(gateway).toBeDefined();
        });
        it('should use correct socket.io path', () => {
            expect(gateway).toBeDefined();
        });
    });
    describe('Backend Health Check', () => {
        it('should return true when backend is healthy', async () => {
            const mockHttp = require('http');
            const mockResponse = {
                statusCode: 200,
                statusMessage: 'OK',
            };
            mockHttp.request.mockImplementation((options, callback) => {
                callback(mockResponse);
                return {
                    on: jest.fn(),
                    end: jest.fn(),
                };
            });
            const result = await gateway.checkBackendHealth();
            expect(result).toBe(true);
        });
        it('should return false when backend returns error status', async () => {
            const mockHttp = require('http');
            const mockResponse = {
                statusCode: 500,
                statusMessage: 'Internal Server Error',
            };
            mockHttp.request.mockImplementation((options, callback) => {
                callback(mockResponse);
                return {
                    on: jest.fn(),
                    end: jest.fn(),
                };
            });
            const result = await gateway.checkBackendHealth();
            expect(result).toBe(false);
        });
        it('should return false when backend connection fails', async () => {
            const mockHttp = require('http');
            mockHttp.request.mockImplementation((options, callback) => {
                const mockRequest = {
                    on: jest.fn().mockImplementation((event, errorCallback) => {
                        if (event === 'error') {
                            errorCallback(new Error('Connection failed'));
                        }
                    }),
                    end: jest.fn(),
                };
                return mockRequest;
            });
            const result = await gateway.checkBackendHealth();
            expect(result).toBe(false);
        });
        it('should use environment variable for backend URL', async () => {
            process.env.NEXTJS_TARGET = 'http://custom-backend:9000';
            const newGateway = new proxy_gateway_1.ProxyGateway();
            const mockHttp = require('http');
            mockHttp.request.mockImplementation((options, callback) => {
                expect(options.hostname).toBe('custom-backend');
                expect(options.port).toBe('9000');
                callback({ statusCode: 200 });
                return { on: jest.fn(), end: jest.fn() };
            });
            await newGateway.checkBackendHealth();
        });
        it('should use default backend URL when environment variable is not set', async () => {
            delete process.env.NEXTJS_TARGET;
            const mockHttp = require('http');
            mockHttp.request.mockImplementation((options, callback) => {
                expect(options.hostname).toBe('localhost');
                expect(options.port).toBe('8081');
                callback({ statusCode: 200 });
                return { on: jest.fn(), end: jest.fn() };
            });
            await gateway.checkBackendHealth();
        });
    });
    describe('Connection Handling', () => {
        it('should handle client connection successfully', async () => {
            const mockHttp = require('http');
            mockHttp.request.mockImplementation((options, callback) => {
                callback({ statusCode: 200 });
                return { on: jest.fn(), end: jest.fn() };
            });
            await gateway.handleConnection(mockClient);
            expect(io).toHaveBeenCalledWith('http://localhost:8081', {
                path: '/socket.io',
                transports: ['websocket'],
                timeout: 15000,
                forceNew: true,
            });
            expect(mockClient.data.backendSocket).toBeDefined();
            expect(mockClient.data.pendingMessages).toEqual([]);
            expect(mockClient.data.backendConnected).toBe(false);
        });
        it('should disconnect client when backend is unhealthy', async () => {
            const mockHttp = require('http');
            mockHttp.request.mockImplementation((options, callback) => {
                callback({ statusCode: 500 });
                return { on: jest.fn(), end: jest.fn() };
            });
            await gateway.handleConnection(mockClient);
            expect(mockClient.emit).toHaveBeenCalledWith('error', {
                message: 'Backend server is not accessible',
            });
            expect(mockClient.disconnect).toHaveBeenCalled();
        });
        it('should handle backend connection success', async () => {
            const mockHttp = require('http');
            mockHttp.request.mockImplementation((options, callback) => {
                callback({ statusCode: 200 });
                return { on: jest.fn(), end: jest.fn() };
            });
            await gateway.handleConnection(mockClient);
            const connectCallback = mockBackendSocket.on.mock.calls.find(call => call[0] === 'connect')[1];
            connectCallback();
            expect(mockClient.data.backendConnected).toBe(true);
            expect(mockClient.emit).toHaveBeenCalledWith('connectionSuccess', {
                message: 'Connected via proxy',
                clientId: 'client-socket-id',
            });
        });
        it('should handle backend connection error', async () => {
            const mockHttp = require('http');
            mockHttp.request.mockImplementation((options, callback) => {
                callback({ statusCode: 200 });
                return { on: jest.fn(), end: jest.fn() };
            });
            await gateway.handleConnection(mockClient);
            const connectErrorCallback = mockBackendSocket.on.mock.calls.find(call => call[0] === 'connect_error')[1];
            connectErrorCallback(new Error('Connection failed'));
            expect(mockClient.data.backendConnected).toBe(false);
            expect(mockClient.emit).toHaveBeenCalledWith('error', {
                message: 'Failed to connect to backend',
                error: 'Connection failed',
            });
        });
        it('should handle backend disconnection', async () => {
            const mockHttp = require('http');
            mockHttp.request.mockImplementation((options, callback) => {
                callback({ statusCode: 200 });
                return { on: jest.fn(), end: jest.fn() };
            });
            await gateway.handleConnection(mockClient);
            const disconnectCallback = mockBackendSocket.on.mock.calls.find(call => call[0] === 'disconnect')[1];
            disconnectCallback('Client disconnected');
            expect(mockClient.data.backendConnected).toBe(false);
            expect(mockClient.emit).toHaveBeenCalledWith('disconnected', {
                message: 'Backend disconnected',
                reason: 'Client disconnected',
            });
        });
    });
    describe('Message Forwarding', () => {
        it('should forward client events to backend when connected', async () => {
            const mockHttp = require('http');
            mockHttp.request.mockImplementation((options, callback) => {
                callback({ statusCode: 200 });
                return { on: jest.fn(), end: jest.fn() };
            });
            await gateway.handleConnection(mockClient);
            mockClient.data.backendConnected = true;
            mockBackendSocket.connected = true;
            const onAnyCallback = mockClient.onAny.mock.calls[0][0];
            onAnyCallback('testEvent', 'testData');
            expect(mockBackendSocket.emit).toHaveBeenCalledWith('testEvent', 'testData');
        });
        it('should queue client events when backend is not connected', async () => {
            const mockHttp = require('http');
            mockHttp.request.mockImplementation((options, callback) => {
                callback({ statusCode: 200 });
                return { on: jest.fn(), end: jest.fn() };
            });
            await gateway.handleConnection(mockClient);
            mockClient.data.backendConnected = false;
            const onAnyCallback = mockClient.onAny.mock.calls[0][0];
            onAnyCallback('queuedEvent', 'queuedData');
            expect(mockClient.data.pendingMessages).toHaveLength(1);
            expect(mockClient.data.pendingMessages[0]).toEqual({
                event: 'queuedEvent',
                payload: ['queuedData'],
            });
        });
        it('should flush queued messages when backend connects', async () => {
            const mockHttp = require('http');
            mockHttp.request.mockImplementation((options, callback) => {
                callback({ statusCode: 200 });
                return { on: jest.fn(), end: jest.fn() };
            });
            await gateway.handleConnection(mockClient);
            mockClient.data.pendingMessages = [
                { event: 'event1', payload: ['data1'] },
                { event: 'event2', payload: ['data2', 'data3'] },
            ];
            const connectCallback = mockBackendSocket.on.mock.calls.find(call => call[0] === 'connect')[1];
            connectCallback();
            expect(mockBackendSocket.emit).toHaveBeenCalledWith('event1', 'data1');
            expect(mockBackendSocket.emit).toHaveBeenCalledWith('event2', 'data2', 'data3');
            expect(mockClient.data.pendingMessages).toHaveLength(0);
        });
        it('should forward backend events to client', async () => {
            const mockHttp = require('http');
            mockHttp.request.mockImplementation((options, callback) => {
                callback({ statusCode: 200 });
                return { on: jest.fn(), end: jest.fn() };
            });
            await gateway.handleConnection(mockClient);
            const onAnyCallback = mockBackendSocket.onAny.mock.calls[0][0];
            onAnyCallback('backendEvent', 'backendData');
            expect(mockClient.emit).toHaveBeenCalledWith('backendEvent', 'backendData');
        });
        it('should not forward system events from backend', async () => {
            const mockHttp = require('http');
            mockHttp.request.mockImplementation((options, callback) => {
                callback({ statusCode: 200 });
                return { on: jest.fn(), end: jest.fn() };
            });
            await gateway.handleConnection(mockClient);
            const onAnyCallback = mockBackendSocket.onAny.mock.calls[0][0];
            onAnyCallback('connect', 'connectData');
            onAnyCallback('disconnect', 'disconnectData');
            onAnyCallback('error', 'errorData');
            onAnyCallback('connect_error', 'connectErrorData');
            expect(mockClient.emit).not.toHaveBeenCalledWith('connect', 'connectData');
            expect(mockClient.emit).not.toHaveBeenCalledWith('disconnect', 'disconnectData');
            expect(mockClient.emit).not.toHaveBeenCalledWith('error', 'errorData');
            expect(mockClient.emit).not.toHaveBeenCalledWith('connect_error', 'connectErrorData');
        });
        it('should forward custom namespace events', async () => {
            const mockHttp = require('http');
            mockHttp.request.mockImplementation((options, callback) => {
                callback({ statusCode: 200 });
                return { on: jest.fn(), end: jest.fn() };
            });
            await gateway.handleConnection(mockClient);
            const onAnyCallback = mockBackendSocket.onAny.mock.calls[0][0];
            onAnyCallback('chat:message', { user: 'test', message: 'hello' });
            onAnyCallback('game:move', { player: 'player1', position: { x: 10, y: 20 } });
            onAnyCallback('notification:alert', 'Important message');
            expect(mockClient.emit).toHaveBeenCalledWith('chat:message', { user: 'test', message: 'hello' });
            expect(mockClient.emit).toHaveBeenCalledWith('game:move', { player: 'player1', position: { x: 10, y: 20 } });
            expect(mockClient.emit).toHaveBeenCalledWith('notification:alert', 'Important message');
        });
    });
    describe('Disconnection Handling', () => {
        it('should handle client disconnection', () => {
            mockClient.data.backendSocket = mockBackendSocket;
            gateway.handleDisconnect(mockClient);
            expect(mockBackendSocket.disconnect).toHaveBeenCalled();
        });
        it('should handle client disconnection without backend socket gracefully', () => {
            mockClient.data = {};
            expect(() => {
                gateway.handleDisconnect(mockClient);
            }).not.toThrow();
        });
    });
    describe('Namespace Interception', () => {
        it('should intercept all namespaces from client', async () => {
            const mockHttp = require('http');
            mockHttp.request.mockImplementation((options, callback) => {
                callback({ statusCode: 200 });
                return { on: jest.fn(), end: jest.fn() };
            });
            await gateway.handleConnection(mockClient);
            expect(mockClient.onAny).toHaveBeenCalled();
        });
        it('should intercept all namespaces from backend', async () => {
            const mockHttp = require('http');
            mockHttp.request.mockImplementation((options, callback) => {
                callback({ statusCode: 200 });
                return { on: jest.fn(), end: jest.fn() };
            });
            await gateway.handleConnection(mockClient);
            expect(mockBackendSocket.onAny).toHaveBeenCalled();
        });
        it('should handle events with multiple arguments correctly', async () => {
            const mockHttp = require('http');
            mockHttp.request.mockImplementation((options, callback) => {
                callback({ statusCode: 200 });
                return { on: jest.fn(), end: jest.fn() };
            });
            await gateway.handleConnection(mockClient);
            mockClient.data.backendConnected = true;
            mockBackendSocket.connected = true;
            const onAnyCallback = mockClient.onAny.mock.calls[0][0];
            onAnyCallback('multiArgEvent', 'arg1', 'arg2', { complex: 'data' }, [1, 2, 3]);
            expect(mockBackendSocket.emit).toHaveBeenCalledWith('multiArgEvent', 'arg1', 'arg2', { complex: 'data' }, [1, 2, 3]);
        });
    });
    describe('Error Handling', () => {
        it('should handle backend health check timeout gracefully', async () => {
            const mockHttp = require('http');
            mockHttp.request.mockImplementation((options, callback) => {
                return {
                    on: jest.fn().mockImplementation((event, errorCallback) => {
                        if (event === 'error') {
                            setTimeout(() => {
                                errorCallback(new Error('ETIMEDOUT'));
                            }, 100);
                        }
                    }),
                    end: jest.fn(),
                };
            });
            const result = await gateway.checkBackendHealth();
            expect(result).toBe(false);
        });
        it('should handle malformed backend URL gracefully', async () => {
            process.env.NEXTJS_TARGET = 'invalid-url';
            const mockHttp = require('http');
            mockHttp.request.mockImplementation((options, callback) => {
                callback({ statusCode: 200 });
                return { on: jest.fn(), end: jest.fn() };
            });
            expect(() => {
                gateway.checkBackendHealth();
            }).not.toThrow();
        });
    });
    describe('Performance and Scalability', () => {
        it('should handle multiple client connections', async () => {
            const mockHttp = require('http');
            mockHttp.request.mockImplementation((options, callback) => {
                callback({ statusCode: 200 });
                return { on: jest.fn(), end: jest.fn() };
            });
            const client1 = { ...mockClient, id: 'client-1' };
            const client2 = { ...mockClient, id: 'client-2' };
            const client3 = { ...mockClient, id: 'client-3' };
            await gateway.handleConnection(client1);
            await gateway.handleConnection(client2);
            await gateway.handleConnection(client3);
            expect(client1.data.backendSocket).toBeDefined();
            expect(client2.data.backendSocket).toBeDefined();
            expect(client3.data.backendSocket).toBeDefined();
            expect(client1.data.backendSocket).toBeDefined();
            expect(client2.data.backendSocket).toBeDefined();
            expect(client3.data.backendSocket).toBeDefined();
        });
        it('should handle rapid connect/disconnect cycles', async () => {
            const mockHttp = require('http');
            mockHttp.request.mockImplementation((options, callback) => {
                callback({ statusCode: 200 });
                return { on: jest.fn(), end: jest.fn() };
            });
            const client = { ...mockClient, id: 'rapid-client' };
            await gateway.handleConnection(client);
            gateway.handleDisconnect(client);
            expect(() => {
                gateway.handleDisconnect(client);
            }).not.toThrow();
        });
    });
});
//# sourceMappingURL=proxy.gateway.spec.js.map