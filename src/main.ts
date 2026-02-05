import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import * as dotenv from 'dotenv';

async function bootstrap() {
  // Load environment variables
  dotenv.config();

  const app = await NestFactory.create(AppModule);

  // Enable CORS
  app.enableCors();

  // Get port from environment or default to 80
  const port = 80;

  console.log(`🚀 Proxy service starting on port ${port}...`);
  console.log(`📡 NextJS target: ${process.env.NEXTJS_TARGET || 'http://localhost:8080'}`);
  console.log(`📡 NestJS target: ${process.env.NESTJS_TARGET || 'http://localhost:8081'}`);
  console.log(`📡 Plex target: ${process.env.PLEX_TARGET || 'http://localhost:32400'}`);

  await app.listen(port);

  console.log(`✅ Proxy service running on port ${port}`);
}

bootstrap();


