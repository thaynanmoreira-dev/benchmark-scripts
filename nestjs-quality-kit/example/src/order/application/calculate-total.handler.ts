import { NotFoundException } from '@nestjs/common';
import { QueryHandler, type IQueryHandler } from '@nestjs/cqrs';

import { OrderRepository } from './order.repository';
import { CalculateTotalQuery } from './calculate-total.query';

@QueryHandler(CalculateTotalQuery)
export class CalculateTotalHandler implements IQueryHandler<CalculateTotalQuery, number> {
  constructor(private readonly repository: OrderRepository) {}

  async execute(query: CalculateTotalQuery): Promise<number> {
    const order = await this.repository.byId(query.orderId);
    if (order === null) {
      throw new NotFoundException(`order ${query.orderId} not found`);
    }
    return order.withDiscount(query.discountPercent);
  }
}
