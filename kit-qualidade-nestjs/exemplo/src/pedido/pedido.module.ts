import { Module } from '@nestjs/common';
import { CqrsModule } from '@nestjs/cqrs';

import { CalcularTotalHandler } from './application/calcular-total.handler';
import { PedidoRepositorio } from './application/pedido.repositorio';
import { PedidoRepositorioMemoria } from './infrastructure/pedido.repositorio.memoria';
import { PedidoController } from './interface/pedido.controller';

@Module({
  imports: [CqrsModule],
  controllers: [PedidoController],
  providers: [
    CalcularTotalHandler,
    { provide: PedidoRepositorio, useClass: PedidoRepositorioMemoria },
  ],
})
export class PedidoModule {}
