#!/usr/bin/env node
/**
 * Runs the gates in parallel and reports EVERY problem at once.
 *
 * Chaining with `&&` costs twice. First, time: the gates are independent reads,
 * so waiting for one another is pure waste. Second, and worse — stopping at the
 * first red hides the rest, and the agent discovers one problem per round. Each
 * of those rounds is a whole CLI invocation, paid for in tokens. Reporting
 * everything together trades five round trips for one.
 *
 * Usage:
 *   node tools/gates.mjs                 fast gates
 *   node tools/gates.mjs --with-mutation adds mutation testing at the end
 *   node tools/gates.mjs --serial        one at a time, for debugging
 *   node tools/gates.mjs -j 2            cap the concurrency
 */
import { spawn } from 'node:child_process';
import { availableParallelism } from 'node:os';

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback;
};

/**
 * The contract runs first and alone: with the requirement still open, the rest
 * does not matter. Everything else is an independent read and can run together.
 */
const CONTRACT = { name: 'contract', script: 'contract' };

const PARALLEL = [
  { name: 'formatting', script: 'format:check' },
  { name: 'typecheck', script: 'typecheck' },
  { name: 'type coverage', script: 'typecoverage' },
  { name: 'lint', script: 'lint' },
  { name: 'architecture', script: 'arch' },
  { name: 'structure', script: 'structure' },
  { name: 'halstead', script: 'halstead' },
  { name: 'secrets', script: 'secrets' },
  { name: 'no-bypass', script: 'no-bypass' },
  { name: 'gates-intact', script: 'gates-intact' },
  { name: 'dead code', script: 'deadcode' },
  { name: 'duplication', script: 'duplication' },
  { name: 'tests', script: 'test' },
];

const MUTATION = { name: 'mutation', script: 'mutation' };

const serial = args.includes('--serial');
const withMutation = args.includes('--with-mutation');
const limit = serial ? 1 : Math.max(1, Number(flag('-j', String(Math.min(4, availableParallelism())))));

function run({ name, script }) {
  const started = Date.now();
  return new Promise((resolve) => {
    const child = spawn('npm', ['run', '--silent', script], {
      shell: process.platform === 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, FORCE_COLOR: '0' },
    });
    let output = '';
    const collect = (d) => {
      output += d.toString();
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    child.on('error', (e) => {
      resolve({ name, ok: false, ms: Date.now() - started, output: `failed to run: ${e.message}` });
    });
    child.on('close', (code) => {
      resolve({ name, ok: code === 0, ms: Date.now() - started, output });
    });
  });
}

/** Runs with bounded concurrency, keeping the report in declaration order. */
async function runAll(gates, concurrency) {
  const results = new Array(gates.length);
  let next = 0;
  const worker = async () => {
    while (next < gates.length) {
      const mine = next++;
      process.stderr.write('.');
      results[mine] = await run(gates[mine]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, gates.length) }, worker));
  return results;
}

const ms = (n) => (n < 1000 ? `${n}ms` : `${(n / 1000).toFixed(1)}s`);

function report(results, elapsed) {
  const width = Math.max(...results.map((r) => r.name.length));
  console.log('');
  for (const r of results) {
    console.log(`  ${r.ok ? 'ok    ' : 'FAILED'} ${r.name.padEnd(width)}  ${ms(r.ms).padStart(7)}`);
  }

  const failures = results.filter((r) => !r.ok);
  const serialTotal = results.reduce((a, r) => a + r.ms, 0);
  console.log(`\n  ${results.length} gates in ${ms(elapsed)} (serially it would be ${ms(serialTotal)})`);

  if (failures.length === 0) return 0;

  for (const f of failures) {
    console.error(`\n${'='.repeat(64)}\n${f.name}\n${'='.repeat(64)}`);
    console.error(f.output.trimEnd() || '(no output)');
  }
  console.error(
    `\n${failures.length} of ${results.length} gates are red: ` +
      `${failures.map((f) => f.name).join(', ')}.\n` +
      `They are all above, at once — fix everything before running again.`,
  );
  return 1;
}

const started = Date.now();

// The contract runs first and alone: with the requirement still open, nothing else matters.
const contractResult = await run(CONTRACT);
if (!contractResult.ok) {
  console.error(contractResult.output.trimEnd());
  console.error('\nThe task contract is not closed. Every other gate looks at the code; this');
  console.error('one looks at the requirement, and code that is wrong for the right reason');
  console.error('passes all of them.');
  process.exit(1);
}

const list = withMutation ? [...PARALLEL, MUTATION] : PARALLEL;
const results = await runAll(list, limit);
process.exit(report([contractResult, ...results], Date.now() - started));
