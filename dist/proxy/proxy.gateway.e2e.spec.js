"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const testing_1 = require("@nestjs/testing");
const proxy_gateway_1 = require("./proxy.gateway");
const proxy_module_1 = require("./proxy.module");
const { io } = require('socket.io-client');
describe('ProxyGateway (e2e)', () => {
    jest.setTimeout(60000);
    let app;
    let gateway;
    let mockBackendPort;
    beforeAll(async () => {
        mockBackendPort = 8081;
        process.env.NEXTJS_TARGET = `http://localhost:${mockBackendPort}`;
        const moduleFixture = await testing_1.Test.createTestingModule({
            imports: [proxy_module_1.ProxyModule],
        }).compile();
        app = moduleFixture.createNestApplication();
        await app.listen(3000);
        console.log('Proxy service started on port 3000');
        gateway = moduleFixture.get(proxy_gateway_1.ProxyGateway);
    });
    afterAll(async () => {
        if (app) {
            await app.close();
            console.log('Proxy service stopped');
        }
    });
    describe('WebSocket Connection and Proxy', () => {
        it('should have proxy service running', () => {
            expect(app).toBeDefined();
            expect(gateway).toBeDefined();
        });
        let clientSocket;
        let clientSocket2;
        afterEach(() => {
            if (clientSocket) {
                clientSocket.disconnect();
            }
            if (clientSocket2) {
                clientSocket2.disconnect();
            }
        });
        it('should verify backend is accessible', async () => {
            const isHealthy = await gateway.checkBackendHealth();
            expect(isHealthy).toBe(true);
        });
        it('should establish WebSocket connection through proxy', (done) => {
            clientSocket = io('http://localhost:3000', {
                path: '/socket.io',
                transports: ['websocket'],
            });
            clientSocket.on('connect', () => {
                expect(clientSocket.connected).toBe(true);
                done();
            });
            clientSocket.on('connect_error', (error) => {
                done.fail(`Connection failed: ${error.message}`);
            });
        });
        it('should forward client events to backend and receive responses', (done) => {
            clientSocket = io('http://localhost:3000', {
                path: '/socket.io',
                transports: ['websocket'],
            });
            clientSocket.on('connect', () => {
                setTimeout(() => {
                    clientSocket.emit('streamInference', {
                        prompt: 'Hello from proxy test',
                        conversationId: 'test-conversation',
                        modelId: 'test-model'
                    });
                }, 100);
            });
            clientSocket.on('message', (data) => {
                expect(data).toBeDefined();
                done();
            });
            clientSocket.on('error', (error) => {
                console.log('Backend error:', error);
                done();
            });
            clientSocket.on('connect_error', (error) => {
                done.fail(`Connection failed: ${error.message}`);
            });
        });
        it('should handle multiple client connections independently', (done) => {
            let connectionsEstablished = 0;
            const expectedConnections = 2;
            clientSocket = io('http://localhost:3000', {
                path: '/socket.io',
                transports: ['websocket'],
            });
            clientSocket2 = io('http://localhost:3000', {
                path: '/socket.io',
                transports: ['websocket'],
            });
            const checkConnections = () => {
                connectionsEstablished++;
                if (connectionsEstablished === expectedConnections) {
                    done();
                }
            };
            clientSocket.on('connect', () => {
                expect(clientSocket.connected).toBe(true);
                checkConnections();
            });
            clientSocket2.on('connect', () => {
                expect(clientSocket2.connected).toBe(true);
                checkConnections();
            });
            clientSocket.on('connect_error', (error) => {
                done.fail(`Client 1 connection failed: ${error.message}`);
            });
            clientSocket2.on('connect_error', (error) => {
                done.fail(`Client 2 connection failed: ${error.message}`);
            });
        });
        it('should forward events with complex data structures', (done) => {
            clientSocket = io('http://localhost:3000', {
                path: '/socket.io',
                transports: ['websocket'],
            });
            const complexData = {
                prompt: 'Hello World with complex data',
                conversationId: 'complex-test-conversation',
                modelId: 'test-model',
                shouldSearchWeb: true,
                shouldUsePlanTool: false,
                shouldRespondWithAudio: false,
                textToSpeechSpeed: 1.0,
                shouldUseAgentOfAgents: false,
                temperature: 0.7,
                topP: 0.9,
                frequencyPenalty: 0.0,
                presencePenalty: 0.0,
                imageUrl: 'https://example.com/test-image.jpg'
            };
            clientSocket.on('connect', () => {
                setTimeout(() => {
                    clientSocket.emit('streamInference', complexData);
                }, 100);
            });
            clientSocket.on('message', (data) => {
                expect(data).toBeDefined();
                done();
            });
            clientSocket.on('error', (error) => {
                console.log('Backend error:', error);
                done();
            });
            clientSocket.on('connect_error', (error) => {
                done.fail(`Connection failed: ${error.message}`);
            });
        });
        it('should handle rapid message sequences', (done) => {
            clientSocket = io('http://localhost:3000', {
                path: '/socket.io',
                transports: ['websocket'],
            });
            const messages = [];
            const expectedCount = 3;
            clientSocket.on('connect', () => {
                setTimeout(() => {
                    for (let i = 0; i < expectedCount; i++) {
                        clientSocket.emit('streamInference', {
                            prompt: `Rapid message ${i}`,
                            conversationId: `rapid-${i}`,
                            modelId: 'test-model'
                        });
                    }
                }, 100);
            });
            clientSocket.on('message', (data) => {
                messages.push(data);
                if (messages.length === expectedCount) {
                    expect(messages).toHaveLength(expectedCount);
                    done();
                }
            });
            clientSocket.on('error', (error) => {
                messages.push(error);
                if (messages.length === expectedCount) {
                    done();
                }
            });
            clientSocket.on('connect_error', (error) => {
                done.fail(`Connection failed: ${error.message}`);
            });
        });
        it('should handle custom namespace events', (done) => {
            clientSocket = io('http://localhost:3000', {
                path: '/socket.io',
                transports: ['websocket'],
            });
            const namespaceEvents = [
                'streamInference',
                'chat:message',
                'user:status',
                'notification:alert',
                'test:event'
            ];
            let receivedEvents = 0;
            const expectedEvents = namespaceEvents.length;
            clientSocket.on('connect', () => {
                setTimeout(() => {
                    namespaceEvents.forEach((event, index) => {
                        if (event === 'streamInference') {
                            clientSocket.emit(event, {
                                prompt: `Test prompt ${index}`,
                                conversationId: `test-${index}`,
                                modelId: 'test-model'
                            });
                        }
                        else {
                            clientSocket.on(event, (data) => {
                                receivedEvents++;
                                if (receivedEvents === expectedEvents) {
                                    done();
                                }
                            });
                            clientSocket.emit(event, { eventName: event, index });
                        }
                    });
                }, 100);
            });
            clientSocket.on('message', (data) => {
                receivedEvents++;
                if (receivedEvents === expectedEvents) {
                    done();
                }
            });
            clientSocket.on('error', (error) => {
                receivedEvents++;
                if (receivedEvents === expectedEvents) {
                    done();
                }
            });
            clientSocket.on('connect_error', (error) => {
                done.fail(`Connection failed: ${error.message}`);
            });
        });
        it('should handle disconnection and reconnection', (done) => {
            clientSocket = io('http://localhost:3000', {
                path: '/socket.io',
                transports: ['websocket'],
            });
            let disconnectCount = 0;
            let reconnectCount = 0;
            clientSocket.on('connect', () => {
                if (reconnectCount === 0) {
                    setTimeout(() => {
                        clientSocket.disconnect();
                    }, 100);
                }
                else if (reconnectCount === 1) {
                    setTimeout(() => {
                        clientSocket.emit('streamInference', {
                            prompt: 'Reconnected successfully',
                            conversationId: 'reconnect-test',
                            modelId: 'test-model'
                        });
                    }, 100);
                }
            });
            clientSocket.on('disconnect', () => {
                disconnectCount++;
                if (disconnectCount === 1) {
                    setTimeout(() => {
                        clientSocket.connect();
                    }, 100);
                }
            });
            clientSocket.on('message', (data) => {
                expect(data).toBeDefined();
                expect(disconnectCount).toBe(1);
                expect(reconnectCount).toBe(1);
                done();
            });
            clientSocket.on('connect_error', (error) => {
                done.fail(`Connection failed: ${error.message}`);
            });
        });
        it('should handle binary data transmission', (done) => {
            clientSocket = io('http://localhost:3000', {
                path: '/socket.io',
                transports: ['websocket'],
            });
            clientSocket.on('connect', () => {
                setTimeout(() => {
                    clientSocket.emit('streamInference', {
                        prompt: 'Hello Binary World',
                        conversationId: 'binary-test',
                        modelId: 'test-model',
                        imageUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='
                    });
                }, 100);
            });
            clientSocket.on('message', (data) => {
                expect(data).toBeDefined();
                done();
            });
            clientSocket.on('error', (error) => {
                console.log('Backend error:', error);
                done();
            });
            clientSocket.on('connect_error', (error) => {
                done.fail(`Connection failed: ${error.message}`);
            });
        });
        it('should handle room-based messaging', (done) => {
            clientSocket = io('http://localhost:3000', {
                path: '/socket.io',
                transports: ['websocket'],
            });
            clientSocket2 = io('http://localhost:3000', {
                path: '/socket.io',
                transports: ['websocket'],
            });
            let messagesReceived = 0;
            const expectedMessages = 2;
            const checkCompletion = () => {
                messagesReceived++;
                if (messagesReceived === expectedMessages) {
                    done();
                }
            };
            clientSocket.on('connect', () => {
                setTimeout(() => {
                    clientSocket.emit('streamInference', {
                        prompt: 'Hello from client 1',
                        conversationId: 'room-test-1',
                        modelId: 'test-model'
                    });
                }, 100);
            });
            clientSocket2.on('connect', () => {
                setTimeout(() => {
                    clientSocket2.emit('streamInference', {
                        prompt: 'Hello from client 2',
                        conversationId: 'room-test-2',
                        modelId: 'test-model'
                    });
                }, 100);
            });
            clientSocket.on('message', (data) => {
                expect(data).toBeDefined();
                checkCompletion();
            });
            clientSocket2.on('message', (data) => {
                expect(data).toBeDefined();
                checkCompletion();
            });
            clientSocket.on('connect_error', (error) => {
                done.fail(`Client 1 connection failed: ${error.message}`);
            });
            clientSocket2.on('connect_error', (error) => {
                done.fail(`Client 2 connection failed: ${error.message}`);
            });
        });
    });
    describe('Error Handling and Edge Cases', () => {
        let clientSocket;
        afterEach(() => {
            if (clientSocket) {
                clientSocket.disconnect();
            }
        });
        it('should handle malformed messages gracefully', (done) => {
            clientSocket = io('http://localhost:3000', {
                path: '/socket.io',
                transports: ['websocket'],
            });
            clientSocket.on('connect', () => {
                setTimeout(() => {
                    clientSocket.emit('streamInference', undefined);
                    clientSocket.emit('streamInference', null);
                    clientSocket.emit('streamInference', { prompt: '' });
                    clientSocket.emit('streamInference', {
                        prompt: 'Valid message',
                        conversationId: 'malformed-test',
                        modelId: 'test-model'
                    });
                }, 100);
            });
            clientSocket.on('message', (data) => {
                expect(data).toBeDefined();
                done();
            });
            clientSocket.on('error', (error) => {
                console.log('Backend error:', error);
                done();
            });
            clientSocket.on('connect_error', (error) => {
                done.fail(`Connection failed: ${error.message}`);
            });
        });
        it('should handle very large messages', (done) => {
            clientSocket = io('http://localhost:3000', {
                path: '/socket.io',
                transports: ['websocket'],
            });
            const largePrompt = 'x'.repeat(1024 * 1024);
            clientSocket.on('connect', () => {
                setTimeout(() => {
                    clientSocket.emit('streamInference', {
                        prompt: largePrompt,
                        conversationId: 'large-test',
                        modelId: 'test-model'
                    });
                }, 100);
            });
            clientSocket.on('message', (data) => {
                expect(data).toBeDefined();
                done();
            });
            clientSocket.on('error', (error) => {
                console.log('Backend error:', error);
                done();
            });
            clientSocket.on('connect_error', (error) => {
                done.fail(`Connection failed: ${error.message}`);
            });
        });
        it('should handle concurrent connections under load', (done) => {
            const connections = [];
            const connectionCount = 5;
            let establishedConnections = 0;
            for (let i = 0; i < connectionCount; i++) {
                const socket = io('http://localhost:3000', {
                    path: '/socket.io',
                    transports: ['websocket'],
                });
                socket.on('connect', () => {
                    establishedConnections++;
                    if (establishedConnections === connectionCount) {
                        setTimeout(() => {
                            connections[0].emit('streamInference', {
                                prompt: 'Concurrent connection test',
                                conversationId: 'concurrent-test',
                                modelId: 'test-model'
                            });
                            connections[0].on('message', (data) => {
                                expect(data).toBeDefined();
                                connections.forEach(s => s.disconnect());
                                done();
                            });
                            connections[0].on('error', (error) => {
                                console.log('Backend error:', error);
                                connections.forEach(s => s.disconnect());
                                done();
                            });
                        }, 100);
                    }
                });
                socket.on('connect_error', (error) => {
                    connections.forEach(s => s.disconnect());
                    done.fail(`Connection ${i} failed: ${error.message}`);
                });
                connections.push(socket);
            }
        }, 60000);
    });
});
//# sourceMappingURL=proxy.gateway.e2e.spec.js.map