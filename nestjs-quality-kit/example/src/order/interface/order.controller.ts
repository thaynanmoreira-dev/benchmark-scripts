import { Controller, Get, Param, Query } from '@nestjs/common';
import { QueryBus } from '@nestjs/cqrs';

import { CalculateTotalQuery } from '../application/calculate-total.query';

@Controller('orders')
export class OrderController {
  constructor(private readonly queryBus: QueryBus) {}

  @Get(':id/total')
  async total(
    @Param('id') id: string,
    @Query('discount') discount?: string,
  ): Promise<{ totalCents: number }> {
    const percent = discount === undefined ? 0 : Number(discount);
    const totalCents = await this.queryBus.execute<CalculateTotalQuery, number>(
      new CalculateTotalQuery(id, percent),
    );
    return { totalCents };
  }
}
