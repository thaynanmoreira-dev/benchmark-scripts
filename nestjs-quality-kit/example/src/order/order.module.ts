import { Module } from '@nestjs/common';
import { CqrsModule } from '@nestjs/cqrs';

import { CalculateTotalHandler } from './application/calculate-total.handler';
import { OrderRepository } from './application/order.repository';
import { InMemoryOrderRepository } from './infrastructure/order.repository.memory';
import { OrderController } from './interface/order.controller';

@Module({
  imports: [CqrsModule],
  controllers: [OrderController],
  providers: [
    CalculateTotalHandler,
    { provide: OrderRepository, useClass: InMemoryOrderRepository },
  ],
})
export class OrderModule {}
