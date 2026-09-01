import { NotFoundException } from '@nestjs/common';

import { Pedido } from '../domain/pedido';
import { CalcularTotalHandler } from './calcular-total.handler';
import { CalcularTotalQuery } from './calcular-total.query';
import type { PedidoRepositorio } from './pedido.repositorio';

describe('CalcularTotalHandler', () => {
  const pedido = new Pedido('p1', [{ sku: 'a', quantidade: 2, precoUnitarioCentavos: 150 }]);
  const repositorio = (achado: Pedido | null): PedidoRepositorio => ({
    porId: () => Promise.resolve(achado),
  });

  it('devolve o total com desconto do pedido encontrado', async () => {
    const handler = new CalcularTotalHandler(repositorio(pedido));
    await expect(handler.execute(new CalcularTotalQuery('p1', 10))).resolves.toBe(270);
  });

  it('reclama de pedido inexistente, com a mensagem certa', async () => {
    const handler = new CalcularTotalHandler(repositorio(null));
    await expect(handler.execute(new CalcularTotalQuery('sumido', 0))).rejects.toThrow(
      new NotFoundException('pedido sumido nao encontrado'),
    );
  });
});
