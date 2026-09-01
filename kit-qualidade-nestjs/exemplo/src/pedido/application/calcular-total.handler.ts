import { NotFoundException } from '@nestjs/common';
import { QueryHandler, type IQueryHandler } from '@nestjs/cqrs';

import { PedidoRepositorio } from './pedido.repositorio';
import { CalcularTotalQuery } from './calcular-total.query';

@QueryHandler(CalcularTotalQuery)
export class CalcularTotalHandler implements IQueryHandler<CalcularTotalQuery, number> {
  constructor(private readonly repositorio: PedidoRepositorio) {}

  async execute(query: CalcularTotalQuery): Promise<number> {
    const pedido = await this.repositorio.porId(query.pedidoId);
    if (pedido === null) {
      throw new NotFoundException(`pedido ${query.pedidoId} nao encontrado`);
    }
    return pedido.comDesconto(query.descontoPercentual);
  }
}
