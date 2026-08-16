import { Module } from '@nestjs/common';
import { ProxyController } from './proxy.controller';
import { ProxyService } from './proxy.service';
import { ProxyGateway } from './proxy.gateway';
import { RequestLoggerService } from './requestLogger.service';
import { SocketGuardService } from './socketGuard.service';

@Module({
  controllers: [ProxyController],
  providers: [ProxyService, ProxyGateway, RequestLoggerService, SocketGuardService],
})
export class ProxyModule {}


