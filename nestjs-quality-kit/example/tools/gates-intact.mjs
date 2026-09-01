#!/usr/bin/env node
/**
 * Checks that the gates themselves are still standing.
 *
 * `no-bypass` counts suppressions: `eslint-disable`, `istanbul ignore`, a rule
 * turned off with `'off'`. It cannot see the simplest way out of all — **deleting
 * the rule**. A config without the rule has no `'off'` to count, the linter goes
 * green because nothing is checking any more, and the bypass gate reports that
 * everything is fine.
 *
 * This script closes that hole. It does not read the config text: it asks ESLint
 * which configuration is *resolved* for a real file, and compares that against
 * what the kit requires. Same idea for coverage, mutation, duplication and
 * architecture.
 *
 * Rule of thumb: **tightening is welcome, loosening is not**. Dropping the
 * complexity limit from 21 to 15 passes. Raising it to 40, or deleting it, fails.
 *
 * Usage: node tools/gates-intact.mjs
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * Rules required in the resolved ESLint configuration.
 *
 * `max` is the ceiling: the number in the config has to be less than or equal
 * to it. Without `max`, the rule only has to exist as an error.
 */
const PRODUCTION_RULES = [
  { rule: 'complexity', option: 'max', max: 21 },
  { rule: 'sonarjs/cognitive-complexity', option: 0, max: 21 },
  { rule: 'max-lines', option: 'max', max: 499 },
  { rule: 'max-lines-per-function', option: 'max', max: 20 },
  { rule: 'max-depth', option: 0, max: 2 },
  { rule: 'max-statements', option: 0, max: 15 },
  { rule: 'max-params', option: 0, max: 4 },
  { rule: '@typescript-eslint/no-explicit-any' },
  { rule: '@typescript-eslint/no-unsafe-assignment' },
  { rule: '@typescript-eslint/no-unsafe-call' },
  { rule: '@typescript-eslint/no-unsafe-member-access' },
  { rule: '@typescript-eslint/no-unsafe-return' },
  { rule: '@typescript-eslint/no-unsafe-argument' },
  { rule: '@typescript-eslint/explicit-module-boundary-types' },
  { rule: '@typescript-eslint/consistent-type-assertions' },
  { rule: 'no-restricted-syntax' },
  { rule: 'id-denylist' },
  { rule: 'sonarjs/no-identical-functions' },
  { rule: 'no-unreachable' },
];

const TEST_RULES = [
  { rule: 'jest/no-disabled-tests' },
  { rule: 'jest/no-focused-tests' },
  { rule: 'jest/expect-expect' },
  { rule: 'jest/no-identical-title' },
];

/** Scripts that must exist and be part of the fast composition. */
const REQUIRED_SCRIPTS = [
  'format:check',
  'typecheck',
  'typecoverage',
  'lint',
  'arch',
  'structure',
  'halstead',
  'secrets',
  'no-bypass',
  'deadcode',
  'duplication',
  'test',
];

const ARCHITECTURE_RULES = [
  'domain-is-isolated',
  'application-knows-no-detail',
  'nobody-imports-interface',
  'domain-without-framework',
  'no-cycles',
];

const problems = [];
const note = (msg) => problems.push(msg);

// ─────────────────────────────────────────────────────────── eslint

function resolvedConfig(file) {
  try {
    return JSON.parse(
      execFileSync('npx', ['eslint', '--print-config', file], {
        encoding: 'utf8',
        maxBuffer: 32 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'ignore'],
      }),
    );
  } catch {
    return null;
  }
}

function checkRules(rules, required, where) {
  for (const { rule, option, max } of required) {
    const value = rules[rule];
    if (value === undefined) {
      note(`${where}: the \`${rule}\` rule is gone from the configuration`);
      continue;
    }
    const entry = Array.isArray(value) ? value : [value];
    const severity = entry[0];
    if (severity !== 2 && severity !== 'error') {
      note(`${where}: \`${rule}\` is not an error (it is: ${JSON.stringify(severity)})`);
      continue;
    }
    if (max === undefined) continue;

    const raw = entry[1];
    const actual = typeof option === 'string' ? raw?.[option] : raw;
    if (typeof actual !== 'number') {
      note(`${where}: \`${rule}\` lost its numeric limit (got ${JSON.stringify(raw)})`);
    } else if (actual > max) {
      note(`${where}: \`${rule}\` was loosened to ${actual}; the kit ceiling is ${max}`);
    }
  }
}

const productionFile = ['src/order/domain/order.ts', 'src/main.ts'].find((f) => existsSync(f));
const testFile = ['src/order/domain/order.spec.ts'].find((f) => existsSync(f));

if (productionFile === undefined) {
  note('no production file under src/ to resolve the ESLint configuration against');
} else {
  const config = resolvedConfig(productionFile);
  if (config === null) note('`eslint --print-config` failed: the ESLint configuration is broken');
  else checkRules(config.rules ?? {}, PRODUCTION_RULES, 'production');
}

if (testFile !== undefined) {
  const config = resolvedConfig(testFile);
  if (config !== null) checkRules(config.rules ?? {}, TEST_RULES, 'tests');
}

// ─────────────────────────────────────────────────────────── other gates

async function load(file) {
  if (!existsSync(file)) return null;
  try {
    const mod = await import(pathToFileURL(path.resolve(file)).href);
    return mod.default ?? mod;
  } catch {
    return null;
  }
}

const jest = await load('jest.config.mjs');
if (jest === null) {
  note('jest.config.mjs missing or unreadable');
} else {
  const limits = jest.coverageThreshold?.global ?? {};
  for (const counter of ['branches', 'functions', 'lines', 'statements']) {
    const v = limits[counter];
    if (typeof v !== 'number') note(`coverage: the \`${counter}\` threshold is gone`);
    else if (v < 100) note(`coverage: \`${counter}\` was loosened to ${v}%`);
  }
  const included = jest.collectCoverageFrom ?? [];
  if (!included.some((p) => String(p).includes('**/*.ts') && !String(p).startsWith('!'))) {
    note(
      'coverage: `collectCoverageFrom` no longer includes all code — a file with no ' +
        'test disappears from the report and the metric starts lying',
    );
  }
}

const stryker = await load('stryker.config.mjs');
if (stryker === null) {
  note('stryker.config.mjs missing or unreadable');
} else {
  const brk = stryker.thresholds?.break;
  if (typeof brk !== 'number') note('mutation: `thresholds.break` is gone — the build no longer fails');
  else if (brk < 100) note(`mutation: \`thresholds.break\` was loosened to ${brk}`);
}

if (!existsSync('.jscpd.json')) {
  note('.jscpd.json missing');
} else {
  const jscpd = JSON.parse(readFileSync('.jscpd.json', 'utf8'));
  if (typeof jscpd.threshold !== 'number') note('duplication: `threshold` is gone');
  else if (jscpd.threshold > 0) note(`duplication: \`threshold\` was loosened to ${jscpd.threshold}`);
}

if (!existsSync('.dependency-cruiser.cjs')) {
  note('.dependency-cruiser.cjs missing — dependency direction is no longer checked');
} else {
  const text = readFileSync('.dependency-cruiser.cjs', 'utf8');
  for (const name of ARCHITECTURE_RULES) {
    if (!text.includes(`'${name}'`)) note(`architecture: the \`${name}\` rule is gone`);
  }
  if (/severity:\s*'(warn|info)'/.test(text)) {
    note("architecture: a rule became 'warn' or 'info' and stopped failing the build");
  }
}

if (!existsSync('.ls-lint.yml')) note('.ls-lint.yml missing — names are no longer checked');
if (!existsSync('.secretlintrc.json')) note('.secretlintrc.json missing — secrets are no longer scanned');
if (!existsSync('.prettierrc.json')) note('.prettierrc.json missing');
if (!existsSync('tools/no-bypass.mjs')) note('tools/no-bypass.mjs missing');
if (!existsSync('tools/contract.mjs')) note('tools/contract.mjs missing');

// ─────────────────────────────────────────────────────────── scripts

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const scripts = pkg.scripts ?? {};

/**
 * Where to look for each gate: the `tools/gates.mjs` runner when it exists, or
 * the `gates:fast` string for anyone still chaining with `&&`. Without this,
 * dropping a gate from the runner list would go unnoticed.
 */
const runner = existsSync('tools/gates.mjs') ? readFileSync('tools/gates.mjs', 'utf8') : null;
const whereGatesRun = runner ?? (scripts['gates:fast'] ?? '');
const howGatesRun = runner === null ? '`gates:fast`' : '`tools/gates.mjs`';

for (const name of REQUIRED_SCRIPTS) {
  if (scripts[name] === undefined) {
    note(`the \`${name}\` script is gone from package.json`);
  } else if (!new RegExp(`script:\\s*'${name}'|\\brun ${name}\\b`).test(whereGatesRun)) {
    note(`\`${name}\` exists but left ${howGatesRun} — it no longer runs in the local loop`);
  }
}
if (runner !== null && !/script:\s*'contract'/.test(runner)) {
  note('`contract` left `tools/gates.mjs` — the requirement gate no longer runs');
}
const mutationRuns =
  /script:\s*'mutation'/.test(runner ?? '') || (scripts.gates ?? '').includes('mutation');
if (!mutationRuns) {
  note('`mutation` left `gates` — mutation testing no longer runs before delivery');
}
if (!/--at-least\s+100/.test(scripts.typecoverage ?? '')) {
  note('type coverage: `--at-least 100` was loosened or removed');
}

// ─────────────────────────────────────────────────────────── verdict

if (problems.length === 0) {
  console.log(
    `gates-intact: ${PRODUCTION_RULES.length + TEST_RULES.length} lint rules, ` +
      `${REQUIRED_SCRIPTS.length} scripts and 8 configurations checked — none loosened`,
  );
  process.exit(0);
}

console.error('gates loosened or removed:\n');
for (const p of problems) console.error(`  - ${p}`);
console.error(
  `\n${problems.length} problem(s). Tightening a limit is welcome; loosening or deleting\n` +
    `needs a decision recorded in the PR, and this file updated alongside it.`,
);
process.exit(1);
