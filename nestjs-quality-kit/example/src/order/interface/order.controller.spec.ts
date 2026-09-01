import type { QueryBus } from '@nestjs/cqrs';

import { CalculateTotalQuery } from '../application/calculate-total.query';
import { OrderController } from './order.controller';

/**
 * `QueryBus.execute` has four overloads; matching the signature by hand just to
 * avoid the cast would mean inventing a port whose only purpose is to please the
 * linter. That is why the `unknown` and type-assertion rules are off in specs
 * only — see the note about test doubles in the kit README.
 */
describe('OrderController', () => {
  const bus = (): { queryBus: QueryBus; received: CalculateTotalQuery[] } => {
    const received: CalculateTotalQuery[] = [];
    const queryBus = {
      execute: (query: CalculateTotalQuery) => {
        received.push(query);
        return Promise.resolve(270);
      },
    } as unknown as QueryBus;
    return { queryBus, received };
  };

  it('passes id and discount through to the query', async () => {
    const { queryBus, received } = bus();
    await expect(new OrderController(queryBus).total('o1', '10')).resolves.toEqual({
      totalCents: 270,
    });
    expect(received).toEqual([new CalculateTotalQuery('o1', 10)]);
  });

  it('defaults the discount to zero when the query string omits it', async () => {
    const { queryBus, received } = bus();
    await new OrderController(queryBus).total('o1');
    expect(received).toEqual([new CalculateTotalQuery('o1', 0)]);
  });
});
