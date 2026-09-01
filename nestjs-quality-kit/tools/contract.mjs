#!/usr/bin/env node
/**
 * Task contract gate.
 *
 * Agents are very good at filling in blanks. That is the problem: when the task
 * does not say how to round, the agent picks one, writes the test that confirms
 * its own pick, and delivers green. Every quality gate passes. The behaviour is
 * wrong all the same, and nobody finds out until the incident.
 *
 * This gate checks no code. It checks that somebody separated, in writing and
 * before implementing, what the task SAYS from what somebody GUESSED. And it
 * fails while an open question or an unanswered blocking assumption remains.
 *
 * Usage:
 *   node tools/contract.mjs --new <slug>   create a contract from the template
 *   node tools/contract.mjs                validate the contract for this branch
 *   node tools/contract.mjs <path>         validate a specific contract
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

const DIR = '.kiro/contracts';

const SECTIONS = ['Task', 'Facts', 'Assumptions', 'Open questions', 'Out of scope', 'How I will prove it works'];

const TEMPLATE = (slug) => `# Contract: ${slug}

Fill this in before writing code. While an open question or an unanswered
blocking assumption remains, this contract fails and the task does not start.

## Task

One sentence, in your own words, of what has to exist when this is done.

Origin: <link to the card, issue or conversation>

## Facts

What the task or the code **state**. Every fact needs a checkable source:
\`file:line\`, a test name, or a quoted snippet from the card. Without a source
it is not a fact, it is an assumption — move it to the section below.

- [F1] ... — source: <file:line | card | test>

## Assumptions

What you are filling in on your own. Classify each one:

- **safe** — if it turns out wrong, the fix is cheap and nothing breaks in production.
- **blocking** — if it turns out wrong, what you deliver is wrong.

A blocking assumption has to become a fact before you implement. Ask, and record
the answer with \`ANSWERED:\` plus who answered and when.

- [A1] (safe) ...
- [A2] (blocking) ... — ANSWERED: <answer, who, when>

## Open questions

What you cannot answer on your own. **While anything is listed here, do not
implement** — take it to whoever asked for the task. If there is nothing, write
\`(none)\`.

- (none)

## Out of scope

What would be reasonable to do along the way and you are **not** doing in this task.

- ...

## How I will prove it works

The test that fails today and passes at the end. Not "I will test it": which case.

- ...
`;

// ─────────────────────────────────────────────────────────── helpers

function currentBranch() {
  try {
    return execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return '';
  }
}

/** `feat/ORD-123-discount` becomes `feat-ord-123-discount`. */
function slugOf(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function sectionsOf(text) {
  const map = new Map();
  let current = null;
  for (const line of text.split('\n')) {
    const heading = line.match(/^##\s+(.+?)\s*$/);
    if (heading) {
      current = heading[1];
      map.set(current, []);
      continue;
    }
    if (current !== null) map.get(current).push(line);
  }
  return map;
}

/**
 * The real list items.
 *
 * Drops whatever is left over from the template: a line with an ellipsis or a
 * <placeholder> is an instruction to fill in, not filled-in content. Also drops
 * a line starting in bold, which in the template explains the vocabulary.
 */
function realItems(lines) {
  return lines
    .map((l) => l.trim())
    .filter((l) => l.startsWith('- '))
    .map((l) => l.slice(2).trim())
    .filter((l) => l.length > 0 && !l.includes('...') && !/<[^>]+>/.test(l) && !l.startsWith('**'));
}

// ─────────────────────────────────────────────────────────── validation

function validate(file) {
  const text = readFileSync(file, 'utf8');
  const sections = sectionsOf(text);
  const problems = [];

  for (const name of SECTIONS) {
    if (!sections.has(name)) problems.push(`the "## ${name}" section is missing`);
  }
  if (problems.length > 0) return problems;

  const task = sections
    .get('Task')
    .join(' ')
    .replace(/Origin:.*/s, '')
    .trim();
  if (task.length === 0 || task.startsWith('One sentence, in your own words')) {
    problems.push('the "Task" section still holds the template text');
  }
  if (!/Origin:\s*\S/.test(text) || /Origin:\s*</.test(text)) {
    problems.push('the origin of the task is empty: point at the card, the issue or the conversation');
  }

  const facts = realItems(sections.get('Facts'));
  if (facts.length === 0) {
    problems.push('no facts recorded: what do the task and the code actually state?');
  }
  for (const fact of facts) {
    if (!/\bsource:\s*\S/i.test(fact)) {
      problems.push(`fact without a checkable source: "${fact.slice(0, 70)}"`);
    } else if (/source:\s*</.test(fact)) {
      problems.push(`fact whose source is still the template placeholder: "${fact.slice(0, 70)}"`);
    }
  }

  for (const assumption of realItems(sections.get('Assumptions'))) {
    const blocking = /\(blocking\)/i.test(assumption);
    const classified = blocking || /\(safe\)/i.test(assumption);
    if (!classified) {
      problems.push(`assumption with no classification (safe|blocking): "${assumption.slice(0, 70)}"`);
      continue;
    }
    if (!blocking) continue;
    const answered = /ANSWERED:\s*\S/.test(assumption) && !/ANSWERED:\s*</.test(assumption);
    if (!answered) {
      problems.push(
        `BLOCKING assumption with no answer: "${assumption.slice(0, 70)}"\n` +
          `     Ask whoever requested the task and record it with ANSWERED: who answered and when.`,
      );
    }
  }

  for (const question of realItems(sections.get('Open questions')).filter(
    (q) => !/^\(none\)$/i.test(q),
  )) {
    problems.push(`open question: "${question.slice(0, 70)}"`);
  }

  if (realItems(sections.get('Out of scope')).length === 0) {
    problems.push('nothing under "Out of scope": write what would be reasonable to do and you are not doing');
  }
  if (realItems(sections.get('How I will prove it works')).length === 0) {
    problems.push('nothing under "How I will prove it works": which test fails today and passes at the end?');
  }

  return problems;
}

// ─────────────────────────────────────────────────────────── main

const args = process.argv.slice(2);
const iNew = args.indexOf('--new');

if (iNew >= 0) {
  const slug = slugOf(args[iNew + 1] || currentBranch()) || 'task';
  const target = path.join(DIR, `${slug}.md`);
  if (existsSync(target)) {
    console.error(`already exists: ${target}`);
    process.exit(1);
  }
  mkdirSync(DIR, { recursive: true });
  writeFileSync(target, TEMPLATE(slug), 'utf8');
  console.log(`contract created at ${target}`);
  console.log('Fill it in before writing code. Then: npm run contract');
  process.exit(0);
}

const explicit = args.find((a) => !a.startsWith('--'));
const forBranch = path.join(DIR, `${slugOf(currentBranch())}.md`);
let file = explicit ?? (existsSync(forBranch) ? forBranch : null);

if (file === null && existsSync(DIR)) {
  const candidates = readdirSync(DIR).filter((f) => f.endsWith('.md'));
  if (candidates.length === 1) file = path.join(DIR, candidates[0]);
}

if (file === null || !existsSync(file)) {
  console.error(
    `No task contract for branch "${currentBranch() || '(no git)'}".\n\n` +
      `Before writing code, separate what the task SAYS from what you GUESSED:\n\n` +
      `    node tools/contract.mjs --new ${slugOf(currentBranch()) || '<slug>'}\n\n` +
      `It takes two minutes and it is the only gate that catches a missing\n` +
      `requirement — every other one looks at the code, and code that is wrong\n` +
      `for the right reason passes them all.`,
  );
  process.exit(1);
}

const problems = validate(file);
if (problems.length === 0) {
  console.log(`contract: ${file} — complete, no open questions`);
  process.exit(0);
}

console.error(`incomplete contract: ${file}\n`);
for (const p of problems) console.error(`  - ${p}`);
console.error(
  `\n${problems.length} item(s) pending. While an open question or an unanswered\n` +
    `blocking assumption remains, the task does not start: go ask.`,
);
process.exit(1);
