---
inclusion: manual
name: grill
description: Interrogates the request and pins the non-goals before any code.
---
# Negative scope

Before any code, answer each item in one line:

1. What the task asks for, in your own words.
2. The **non-goals** of this task: what would be reasonable to do alongside it
   and you are **not** doing.
3. The design decision you are about to make, with your recommendation first.

Only then write code. Where something is ambiguous, take the narrowest reading,
record the assumption and move on. Do not widen the scope to cover the doubt.

## Permanent non-goals for this repository

Never do any of these without being asked, however much they look like an
improvement:

- Add an endpoint, route, response field or flag the task did not ask for.
- Swap a library, ORM, queue client or dependency version.
- Refactor neighbouring code the task did not mention, including "just tidying".
- Add caching, retries, a circuit breaker or a queue where there was none.
- Create a database migration alongside a change that did not call for one.
- Add logs, metrics or tracing "to help with debugging".
- Create a README, ADR, block comment or changelog nobody asked for.
- Generalise for a case that does not exist today. An abstraction over one case
  is debt.

If you believe one of these is necessary, **say so and wait**. It counts as a
recommendation at the end of the delivery, never as code that came along for the
ride.
