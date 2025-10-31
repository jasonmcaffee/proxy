import * as http from 'http';
// Import socket.io-client using require to avoid type issues
const { io } = require('socket.io-client');
type Socket = any;

const PROXY_HOST = 'localhost';
const PROXY_PORT = 80;

describe('Comprehensive Proxy Tests', () => {
  describe('HTTP GET Request', () => {
    it('should successfully proxy GET request to jasonmcaffee.com', async () => {
      return new Promise<void>((resolve, reject) => {
        const options = {
          hostname: PROXY_HOST,
          port: PROXY_PORT,
          path: '/',
          method: 'GET',
          headers: {
            'Host': 'jasonmcaffee.com',
            'User-Agent': 'ComprehensiveTest/1.0'
          }
        };

        const req = http.request(options, (res) => {
          let data = '';
          res.on('data', (chunk) => { data += chunk; });
          res.on('end', () => {
            expect([200, 304]).toContain(res.statusCode);
            resolve();
          });
        });

        req.on('error', (err) => {
          reject(err);
        });

        req.setTimeout(5000, () => {
          req.destroy();
          reject(new Error('Timeout'));
        });

        req.end();
      });
    });
  });

  describe('JSON POST Request', () => {
    it('should successfully proxy JSON POST to ai.jasonmcaffee.com', async () => {
      return new Promise<void>((resolve, reject) => {
        const jsonData = JSON.stringify({ conversationName: 'Test Chat' });

        const options = {
          hostname: PROXY_HOST,
          port: PROXY_PORT,
          path: '/conversations/conversation',
          method: 'POST',
          headers: {
            'Host': 'ai.jasonmcaffee.com',
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(jsonData),
            'User-Agent': 'ComprehensiveTest/1.0',
            'Origin': 'https://jasonmcaffee.com',
            'Referer': 'https://jasonmcaffee.com/'
          },
          timeout: 10000
        };

        const req = http.request(options, (res) => {
          expect(res.statusCode).toBeDefined();
          expect(res.headers).toBeDefined();

          let data = '';
          res.on('data', (chunk) => { data += chunk; });
          res.on('end', () => {
            expect([201, 200]).toContain(res.statusCode);
            expect(data.length).toBeGreaterThanOrEqual(0);
            resolve();
          });
        });

        req.on('error', (err) => {
          reject(err);
        });

        req.on('timeout', () => {
          req.destroy();
          reject(new Error('Request timed out after 10 seconds'));
        });

        req.write(jsonData);
        req.end();
      });
    });
  });

  describe('Binary POST Request', () => {
    it('should successfully proxy binary POST request', async () => {
      return new Promise<void>((resolve, reject) => {
        const binaryData = Buffer.from('RIFF....WEBM....fake audio data', 'utf-8');

        const options = {
          hostname: PROXY_HOST,
          port: PROXY_PORT,
          path: '/speech-audio/test',
          method: 'POST',
          headers: {
            'Host': 'ai.jasonmcaffee.com',
            'Content-Type': 'audio/webm;codecs=opus',
            'Content-Length': binaryData.length,
            'User-Agent': 'ComprehensiveTest/1.0'
          }
        };

        const req = http.request(options, (res) => {
          let data = '';
          res.on('data', (chunk) => { data += chunk; });
          res.on('end', () => {
            // Accept any non-502 response (endpoint may not exist but proxy should forward)
            expect(res.statusCode).not.toBe(502);
            resolve();
          });
        });

        req.on('error', (err) => {
          reject(err);
        });

        req.setTimeout(5000, () => {
          req.destroy();
          reject(new Error('Timeout'));
        });

        req.write(binaryData);
        req.end();
      });
    });
  });

  describe('Socket.IO Streaming Connection', () => {
    let socket: Socket;

    afterEach((done) => {
      if (socket && socket.connected) {
        socket.disconnect();
      }
      done();
    });

    it('should successfully connect and stream through proxy to ai.jasonmcaffee.com', async () => {
      return new Promise<void>((resolve, reject) => {
        let messageCount = 0;
        let completeResponse = '';

        // Create Socket.IO connection matching AIServiceStreamingChat.ts configuration
        socket = io(`http://${PROXY_HOST}:${PROXY_PORT}`, {
          path: '/socket.io',
          transports: ['websocket'],
          timeout: 15000,
          extraHeaders: {
            'Host': 'ai.jasonmcaffee.com'
          }
        });

        const testTimeout = setTimeout(() => {
          socket.disconnect();
          reject(new Error('Test timeout: No response received after 30 seconds'));
        }, 30000);

        socket.on('connect', () => {
          // Send streamInference request matching the client
          const request = {
            prompt: 'Say hello',
            conversationId: null,
            shouldSearchWeb: false,
            shouldUsePlanTool: false,
            shouldRespondWithAudio: false,
            textToSpeechSpeed: 1.0,
            shouldUseAgentOfAgents: false,
            temperature: 0.7,
            topP: 1.0,
            frequencyPenalty: 0,
            presencePenalty: 0,
            imageUrl: null
          };

          socket.emit('streamInference', request);
        });

        socket.on('connectionSuccess', (data) => {
          // Connection success event received
          expect(data).toBeDefined();
        });

        socket.on('message', (data) => {
          try {
            const jsonData = typeof data === 'string' ? JSON.parse(data) : data;
            messageCount++;

            if (jsonData.text) {
              completeResponse += jsonData.text;
            }

            if (jsonData.textEnd) {
              clearTimeout(testTimeout);
              expect(messageCount).toBeGreaterThan(0);
              expect(completeResponse.length).toBeGreaterThan(0);
              socket.disconnect();
              resolve();
            }

            if (jsonData.statusTopics) {
              // Status topics received
            }
          } catch (error) {
            clearTimeout(testTimeout);
            socket.disconnect();
            reject(error);
          }
        });

        socket.on('error', (error) => {
          clearTimeout(testTimeout);
          socket.disconnect();
          reject(error);
        });

        socket.on('connect_error', (error) => {
          clearTimeout(testTimeout);
          socket.disconnect();
          reject(new Error(`Connection error: ${error.message}`));
        });

        socket.on('disconnect', (reason) => {
          if (reason !== 'io client disconnect') {
            clearTimeout(testTimeout);
            reject(new Error(`Unexpected disconnect: ${reason}`));
          }
        });
      });
    }, 35000);
  });
});

