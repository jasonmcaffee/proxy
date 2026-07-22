import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { ProxyService } from './proxy/proxy.service';
import * as dotenv from 'dotenv';
import * as http from 'http';

async function bootstrap() {
  // Load environment variables
  dotenv.config();

  // Disable body parsing — this service is a pure pass-through proxy, so leaving
  // the raw request stream intact lets http-proxy-middleware pipe it cleanly.
  // (Default Nest body parser breaks socket.io polling POSTs by replacing the
  // engine.io packet body with `[object Object]`.)
  const app = await NestFactory.create(AppModule, { bodyParser: false });

  // Enable CORS
  app.enableCors();

  // Get port from environment or default to 80
  const port = 80;

  // task-632: one startup line instead of eight. Targets are configuration, not per-run news.
  const targets = [
    `next=${process.env.NEXTJS_TARGET || 'http://localhost:8082'}`,
    `ai=${process.env.AI_TARGET || 'http://localhost:7070'}`,
    `ai-api=${process.env.AI_SERVICE_TARGET || 'http://localhost:8081'}`,
    `media=${process.env.MEDIA_TARGET || 'http://localhost:5010'}`,
    `plex=${process.env.PLEX_TARGET || 'http://localhost:32400'}`,
    `chordical=${process.env.CHORDICAL_TARGET || 'http://localhost:4500'}`,
    `git=${process.env.GIT_TARGET || 'http://localhost:3000'}`,
  ].join(' ');
  console.log(`Proxy starting on port ${port} | ${targets}`);

  await app.listen(port);

  // Route raw WebSocket upgrades (non-socket.io) through a transparent TCP tunnel.
  // Socket.io upgrades on /socket.io are handled by the NestJS WebSocket gateway.
  const proxyService = app.get(ProxyService);
  const httpServer = app.getHttpServer() as http.Server;

  httpServer.on('upgrade', (req: http.IncomingMessage, socket: any, head: Buffer) => {
    proxyService.handleWsUpgrade(req, socket, head);
  });

  console.log(`Proxy service running on port ${port}`);
}

bootstrap();


