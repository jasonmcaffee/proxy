import { Module } from '@nestjs/common';
import { ProxyController } from './proxy.controller';
import { ProxyService } from './proxy.service';
import { ProxyGateway } from './proxy.gateway';

@Module({
  controllers: [ProxyController],
  providers: [ProxyService, ProxyGateway],
})
export class ProxyModule {}


