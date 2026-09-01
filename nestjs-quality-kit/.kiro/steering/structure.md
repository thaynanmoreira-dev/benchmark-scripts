---
inclusion: fileMatch
fileMatchPattern: 'src/**/*.ts'
---
# Simplified Clean Architecture with CQRS

One folder per business module, four layers inside it:

```
src/<module>/
  domain/           entities, value objects, business rules
  application/      command and query handlers, ports (abstract classes)
  infrastructure/   repositories, HTTP clients, queue producers and consumers
  interface/        REST controllers, queue consumers
  <module>.module.ts  the wiring: who implements which port
```

## Dependency direction

`npm run arch` fails on violations, so this is not a convention — it is a gate:

- **domain** imports nothing. No other layer, no NestJS, no ORM, no queue client.
  An entity that depends on a framework cannot be tested without booting the
  framework, and that is how a suite becomes slow and brittle.
- **application** imports `domain`. It declares the **port** (an abstract class,
  not an interface — Nest needs a token that survives type erasure) and depends
  on that, never on the implementation.
- **infrastructure** imports `domain` and `application`, and implements the ports.
- **interface** imports `application` and `domain`. Nothing on the inside imports
  `interface`.
- An import cycle is an error. If one appeared, somebody crossed the boundary in
  both directions.

## CQRS

- A command changes state and returns little. A query reads and changes nothing.
- One class per use case: `<verb>-<noun>.command.ts` with its handler beside it.
  A handler that does two things is two handlers.
- Handlers know nothing about HTTP or the queue message format — the `interface`
  layer does the translating.

## Where things live

- A rule that holds regardless of who called → `domain`.
- Step orchestration, transactions, event publishing → `application`.
- SQL, Mongo queries, Redis keys, queue topics, retries → `infrastructure`.
- DTOs with `class-validator`, routes, headers, status codes → `interface`.

When torn between `domain` and `application`: if the rule stays true in a system
with no database and no queue, it is `domain`.
