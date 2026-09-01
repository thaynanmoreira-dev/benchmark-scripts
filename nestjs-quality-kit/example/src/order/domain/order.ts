export interface OrderItem {
  readonly sku: string;
  readonly quantity: number;
  readonly unitPriceCents: number;
}

/**
 * Domain entity. Knows nothing about Nest, the database, HTTP or queues —
 * which is exactly why `domain` may not import any other layer.
 */
export class Order {
  constructor(
    readonly id: string,
    readonly items: readonly OrderItem[],
  ) {
    if (items.length === 0) {
      throw new RangeError('an order needs at least one item');
    }
  }

  totalCents(): number {
    return this.items.reduce((acc, i) => acc + i.quantity * i.unitPriceCents, 0);
  }

  /** Discount in whole cents. Rounding leftovers stay with the house. */
  withDiscount(percent: number): number {
    if (percent < 0 || percent > 100) {
      throw new RangeError('percent out of range');
    }
    return Math.round(this.totalCents() * (1 - percent / 100));
  }
}
