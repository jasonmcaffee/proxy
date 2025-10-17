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
- **jasonmcaffee.com** (and all other subdomains) → `localhost:8080` (Next.js server)

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
  // Forward to localhost:8081 (NestJS)
} else if (host === 'plex.jasonmcaffee.com') {
  // Forward to localhost:32400 (Plex)
} else if (host.endsWith('jasonmcaffee.com')) {
  // Forward to localhost:8080 (Next.js)
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
NEXTJS_TARGET=http://localhost:8080
NESTJS_TARGET=http://localhost:8081
PLEX_TARGET=http://localhost:32400
```

### Proxy Targets
- **Next.js Server**: `http://localhost:8080`
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
