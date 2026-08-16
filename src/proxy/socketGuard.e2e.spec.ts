import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import * as http from 'http';
import * as net from 'net';
import { ProxyModule } from './proxy.module';
import { ProxyService } from './proxy.service';
import { SocketGuardService } from './socketGuard.service';

/**
 * Proves the task-1556 fix against a real proxy and a real streaming upstream: a client that stops
 * reading mid-stream must have its upstream connection destroyed, rather than left open for the
 * kernel to buffer into indefinitely.
 *
 * The guard's timeouts are shrunk via environment variables before the module is built, because the
 * production values (2 minutes stalled, 15 minutes idle) are deliberately generous.
 */
describe('SocketGuard (e2e)', () => {
  jest.setTimeout(60_000);

  let app: INestApplication;
  let upstream: http.Server;
  let proxyPort: number;
  let guard: SocketGuardService;
  /** Sockets the fake upstream has accepted, so the test can assert they were closed. */
  let upstreamSockets: net.Socket[];
  /** How many of those the proxy has since closed (EOF received, or fully torn down). */
  let upstreamClosed: number;

  beforeAll(async () => {
    process.env.PROXY_SOCKET_SWEEP_INTERVAL_MS = '250';
    process.env.PROXY_SOCKET_STALL_TIMEOUT_MS = '1500';
    process.env.PROXY_SOCKET_IDLE_TIMEOUT_MS = '4000';
    process.env.PROXY_SOCKET_STALL_BUFFERED_BYTES = '1';

    upstream = await startStreamingUpstream((socket) => {
      upstreamSockets.push(socket);
      // 'end' is the proof the proxy closed its half; a raw tunnel peer stays half-open after that
      // until its own application closes, which a real upstream does and this fake deliberately
      // does not.
      socket.once('end', () => upstreamClosed++);
      socket.once('close', () => upstreamClosed++);
      socket.on('error', () => {});
    });
    const upstreamPort = (upstream.address() as net.AddressInfo).port;
    process.env.NEXTJS_TARGET = `http://127.0.0.1:${upstreamPort}`;
    process.env.AI_TARGET = `http://127.0.0.1:${upstreamPort}`;

    const moduleFixture: TestingModule = await Test.createTestingModule({ imports: [ProxyModule] }).compile();
    app = moduleFixture.createNestApplication();
    await app.listen(0);
    proxyPort = (app.getHttpServer().address() as net.AddressInfo).port;
    guard = moduleFixture.get(SocketGuardService);
    // The upgrade handler is wired in main.ts, not by Nest, so the tunnel test needs it here too.
    const proxyService = moduleFixture.get(ProxyService);
    (app.getHttpServer() as http.Server).on('upgrade', (req, socket, head) =>
      proxyService.handleWsUpgrade(req, socket as any, head),
    );
  });

  afterAll(async () => {
    await app?.close();
    upstream?.close();
  });

  beforeEach(() => {
    upstreamSockets = [];
    upstreamClosed = 0;
  });

  it('destroys the upstream connection when a client stops reading a stream', async () => {
    const before = guard.stats();

    const client = net.connect(proxyPort, '127.0.0.1');
    // The reaper resets rather than closes gracefully, so a reaped client sees ECONNRESET.
    client.on('error', () => {});
    await once(client, 'connect');
    client.write('GET /stream HTTP/1.1\r\nHost: localhost\r\n\r\n');
    // Read briefly so the stream is genuinely established, then stop reading for good — the state a
    // browser tab leaves behind when it is closed without the connection being reset.
    client.resume();
    await delay(500);
    client.pause();

    await waitFor(() => guard.stats().reapedStalled > before.reapedStalled, 20_000);

    expect(upstreamSockets.length).toBeGreaterThan(0);
    await waitFor(() => upstreamClosed > 0, 10_000);
    client.destroy();
  });

  it('reaps a websocket tunnel that goes completely silent', async () => {
    const before = guard.stats();

    const client = net.connect(proxyPort, '127.0.0.1');
    // The reaper resets rather than closes gracefully, so a reaped client sees ECONNRESET.
    client.on('error', () => {});
    await once(client, 'connect');
    client.write(
      'GET /socket-tunnel HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
        'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n',
    );
    client.resume();

    await waitFor(() => guard.stats().reapedIdle > before.reapedIdle, 20_000);
    expect(upstreamSockets.length).toBeGreaterThan(0);
    await waitFor(() => upstreamClosed > 0, 10_000);
    client.destroy();
  });

  it('releases its tracking when a normal request completes, so idle keep-alive is untouched', async () => {
    const body = await get(`http://127.0.0.1:${proxyPort}/small`);
    expect(body).toBe('ok');
    await waitFor(() => guard.stats().trackedNow === 0, 10_000);
  });
});

/**
 * A fake upstream that answers `/small` immediately, streams without end on any other path, and
 * completes a websocket handshake it then never speaks on again — the silent tunnel the idle reaper
 * is there to catch.
 * @param onSocket - called with every socket the upstream accepts
 */
function startStreamingUpstream(onSocket: (socket: net.Socket) => void): Promise<http.Server> {
  const chunk = Buffer.alloc(256 * 1024, 0x61);
  const server = http.createServer((req, res) => {
    if (req.url === '/small') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('ok');
      return;
    }
    res.writeHead(200, { 'content-type': 'application/octet-stream' });
    const pump = () => {
      while (res.write(chunk)) {
        /* write until the socket pushes back */
      }
      res.once('drain', pump);
    };
    pump();
  });
  server.on('connection', onSocket);
  // Completes the handshake and then never speaks again. The 101 matters: engine.io's own upgrade
  // listener ends any upgrade the proxy has not written to within a second, so without a real
  // handshake the tunnel would be torn down before it could ever look idle.
  server.on('upgrade', (_req, socket) => {
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
        'Sec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK+xOo=\r\n\r\n',
    );
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

/** Resolves once an event fires on an emitter. */
function once(emitter: NodeJS.EventEmitter, event: string): Promise<void> {
  return new Promise((resolve) => emitter.once(event, () => resolve()));
}

/** Resolves after the given number of milliseconds. */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Polls a predicate until it is true or the deadline passes, failing loudly on timeout. */
async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await delay(100);
  }
  throw new Error(`condition not met within ${timeoutMs}ms`);
}

/** Minimal GET helper that reads the whole body as a string. */
function get(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    http
      .get(url, (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (d) => (body += d));
        res.on('end', () => resolve(body));
      })
      .on('error', reject);
  });
}
