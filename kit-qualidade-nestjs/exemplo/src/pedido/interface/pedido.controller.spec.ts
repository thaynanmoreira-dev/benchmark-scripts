import type { QueryBus } from '@nestjs/cqrs';

import { CalcularTotalQuery } from '../application/calcular-total.query';
import { PedidoController } from './pedido.controller';

/**
 * `QueryBus.execute` tem quatro sobrecargas; casar a assinatura a mao para
 * evitar o cast exigiria uma porta so para agradar o linter. Por isso as regras
 * de `unknown` e de asserção de tipo valem so em producao — ver a nota sobre
 * dubles no README do kit.
 */
describe('PedidoController', () => {
  const barramento = (): { bus: QueryBus; recebidas: CalcularTotalQuery[] } => {
    const recebidas: CalcularTotalQuery[] = [];
    const bus = {
      execute: (query: CalcularTotalQuery) => {
        recebidas.push(query);
        return Promise.resolve(270);
      },
    } as unknown as QueryBus;
    return { bus, recebidas };
  };

  it('repassa id e desconto para a query', async () => {
    const { bus, recebidas } = barramento();
    await expect(new PedidoController(bus).total('p1', '10')).resolves.toEqual({
      totalCentavos: 270,
    });
    expect(recebidas).toEqual([new CalcularTotalQuery('p1', 10)]);
  });

  it('sem desconto na querystring, aplica zero', async () => {
    const { bus, recebidas } = barramento();
    await new PedidoController(bus).total('p1');
    expect(recebidas).toEqual([new CalcularTotalQuery('p1', 0)]);
  });
});
