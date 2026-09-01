import { Injectable } from '@nestjs/common';

import { OrderRepository } from '../application/order.repository';
import { Order } from '../domain/order';

/** Adapter. In production this would be Postgres or Mongo; the contract is the same. */
@Injectable()
export class InMemoryOrderRepository extends OrderRepository {
  private readonly orders = new Map<string, Order>();

  save(order: Order): void {
    this.orders.set(order.id, order);
  }

  byId(id: string): Promise<Order | null> {
    return Promise.resolve(this.orders.get(id) ?? null);
  }
}
