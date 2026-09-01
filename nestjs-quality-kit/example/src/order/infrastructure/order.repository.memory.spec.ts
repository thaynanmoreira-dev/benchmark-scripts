import { Order } from '../domain/order';
import { InMemoryOrderRepository } from './order.repository.memory';

describe('InMemoryOrderRepository', () => {
  const order = new Order('o1', [{ sku: 'a', quantity: 1, unitPriceCents: 100 }]);

  it('returns the order it stored', async () => {
    const repo = new InMemoryOrderRepository();
    repo.save(order);
    await expect(repo.byId('o1')).resolves.toBe(order);
  });

  it('returns null for an unknown id', async () => {
    await expect(new InMemoryOrderRepository().byId('gone')).resolves.toBeNull();
  });
});
