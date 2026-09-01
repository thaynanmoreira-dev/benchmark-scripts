import { Injectable } from '@nestjs/common';

import { PedidoRepositorio } from '../application/pedido.repositorio';
import { Pedido } from '../domain/pedido';

/** Adaptador. Em producao seria Postgres ou Mongo; o contrato e o mesmo. */
@Injectable()
export class PedidoRepositorioMemoria extends PedidoRepositorio {
  private readonly pedidos = new Map<string, Pedido>();

  guardar(pedido: Pedido): void {
    this.pedidos.set(pedido.id, pedido);
  }

  porId(id: string): Promise<Pedido | null> {
    return Promise.resolve(this.pedidos.get(id) ?? null);
  }
}
