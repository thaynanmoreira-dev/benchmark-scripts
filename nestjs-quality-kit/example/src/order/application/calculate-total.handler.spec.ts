import { NotFoundException } from '@nestjs/common';

import { Order } from '../domain/order';
import { CalculateTotalHandler } from './calculate-total.handler';
import { CalculateTotalQuery } from './calculate-total.query';
import type { OrderRepository } from './order.repository';

describe('CalculateTotalHandler', () => {
  const order = new Order('o1', [{ sku: 'a', quantity: 2, unitPriceCents: 150 }]);
  const repository = (found: Order | null): OrderRepository => ({
    byId: () => Promise.resolve(found),
  });

  it('returns the discounted total of the order it found', async () => {
    const handler = new CalculateTotalHandler(repository(order));
    await expect(handler.execute(new CalculateTotalQuery('o1', 10))).resolves.toBe(270);
  });

  it('complains about a missing order, with the right message', async () => {
    const handler = new CalculateTotalHandler(repository(null));
    await expect(handler.execute(new CalculateTotalQuery('gone', 0))).rejects.toThrow(
      new NotFoundException('order gone not found'),
    );
  });
});
