import { Module } from '@nestjs/common';
import { ProxyController } from './proxy.controller';
import { ProxyService } from './proxy.service';
import { ProxyGateway } from './proxy.gateway';
import { RequestLoggerService } from './requestLogger.service';

@Module({
  controllers: [ProxyController],
  providers: [ProxyService, ProxyGateway, RequestLoggerService],
})
export class ProxyModule {}


