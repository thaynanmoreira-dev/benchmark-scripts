import { Order } from './order';

describe('Order', () => {
  const item = { sku: 'a', quantity: 2, unitPriceCents: 150 };

  it('sums the items in cents', () => {
    expect(new Order('o1', [item]).totalCents()).toBe(300);
  });

  it('rejects an empty order, with the right message', () => {
    expect(() => new Order('o1', [])).toThrow(new RangeError('an order needs at least one item'));
  });

  it('applies the discount', () => {
    expect(new Order('o1', [item]).withDiscount(10)).toBe(270);
  });

  it('accepts both ends of the discount range', () => {
    expect(new Order('o1', [item]).withDiscount(0)).toBe(300);
    expect(new Order('o1', [item]).withDiscount(100)).toBe(0);
  });

  it('rejects a percent out of range, with the right message', () => {
    const order = new Order('o1', [item]);
    expect(() => order.withDiscount(-1)).toThrow(new RangeError('percent out of range'));
    expect(() => order.withDiscount(101)).toThrow(new RangeError('percent out of range'));
  });
});
