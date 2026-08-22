# Proxy Service

A native Rust reverse proxy that routes Cloudflare traffic to local services by host and path while preserving streaming, byte ranges, uploads, SSE, Socket.IO polling, and WebSocket upgrades.

## Production implementation

The production implementation is the Rust `proxy_rs.node` native module, built from this Cargo project and hosted by the machine's firewall-authorized Node executable. The prior NestJS implementation remains in `src/**/*.ts` as rollback/reference code.

```powershell
cargo build --release --bins --lib
Copy-Item .\target\release\proxy_rs.dll .\target\release\proxy_rs.node
$env:PORT = '18080'
node .\native-host.cjs
```

Node loads the module and keeps its background Tokio runtime alive; it does not accept sockets or
process request data. The listener, HTTP parsing, routing, header policy, streaming, upgrades,
observability, and failure handling remain entirely in Rust. This arrangement uses the existing
inbound firewall grant without an extra TCP relay or broader firewall permissions.

Operational endpoints are deliberately loopback-only:

- `GET /__proxy/health` — version and uptime.
- `GET /__proxy/ready` — validated listener/configuration readiness.
- `GET /__proxy/socket-stats` — active HTTP and upgraded connection counts.
- `GET /__proxy/metrics` — Prometheus text metrics.

Use `cargo run --release --bin ab_compare` with `BASELINE_URL` and `CANDIDATE_URL` for safe response-parity checks. Use `cargo run --release --bin proxy_bench` with `BENCH_URL`, `BENCH_HOST`, `BENCH_REQUESTS`, and `BENCH_CONCURRENCY` for repeatable load probes.

## Overview

This service receives HTTP/1.1 from Cloudflare after TLS termination and forwards each request to a configured loopback service. Hyper streams bodies with backpressure and tunnels upgrades without parsing application frames.

## Architecture

```
Internet → Cloudflare DNS → Your Server IP → Proxy Service → Local Services
```

### Domain Routing

The Rust router evaluates segment-aware special paths first: `/ai-api` strips its prefix to the AI backend, `/news` reaches the AI backend unchanged, `media.../m` rewrites to Phone Sync `/public`, and `media.../s` rewrites to the AI backend's `/social/public-media`. AI-host `/socket.io` polling/upgrades also go directly to the AI backend. Host routing then selects AI UI `:7070`, personal site `:3200`, media UI `:3300`, Plex `:32400`, Git `:3000`, Phone Sync `:7071`, Chordical API `:4500`, or Chordical UI `:3100`.

- **ai.jasonmcaffee.com** → `localhost:7070` (AI Studio UI), except `/ai-api/*` and
  `/socket.io/*`, which route to the AI backend on `localhost:8091`
- **plex.jasonmcaffee.com** → `localhost:32400` (Plex Media Server)
- **git.jasonmcaffee.com** → `localhost:3000` (Gitea — local GitHub, `D:\dev\local-github`)
- **phone.jasonmcaffee.com** → `localhost:7071` (Phone Sync — phone photo/video backup, `C:\jason\dev\phone-sync`)
- **media.jasonmcaffee.com** → `localhost:3300` (Selects — the public photo/film site,
  `C:\jason\devi-service\media-site`), except **`/m/*`**, which is rewritten to
  `localhost:7071/public/*` so published photographs and video byte ranges are served straight
  from Phone Sync and never pass through the site's Node process. That prefix only means this on
  this one host; `/m/...` anywhere else is routed normally.
- **jasonmcaffee.com** / **www.jasonmcaffee.com** (and any unrouted subdomain) → `localhost:3200`
  (Jason McAffee personal site — Next.js, `C:jasondevai-servicejasonmcaffee-site`)

  This default used to be `localhost:8080`, which is **llama-server**: until task-1559 the domain
  answered `https://jasonmcaffee.com/v1/models` with the local model list and an open completion
  endpoint, unauthenticated, from the public internet. Pointing the default at the personal site
  closes that.

Request and response bodies stream with backpressure and no whole-body buffering. Upstream connects
are capped at 5 seconds, Plex response headers at 30 seconds, and upgraded connections at 15 idle
minutes. Ordinary HTTP streams remain governed by client/upstream lifecycle rather than an arbitrary
response deadline.

### Legacy Node socket guard (rollback reference)

"No request timeout" used to mean "no bound at all", and that cost the box 54 GB of RAM. On
2026-08-16 it sat at 123 of 127.5 GB while every process working set summed to only 54 GB: the rest
was kernel nonpaged pool tagged `AfdB` — Winsock socket buffers — held by this proxy's connections
to a Phone Sync instance that had been replaced. Restarting the proxy freed all of it at once.

Every proxied stream, HTTP and raw WebSocket tunnel alike, is now watched:

| Mechanism | What it catches |
|---|---|
| TCP keepalive on every socket, 60s idle | a peer that vanished without an RST (a phone that left the network) — Windows' own default is two hours |
| Stall reaper, 2 min | bytes not moving *and* one side holding data the other is not draining — the leak's exact signature |
| Idle reaper, 15 min | a pair that is simply abandoned; deliberately generous so a quiet SSE or socket.io stream is never cut |
| Upstream destroyed on a truncated response | http-proxy only reacts to an explicit client abort; every other way a response ends used to leave the upstream open and unread |
| Bounded upstream agent (512 sockets/origin, keep-alive) | replaces Node's unbounded global agent, so tens of thousands of concurrent upstream sockets are unreachable |

A reaped pair is closed with an RST rather than a FIN, because a FIN leaves the peer half-open with
its queue intact — which is the state being reaped in the first place.

Activity is measured by polling `bytesRead`/`bytesWritten` on one shared sweep timer, never by
attaching a `'data'` listener: that would flip a paused socket into flowing mode and destroy the
backpressure that makes streaming correct.

Tunables (all optional, defaults above): `PROXY_SOCKET_KEEPALIVE_MS`, `PROXY_SOCKET_IDLE_TIMEOUT_MS`,
`PROXY_SOCKET_STALL_TIMEOUT_MS`, `PROXY_SOCKET_STALL_BUFFERED_BYTES`, `PROXY_SOCKET_SWEEP_INTERVAL_MS`,
`PROXY_MAX_UPSTREAM_SOCKETS`, `PROXY_MAX_FREE_UPSTREAM_SOCKETS`.

`GET http://127.0.0.1/__proxy/socket-stats` reports open pairs, the oldest of them, and the reap
counters. It answers **loopback callers only** — the proxy fronts real public hostnames, so any other
caller is proxied normally and the path behaves as if the route did not exist.

The Rust implementation replaces these JavaScript listener guards with owned connection permits,
bounded per-origin pools, TCP keepalive, backpressured body streams, upgrade idle timeouts, and
drop-based accounting. The historical description above documents the rollback implementation and
the leak that the Rust resource limits must continue to prevent.

## Legacy TypeScript implementation (rollback reference)

### 1. Core Framework
- **Node.js** with **TypeScript** for type safety and modern JavaScript features
- **NestJS** as the web framework for handling HTTP requests and WebSocket connections
- **http-proxy-middleware** for proxying requests to local services

### 2. Request Flow
1. Request arrives at the proxy service
2. Service extracts the `Host` header to determine the domain
3. Based on domain rules, request is forwarded to appropriate local service
4. Response from local service is returned to the client

### 3. Domain Resolution Logic
```typescript
if (host === 'ai.jasonmcaffee.com') {
  // Forward to localhost:7070 (AI Studio UI)
} else if (host === 'plex.jasonmcaffee.com') {
  // Forward to localhost:32400 (Plex)
} else if (host.endsWith('jasonmcaffee.com')) {
  // Forward to localhost:3200 (personal site)
} else {
  // Return 404 or default behavior
}
```

## Project Structure

```
proxy/
├── src/
│   ├── main.ts           # Main entry point
│   ├── app.module.ts     # NestJS root module
│   ├── proxy/            # Proxy module
│   │   ├── proxy.controller.ts
│   │   ├── proxy.service.ts
│   │   └── proxy.gateway.ts
│   ├── middleware/       # Custom middleware
│   └── types/           # TypeScript type definitions
├── package.json
├── tsconfig.json
├── .env                  # Environment variables
└── README.md
```

## Dependencies

### Core Dependencies
- `@nestjs/core` - NestJS core framework
- `@nestjs/common` - NestJS common utilities
- `@nestjs/platform-express` - Express platform for NestJS
- `@nestjs/websockets` - WebSocket support
- `@nestjs/platform-socket.io` - Socket.io platform
- `http-proxy-middleware` - HTTP proxying
- `cors` - Cross-origin resource sharing
- `helmet` - Security headers

### Development Dependencies
- `typescript` - TypeScript compiler
- `@types/node` - Node.js type definitions
- `nodemon` - Development server with auto-reload
- `ts-node` - TypeScript execution

## Configuration

### Environment Variables
```env
PORT=80                      # Port for proxy service (requires root/admin)
NEXTJS_TARGET=http://localhost:3200
NESTJS_TARGET=http://localhost:8081
PLEX_TARGET=http://localhost:32400
```

### Proxy Targets
- **Personal site (Next.js)**: `http://localhost:3200`
- **NestJS Server**: `http://localhost:8081`
- **Plex Media Server**: `http://localhost:32400`

## Features

### 1. Domain-Based Routing
- Automatic routing based on `Host` header
- Support for subdomain routing
- Fallback handling for unknown domains

### 2. Request/Response Handling
- Preserve original request headers
- Handle CORS appropriately
- Console logging for every incoming request
- WebSocket support for real-time communication

### 3. Error Handling
- Graceful fallbacks for service unavailability
- Proper HTTP status codes
- Error logging

### 4. Security
- Security headers via Helmet
- Request validation
- Rate limiting (optional)

## Development Workflow

1. **Setup**: Install dependencies and configure environment
2. **Development**: Use nodemon for auto-reload during development
3. **Testing**: Test with different domain configurations
4. **Deployment**: Build and deploy to production server

## Deployment Considerations

### Production Setup
- Use PM2 or similar process manager
- Configure as a systemd service
- Set up proper logging
- Configure firewall rules

### SSL/TLS
- Handle HTTPS termination at the proxy level
- Forward to local services over HTTP
- Configure SSL certificates for domains

## Monitoring & Logging

- Request/response logging
- Performance metrics
- Error tracking
- Health check endpoints

## Future Enhancements

- Load balancing between multiple instances
- Health checks for backend services
- Metrics collection (Prometheus)
- Circuit breaker pattern for service resilience
- Caching layer for static assets

## Getting Started

1. Clone the repository
2. Install dependencies: `npm install`
3. Configure environment variables
4. Start development server: `npm run dev`
5. Test with different domain configurations

## Testing

Test the proxy with:
```bash
# Test ai.jasonmcaffee.com routing
curl -H "Host: ai.jasonmcaffee.com" http://localhost/

# Test plex.jasonmcaffee.com routing
curl -H "Host: plex.jasonmcaffee.com" http://localhost/

# Test jasonmcaffee.com routing
curl -H "Host: jasonmcaffee.com" http://localhost/

# Test other subdomain routing
curl -H "Host: blog.jasonmcaffee.com" http://localhost/
```

## Implementation Notes

- **Port 80**: Service runs on port 80 (requires root/admin privileges)
- **Console Logging**: Every incoming request is logged to console
- **WebSocket Support**: Full WebSocket support via NestJS WebSocket Gateway
- **No Rate Limiting**: Rate limiting is not implemented
- **No Health Checks**: Health check endpoints are not included
- **No Caching**: Request caching is not implemented
