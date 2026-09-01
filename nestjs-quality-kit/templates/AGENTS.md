# Instructions for agents

Read by Claude Code, Codex, Cursor and others. Kiro reads the same rules in finer
grain under `.kiro/steering/`; this file is the executable summary for everything
else. Keep it short: it enters every iteration.

## Commands

```bash
bin/setup           from nothing to running, idempotent
npm run gates:fast  seconds — run on every change
npm run gates       adds mutation testing, minutes — before handing back
npm run format      the formatter decides the style
npm test            tests with coverage
```

## Definition of done

The task ends when `npm run gates` exits zero. Not before, and not "done but the
test is missing". Run it yourself before handing back.

## Non-negotiable rules

- **Never switch a gate off.** No `eslint-disable`, `@ts-ignore`, `istanbul
  ignore`, `Stryker disable`, `prettier-ignore`, `as any`, `it.skip`. Do not edit
  the gate configuration files either. `npm run no-bypass` fails on any increase,
  and `npm run gates-intact` fails when a rule is deleted, so working around them
  does not turn the build green.
- **Zero `any`, `unknown` and `as` assertions in production.** External data
  enters validated at runtime: a DTO with `class-validator` over HTTP, a schema
  for queues and webhooks.
- **Functions of 4 to 20 lines, at most two levels of indentation.**
- **Greppable names.** If searching for the name returns irrelevant results,
  rename it.
- **Never delete an existing comment while refactoring.** A comment is context,
  not decoration. Document the why, never the what.
- **Every error carries a message** saying what you got and what you expected.
- **Do not invent scope.** Ambiguous request: take the narrowest reading, record
  the assumption, move on. Do not widen the scope to cover the doubt.

## Tests

Tests are this project's source of truth, not a specification document.

- Write the test alongside the code, not afterwards.
- Every boundary comparison needs a case at the boundary and on both sides.
- Assert the value, not its existence. Expected errors: type **and** message.
- 100% coverage and zero surviving mutants are gates, not targets.

## Structure

One folder per business module, four layers: `domain` imports nothing,
`application` imports `domain`, `infrastructure` implements the ports declared by
`application`, `interface` is the inbound edge and nothing imports from it.
`npm run arch` fails on violations.
