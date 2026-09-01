#!/usr/bin/env node
/**
 * Bypass gate.
 *
 * Every quality gate has a back door, and whoever is in a hurry — person or
 * agent — finds the door before finding the solution. Silencing the rule is
 * faster than lowering the complexity, and the build goes green while lying.
 *
 * This gate counts the doors. On a new project the number has to be zero. On an
 * existing one the number may only go down: the baseline lives in
 * .gates-baseline.json under version control, and any increase fails.
 *
 * Note the blind spot this one has by design: it counts suppressions, not
 * deletions. Removing a rule outright leaves nothing to count — that is what
 * tools/gates-intact.mjs is for.
 *
 * Usage:
 *   node tools/no-bypass.mjs             compare against the baseline
 *   node tools/no-bypass.mjs --strict    require zero, ignore the baseline
 *   node tools/no-bypass.mjs --record    rewrite the baseline (review it in the PR!)
 */
import { readFileSync, writeFileSync, existsSync, globSync } from 'node:fs';

const args = process.argv.slice(2);
const STRICT = args.includes('--strict');
const RECORD = args.includes('--record');
const BASELINE = '.gates-baseline.json';

/** In-code suppressions: each one switches a gate off for that spot. */
const PATTERNS = [
  { id: 'eslint-disable', re: /\/[/*]\s*eslint-disable/g, gate: 'lint (complexity, any, duplication)' },
  { id: 'ts-ignore', re: /@ts-ignore/g, gate: 'typecheck' },
  { id: 'ts-expect-error', re: /@ts-expect-error/g, gate: 'typecheck' },
  { id: 'ts-nocheck', re: /@ts-nocheck/g, gate: 'typecheck (whole file)' },
  { id: 'istanbul-ignore', re: /istanbul\s+ignore/g, gate: 'coverage' },
  { id: 'c8-ignore', re: /c8\s+ignore/g, gate: 'coverage' },
  { id: 'stryker-disable', re: /Stryker\s+disable/gi, gate: 'mutation' },
  { id: 'jscpd-ignore', re: /jscpd:ignore/g, gate: 'duplication' },
  { id: 'knip-ignore', re: /@(public|internal)\b|knip-ignore/g, gate: 'dead code' },
  { id: 'cast-any', re: /\bas\s+any\b/g, gate: 'the any ban' },
  { id: 'cast-unknown', re: /\bas\s+unknown\b/g, gate: 'the unknown ban' },
  { id: 'skipped-test', re: /\b(it|test|describe)\.(skip|todo)\b|\bx(it|describe)\(/g, gate: 'tests' },
  { id: 'prettier-ignore', re: /prettier-ignore/g, gate: 'formatting' },
  { id: 'type-coverage-ignore', re: /type-coverage:ignore/g, gate: 'type coverage' },
  { id: 'secretlint-disable', re: /secretlint-disable/g, gate: 'secret scanning' },
];

/** Exclusion lists in config files: widening the list is a bypass too. */
const EXCLUSIONS = [
  { id: 'jest-coverage-exclude', file: 'jest.config.mjs', re: /'!\S+'/g },
  { id: 'jscpd-ignore-list', file: '.jscpd.json', re: /"[^"]*\*[^"]*"/g },
  { id: 'stryker-mutate-exclude', file: 'stryker.config.mjs', re: /'!\S+'/g },
  { id: 'eslint-rule-turned-off', file: 'eslint.config.mjs', re: /:\s*'off'/g },
  { id: 'ls-lint-ignore', file: '.ls-lint.yml', re: /^\s+- \S+/gm },
  { id: 'prettier-ignore-list', file: '.prettierignore', re: /^[^#\n].+$/gm },
  { id: 'type-coverage-ignore-files', file: 'package.json', re: /--ignore-files/g },
];

const counts = {};
const hits = [];

for (const file of globSync(['src/**/*.ts'], { exclude: (p) => /node_modules/.test(p) })) {
  const text = readFileSync(file, 'utf8');
  const lines = text.split('\n');
  for (const { id, re, gate } of PATTERNS) {
    for (const m of text.matchAll(re)) {
      const line = text.slice(0, m.index).split('\n').length;
      counts[id] = (counts[id] ?? 0) + 1;
      hits.push({ id, gate, file, line, snippet: (lines[line - 1] ?? '').trim().slice(0, 90) });
    }
  }
}

for (const { id, file, re } of EXCLUSIONS) {
  if (!existsSync(file)) continue;
  const n = [...readFileSync(file, 'utf8').matchAll(re)].length;
  if (n > 0) counts[id] = n;
}

if (RECORD) {
  writeFileSync(BASELINE, `${JSON.stringify(counts, null, 2)}\n`, 'utf8');
  console.log(`baseline written to ${BASELINE}:`);
  console.log(JSON.stringify(counts, null, 2));
  process.exit(0);
}

const baseline = STRICT ? {} : existsSync(BASELINE) ? JSON.parse(readFileSync(BASELINE, 'utf8')) : {};
const violations = [];

for (const [id, n] of Object.entries(counts)) {
  const allowed = baseline[id] ?? 0;
  if (n > allowed) violations.push({ id, n, allowed });
}

for (const v of violations) {
  console.error(
    `${v.id}: ${v.n} occurrence(s), ${v.allowed} allowed. ` +
      `This shortcut switches off the ${PATTERNS.find((p) => p.id === v.id)?.gate ?? 'configuration'} gate.`,
  );
  for (const h of hits.filter((x) => x.id === v.id).slice(0, 5)) {
    console.error(`   ${h.file}:${h.line}  ${h.snippet}`);
  }
}

const total = Object.values(counts).reduce((a, b) => a + b, 0);
if (violations.length === 0) {
  console.log(`no-bypass: ${total} known suppression(s), none new — ok`);
  process.exit(0);
}
console.error(
  `\nno-bypass: ${violations.length} kind(s) of shortcut above the baseline.\n` +
    `Lower the complexity, write the test, or type the boundary. If the suppression\n` +
    `really is necessary it needs a justification in the PR and a deliberate --record.`,
);
process.exit(1);
