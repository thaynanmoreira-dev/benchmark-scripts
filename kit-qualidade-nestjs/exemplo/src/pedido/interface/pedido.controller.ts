import { Controller, Get, Param, Query } from '@nestjs/common';
import { QueryBus } from '@nestjs/cqrs';

import { CalcularTotalQuery } from '../application/calcular-total.query';

@Controller('pedidos')
export class PedidoController {
  constructor(private readonly queryBus: QueryBus) {}

  @Get(':id/total')
  async total(
    @Param('id') id: string,
    @Query('desconto') desconto?: string,
  ): Promise<{ totalCentavos: number }> {
    const percentual = desconto === undefined ? 0 : Number(desconto);
    const totalCentavos = await this.queryBus.execute<CalcularTotalQuery, number>(
      new CalcularTotalQuery(id, percentual),
    );
    return { totalCentavos };
  }
}
