# Contract: main

The example's own contract. It makes the gate pass here, and doubles as a filled
contract next to the blank template that `--new` generates.

## Task

A minimal NestJS service that exercises the kit's fifteen gates over a real use
case: calculating an order total with a discount, across four layers.

Origin: kit README, "O que tem dentro" section

## Facts

- [F1] The order total is summed in whole cents. — source: src/order/domain/order.ts:23
- [F2] The discount rejects a percent outside 0 to 100. — source: src/order/domain/order.spec.ts
- [F3] Reading the total goes through a CQRS query handler. — source: src/order/application/calculate-total.handler.ts

## Assumptions

- [A1] (safe) An in-memory repository is enough for the example; a real service would use a database.
- [A2] (safe) No authentication, because the point of the example is the gates.

## Open questions

- (none)

## Out of scope

- Exposes no real persistence, authentication or observability.
- Does not cover the payment domain beyond what the gates need to be exercised.

## How I will prove it works

- `npm ci && npm run gates` exits zero in a clean room, mutation included.
