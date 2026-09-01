---
inclusion: always
---
# Context for this service

<!--
  TEMPLATE — fill in the three sections below and delete these comments.

  This is the only file in the kit that describes YOUR domain. It is loaded on
  every interaction, so it is worth writing well and keeping short: every line
  here enters every prompt and costs on every task.

  What matters here is not describing the product to a human. It is telling the
  agent the things it would get wrong because it has no way to guess them. Two
  questions help find what to write:

    1. What would a new developer break in their first week for not knowing?
    2. What has already caused an incident here more than once?
-->

## What this service does

<!--
  Two or three sentences, in business language. Who consumes it, what goes in,
  what comes out, and what happens when it is wrong. For example:

  "Calculates the instalment plan offered at checkout and reconciles what was
  settled against the acquirer statement. Consumed by the app and the back
  office. A bug here is not a UI glitch: it is a double charge or a statement
  that does not balance."
-->

TODO: describe the service.

## Invariants that never change

<!--
  The invariants that hold for ALL code in this repository, with the practical
  consequence. Three to five items; more than that and nobody remembers.

  Write the rule AND what it forbids, because the prohibition is the actionable
  half. Examples of the shape:

  1. **Money is whole cents, as an integer.** Never `float` for money, never
     `toFixed` to round it. When a total is split, the rounding leftover has an
     explicit destination and the parts add back up to the whole.
  2. **Input errors are typed results, not control-flow exceptions.** Validation
     returns a failure; exceptions are for what is genuinely exceptional.
  3. **Queue handlers are idempotent.** Delivery happens more than once. If a
     handler cannot tolerate redelivery, that is stated in the PR, not left
     implicit.
-->

TODO: list the domain invariants.

## Permanently out of scope

<!--
  What this service deliberately does NOT do, so the agent does not "complete"
  the design on its own. For example: "exposes no public endpoint — only the BFF
  calls it"; "stores no card data".
-->

TODO: list what this service does not do.

## How to work with me

<!-- This section is generic and works for any project. Keep it as it is. -->

- Finish the whole task. "I implemented the main part, the test is missing" is
  not a delivery — the gates in `gates.md` decide when it is done.
- Do not invent scope. When the request is ambiguous, take the narrowest reading,
  record the assumption and move on; do not widen the scope to cover the doubt.
- Ask early and once. Round trips cost time and usage budget.
