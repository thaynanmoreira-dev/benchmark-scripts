---
inclusion: manual
name: contract
description: Separates what the task states from what you guessed, before any code.
---
# Task contract

Before any code, let us separate **what the task says** from **what I guessed**.
You interview me; I answer. One question at a time.

Run `npm run contract -- --new` and fill in `.kiro/contracts/<branch>.md` with me.

## How to run it

**1. Collect facts, with sources.**
A fact is what the task or the code **state**, and it comes with an address:
`file:line`, a test name, or a quoted snippet from the card. Read the code before
asserting anything about it — do not infer from the file name.

If you did not find the source, **it is not a fact**. Move it down to assumptions.

**2. List what you were about to fill in on your own.**
This is the point of the exercise. Every place where the task is silent and you
were going to choose becomes a written assumption. Classify each one:

- **safe** — wrong, and the fix is cheap and nothing breaks in production.
- **blocking** — wrong, and what we deliver is wrong.

The ones that are almost always blocking and almost never in the card: rounding,
time zones, what to do with an empty list, whether the operation is idempotent,
the behaviour at the exact boundary, and whether an error is business or
infrastructure.

**3. Ask what blocks.**
Each blocking assumption becomes a specific question for me, with your
recommendation first: *"I would assume X because Y; confirm?"*. It is easier for
me to confirm a proposal than to answer an open question.

**While a question is open, do not write production code.** Do not fill the gap
with the most likely guess — the guess becomes indistinguishable from a
requirement in the diff, and the test you write will confirm your guess instead
of verifying the requirement. That is how green and wrong get delivered together.

**4. Close the scope negatively.**
What would be reasonable to do along the way and will not be done now. If
something became a new card, record its number.

**5. Say how you will prove it.**
Which test fails today and passes at the end. "I will test it" is not enough;
which case.

## After filling it in

`npm run contract` validates. It fails while a fact has no source, a blocking
assumption has no answer, or a question is open. Green means you can implement.

The contract is the size of the task: a one-line task has a ten-line contract.
What is not allowed is starting without one.
