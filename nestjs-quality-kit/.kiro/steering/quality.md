---
inclusion: fileMatch
fileMatchPattern: 'src/**/*.ts'
---
# How to write code that passes the gates

The numbers live in the tools. What follows is the behaviour that keeps the code
under them — because "keep cyclomatic complexity under 22" is not something you
can compute while writing, but "extract the condition into a named function" is.

## Small units

You read files in chunks and navigate by search, not top to bottom. A unit that
does not fit in one read becomes a fragmented mental model, and deep nesting
multiplies the attention cost. Hence the limits:

- Functions between 4 and 20 lines. Past that, extract — do not compress.
- At most two levels of indentation. Validate on entry and return early.
- A `switch` or `else if` with more than four branches becomes a
  `Record<Key, Handler>` and a lookup: one point of complexity instead of one per
  branch.
- A boolean condition with three or more operands becomes a named function
  (`isEligibleForDiscount(order)`).
- One method does one thing. If you need a comment to separate its phases, it is
  two methods.

## Names that survive a grep

Search is how you navigate. A generic name returns irrelevant results and costs
an extra read on every round.

- Rule of thumb: if you search for the name and things you do not care about come
  back, the name is wrong. Not `total`; `netTotalCents`.
- Banned as identifiers: `data`, `info`, `obj`, `res`, `val`, `tmp`, `temp`,
  `foo`, `bar`, `stuff`, `thing`, `util`, `utils`, `helper`, `manager`.
- File names in lowercase with segments separated by dots or hyphens
  (`calculate-total.handler.ts`). A predictable structure saves a `find`.

## Comments

This is the opposite of what used to be taught: a comment is first-class context
for whoever reads the code later, including you in a future session.

- **Never delete an existing comment while refactoring**, yours or anyone's. It
  is there because somebody needed that information.
- Document the **why**, never the what. `// increment i` is noise that costs tokens.
- Worth recording: the production bug that motivated the odd logic, a business
  constraint, a library workaround, the ticket number, a commit reference.
- A public signature gets a docstring with intent and one usage example.

## Errors with context

A stack trace is your debugging signal. A vague message costs a whole round of
investigation every time the error is thrown.

- Never `new Error()` with no message — the linter rejects it.
- Say what you got and what you expected: ``throw new RangeError(`percent out of
  range: got ${percent}, expected 0 to 100`)``.
- Structured JSON logs with named fields, never concatenated prose.

## 100% coverage and zero surviving mutants

Coverage says whether the line ran. Mutation says whether **any test would
complain** if the line changed. Passing the first and failing the second is the
normal case, and it is what the tests in this repository must avoid:

- Every boundary comparison needs a case **at** the boundary and on both sides.
  `if (x < 0)` needs tests with `x` at -1, 0 and 1. Without the case at 0, the
  mutation from `<` to `<=` survives.
- Assert the value, not its existence. `expect(r).toBeDefined()` kills no mutant.
- Expected errors: assert the type **and** the message. A bare `toThrow()` lets
  the mutant that deletes the message survive.
- Write the test alongside the code. A new branch with no new case is born
  failing two gates.

## Zero `any`, `unknown` and `as`

Without those three, external data can only enter **validated at runtime**. That
is the intent of the rule, not style:

- HTTP boundary: a DTO with `class-validator` and the global `ValidationPipe`.
  The parameter type becomes a runtime truth rather than a promise.
- Queue, webhook, external API response, `JSON.parse`: run it through a schema
  (`zod` or equivalent) and use the type it infers. Never consume the raw result.
- `catch (e)`: leave it unannotated. Under `strict`, TypeScript already gives it
  the right type without you writing the banned word. Narrow with
  `e instanceof Error`.
- A generic that will not resolve means a missing type parameter, not a licence
  to loosen.
- In `*.spec.ts` the `unknown` and `as` rules are off, purely for doubling a
  framework class. In production, zero.

## Dead and redundant code

- Only `export` what another file actually imports. Reflexive `export` is the
  biggest source of dead code.
- A second occurrence of a snippet can coexist. A third: extract. Before that you
  usually extract the wrong abstraction.
- Deleted the last usage of something? Delete the thing too, in the same commit.
