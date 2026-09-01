---
inclusion: always
---
# Definition of done

The task **starts** when `npm run contract` exits zero, and not before: while a
fact has no source, a blocking assumption has no answer, or a question is still
open, do not write production code. Use `/contract` and I will fill it in with you.

The task is **done** when this command exits zero, and not before:

```bash
npm run gates:fast   # seconds — run it on every change
npm run gates        # adds mutation testing (minutes) — before handing back
```

Run it yourself. Do not hand back for me to discover it is red: every round trip
costs the team credit.

The gates run in parallel and the report lists **every** red one at once, with
each output. Fix all of them before running again — do not repair one per round.

## The limits

None of these numbers are for you to work out in your head — each one has a
command that gives the verdict.

| Limit | Command |
|---|---|
| Task contract complete | `npm run contract` |
| Canonical formatting | `npm run format:check` (`npm run format` fixes it) |
| Cyclomatic complexity < 22 | `npm run lint` |
| Cognitive complexity < 22 | `npm run lint` |
| Function of 4 to 20 lines, at most 2 nesting levels | `npm run lint` |
| Lines of code per file < 500 | `npm run lint` |
| Zero `any`, zero `unknown`, zero `as` | `npm run lint` |
| Explicit types at the boundary | `npm run lint` |
| Greppable names, no generic terms | `npm run lint` |
| Every error carries a message | `npm run lint` |
| No disabled or assertion-free test | `npm run lint` |
| Type coverage 100% | `npm run typecoverage` |
| Dependency direction between layers | `npm run arch` |
| Predictable file and folder names | `npm run structure` |
| Halstead difficulty < 80 | `npm run halstead` |
| No secret in the repository | `npm run secrets` |
| Test coverage 100% | `npm test` |
| CRAP < 25 | follows from the two above¹ |
| Surviving mutants: 0 | `npm run mutation` |
| Dead code: 0 | `npm run deadcode` |
| Redundant code: 0 | `npm run duplication` |
| No new suppression | `npm run no-bypass` |
| No gate loosened or deleted | `npm run gates-intact` |

¹ `CRAP = complexity² × (1 − coverage)³ + complexity`. With coverage at 100% the
cubic term is zero and CRAP becomes the cyclomatic complexity itself, already
capped at 22.

## Never switch a gate off instead of solving the problem

Never introduce, in production code or in tests:

`eslint-disable` · `@ts-ignore` · `@ts-expect-error` · `@ts-nocheck` ·
`istanbul ignore` · `c8 ignore` · `Stryker disable` · `jscpd:ignore` ·
`prettier-ignore` · `type-coverage:ignore` · `secretlint-disable` ·
`as any` · `as unknown` · any `as` type assertion · `it.skip` · `test.todo` ·
`xit` · `xdescribe`

Nor edit `jest.config.mjs`, `eslint.config.mjs`, `stryker.config.mjs`,
`knip.json`, `.jscpd.json`, `.dependency-cruiser.cjs`, `.ls-lint.yml`,
`.prettierignore`, `.gates-baseline.json`, `tools/gates.mjs` or
`tools/gates-intact.mjs`.

`npm run no-bypass` counts those occurrences and fails on any increase. Working
around them does not turn the build green — it only changes which gate is red.

**Deleting the rule is not a way out either.** `npm run gates-intact` asks ESLint
which configuration is actually in force and fails when a limit is gone or
loosened — turning it off with `'off'`, deleting the line, and dropping a gate
from the runner list all come back red. Tightening a limit passes; loosening
needs a decision recorded in the PR.

**When a limit cannot be met, stop and ask me.** A limit that will not close is
project information, not an obstacle to route around. Say what is blocking and
propose the alternative.
