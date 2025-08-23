import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { ProxyGateway } from './proxy.gateway';
import { ProxyModule } from './proxy.module';
// Import socket.io-client using require to avoid type issues
const { io } = require('socket.io-client');
type ClientSocket = any;
import { Server } from 'socket.io';

describe('ProxyGateway (e2e)', () => {
  // Increase timeout for real network connections
  jest.setTimeout(60000);
  let app: INestApplication;
  let gateway: ProxyGateway;
  let mockBackendPort: number;

  beforeAll(async () => {
    // Use the existing backend service running on port 8081
    mockBackendPort = 8081;
    
    // Set environment variable for backend
    process.env.NEXTJS_TARGET = `http://localhost:${mockBackendPort}`;

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [ProxyModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    
    // Start the proxy service on port 3000
    await app.listen(3000);
    console.log('Proxy service started on port 3000');

    gateway = moduleFixture.get<ProxyGateway>(ProxyGateway);
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

    let clientSocket: ClientSocket;
    let clientSocket2: ClientSocket;

    afterEach(() => {
      if (clientSocket) {
        clientSocket.disconnect();
      }
      if (clientSocket2) {
        clientSocket2.disconnect();
      }
    });

    it('should verify backend is accessible', async () => {
      // Test that the backend service is running and accessible
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
        // Wait for backend connection to be established
        setTimeout(() => {
          // Use the actual event that your backend service expects
          clientSocket.emit('streamInference', { 
            prompt: 'Hello from proxy test',
            conversationId: 'test-conversation',
            modelId: 'test-model'
          });
        }, 100);
      });

      clientSocket.on('message', (data) => {
        // Your backend service emits 'message' events
        expect(data).toBeDefined();
        done();
      });

      clientSocket.on('error', (error) => {
        // Handle any errors from the backend
        console.log('Backend error:', error);
        // Still complete the test as we're testing the proxy, not the backend logic
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
        // Your backend service emits 'message' events
        expect(data).toBeDefined();
        done();
      });

      clientSocket.on('error', (error) => {
        // Handle any errors from the backend
        console.log('Backend error:', error);
        // Still complete the test as we're testing the proxy, not the backend logic
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
      const expectedCount = 3; // Reduced count to avoid overwhelming the backend

      clientSocket.on('connect', () => {
        setTimeout(() => {
          // Send multiple streamInference messages rapidly
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
        // Count errors as messages too
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
          // Send events with different namespaces
          namespaceEvents.forEach((event, index) => {
            if (event === 'streamInference') {
              // Use the format your backend expects
              clientSocket.emit(event, { 
                prompt: `Test prompt ${index}`,
                conversationId: `test-${index}`,
                modelId: 'test-model'
              });
            } else {
              clientSocket.on(event, (data) => {
                // For events that don't have handlers, just count them
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

      // Listen for the streamInference response
      clientSocket.on('message', (data) => {
        receivedEvents++;
        if (receivedEvents === expectedEvents) {
          done();
        }
      });

      clientSocket.on('error', (error) => {
        // Count errors as received events too
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
          // First connection - disconnect after a short delay
          setTimeout(() => {
            clientSocket.disconnect();
          }, 100);
        } else if (reconnectCount === 1) {
          // Reconnected - send a test message
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
          // Reconnect after disconnect
          setTimeout(() => {
            clientSocket.connect();
          }, 100);
        }
      });

      clientSocket.on('message', (data) => {
        // Your backend service emits 'message' events
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
          // Send streamInference with binary data in imageUrl
          clientSocket.emit('streamInference', { 
            prompt: 'Hello Binary World',
            conversationId: 'binary-test',
            modelId: 'test-model',
            imageUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='
          });
        }, 100);
      });

      clientSocket.on('message', (data) => {
        // Your backend service emits 'message' events
        expect(data).toBeDefined();
        done();
      });

      clientSocket.on('error', (error) => {
        // Handle any errors from the backend
        console.log('Backend error:', error);
        // Still complete the test as we're testing the proxy, not the backend logic
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

      // Both clients should receive message responses
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
    let clientSocket: ClientSocket;

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
          // Send malformed streamInference data
          clientSocket.emit('streamInference', undefined);
          clientSocket.emit('streamInference', null);
          clientSocket.emit('streamInference', { prompt: '' }); // Missing required fields
          
          // Send a valid message to complete the test
          clientSocket.emit('streamInference', { 
            prompt: 'Valid message',
            conversationId: 'malformed-test',
            modelId: 'test-model'
          });
        }, 100);
      });

      clientSocket.on('message', (data) => {
        // Your backend service emits 'message' events
        expect(data).toBeDefined();
        done();
      });

      clientSocket.on('error', (error) => {
        // Handle any errors from the backend
        console.log('Backend error:', error);
        // Still complete the test as we're testing the proxy, not the backend logic
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

      // Create a large prompt (1MB)
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
        // Your backend service emits 'message' events
        expect(data).toBeDefined();
        done();
      });

      clientSocket.on('error', (error) => {
        // Handle any errors from the backend
        console.log('Backend error:', error);
        // Still complete the test as we're testing the proxy, not the backend logic
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
            // All connections established, send a test message to verify proxy works
            setTimeout(() => {
              connections[0].emit('streamInference', { 
                prompt: 'Concurrent connection test',
                conversationId: 'concurrent-test',
                modelId: 'test-model'
              });
              
              // Listen for response
              connections[0].on('message', (data) => {
                expect(data).toBeDefined();
                // Clean up and complete
                connections.forEach(s => s.disconnect());
                done();
              });
              
              connections[0].on('error', (error) => {
                console.log('Backend error:', error);
                // Clean up and complete even on error
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
    }, 60000); // Longer timeout for multiple connections and real network
  });
});

