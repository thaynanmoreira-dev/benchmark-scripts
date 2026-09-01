import { Module } from '@nestjs/common';

import { PedidoModule } from './pedido/pedido.module';

@Module({ imports: [PedidoModule] })
export class AppModule {}
