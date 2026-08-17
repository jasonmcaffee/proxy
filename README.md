# Proxy Service

A TypeScript Node.js reverse proxy service that routes traffic to different local services based on domain names.

## Overview

This service acts as a reverse proxy that receives HTTP requests and forwards them to appropriate local services based on the domain name. It's designed to work with Cloudflare DNS management where A records point to your server's IP address.

## Architecture

```
Internet → Cloudflare DNS → Your Server IP → Proxy Service → Local Services
```

### Domain Routing

- **ai.jasonmcaffee.com** → `localhost:8081` (NestJS server)
- **plex.jasonmcaffee.com** → `localhost:32400` (Plex Media Server)
- **git.jasonmcaffee.com** → `localhost:3000` (Gitea — local GitHub, `D:\dev\local-github`)
- **phone.jasonmcaffee.com** → `localhost:7071` (Phone Sync — phone photo/video backup, `C:\jason\dev\phone-sync`)
- **jasonmcaffee.com** / **www.jasonmcaffee.com** (and any unrouted subdomain) → `localhost:3200`
  (Jason McAffee personal site — Next.js, `C:jasondevai-servicejasonmcaffee-site`)

  This default used to be `localhost:8080`, which is **llama-server**: until task-1559 the domain
  answered `https://jasonmcaffee.com/v1/models` with the local model list and an open completion
  endpoint, unauthenticated, from the public internet. Pointing the default at the personal site
  closes that.

Hosts that stream or carry long uploads (`ai`, `chordical`, `git`, `phone`) are proxied with no
request timeout; everything else is capped at 30s.

### Socket guard (task-1556)

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

## Technical Approach

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

---

**Note**: This README outlines the technical approach. Please review and approve before we proceed with implementation.
