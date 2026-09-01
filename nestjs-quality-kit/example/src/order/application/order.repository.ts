import type { Order } from '../domain/order';

/**
 * The port. Its implementation lives in `infrastructure`, and the inversion
 * happens right here: `application` declares the contract, `infrastructure`
 * obeys it. An abstract class rather than an interface because Nest needs a
 * dependency-injection token that survives type erasure.
 */
export abstract class OrderRepository {
  abstract byId(id: string): Promise<Order | null>;
}
