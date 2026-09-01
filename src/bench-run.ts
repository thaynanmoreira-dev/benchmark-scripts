#!/usr/bin/env node
/**
 * bench-run.ts
 *
 * The runner. Consumes .bench/plan.json and executes each cell (arm x task x rep).
 *
 * For each entry, in the plan's randomized order:
 *   1. detached worktree from the mirror at baseCommit
 *   2. install dependencies (cache shared by lockfile hash)
 *   3. apply the arm's overlay: wipe pre-existing config, write steering/mcp
 *   4. fire the agent CLI with the task description
 *      -> an arm with enforceGates enters a repair loop with lint/typecheck/arch
 *   5. snapshot the touched files (BEFORE planting the grader)
 *   6. plant the held-out tests from the PR commit and run them one by one
 *   7. run the deterministic gates
 *   8. compare what was touched against the golden diff -> scope metric
 *   9. append one line to obs/runs.jsonl
 *  10. destroy the worktree
 *
 * Interrupted midway? Run it again: runs already recorded are skipped.
 *
 * Usage:
 *   node src/bench-run.ts --config bench.config.json
 *   node src/bench-run.ts --only-arms A0,A3 --limit 12
 *   node src/bench-run.ts --dry-run
 *
 * No external dependencies. Node >= 22.6.
 */

import path from "node:path";

import { addUsage, emptyUsage, resolveAgentConfig, runAgent } from "./lib/agent.ts";
import { readArgs } from "./lib/args.ts";
import { installDeps, type InstallStrategy } from "./lib/deps.ts";
import { existsSync, materialize, readJson, removePath } from "./lib/fsx.ts";
import {
  addWorktree,
  bareRepo,
  checkoutPaths,
  ensureCommit,
  removeWorktree,
  touchedFiles,
  workRepo,
  type GitRepo,
} from "./lib/git.ts";
import { bold, clip, cyan, dim, fail, green, info, ok, red, warn, yellow } from "./lib/log.ts";
import { appendRun, completedRunIds } from "./lib/obs.ts";
import { fillFiles, runCommand } from "./lib/shell.ts";
import { fmtMs } from "./lib/stats.ts";
import type {
  AgentConfig,
  Arm,
  BenchConfig,
  GateResult,
  Manifest,
  Plan,
  PlanEntry,
  ProjectProfile,
  RunRecord,
  SelectedPr,
  UsageSnapshot,
} from "./lib/types.ts";

interface Options {
  config: string;
  manifest: string;
  root: string;
  onlyArms: string[];
  onlyTasks: string[];
  onlyRepos: string[];
  limit: number;
  from: number;
  dryRun: boolean;
  force: boolean;
  keepWorktrees: boolean;
  installStrategy: InstallStrategy;
  pauseMs: number;
  maxGateRetries: number;
}

function parseOptions(argv: string[]): Options {
  const a = readArgs(argv);
  return {
    config: a.str("--config", "bench.config.json") as string,
    manifest: a.str("--manifest", "manifest.json") as string,
    root: a.str("--root", "") as string,
    onlyArms: a.list("--only-arms"),
    onlyTasks: a.list("--only-tasks"),
    onlyRepos: a.list("--only-repos"),
    limit: a.num("--limit", Infinity),
    from: a.num("--from", 1),
    dryRun: a.bool("--dry-run"),
    force: a.bool("--force"),
    keepWorktrees: a.bool("--keep-worktrees"),
    installStrategy: (a.str("--install-strategy", "symlink") ?? "symlink") as InstallStrategy,
    pauseMs: a.num("--pause-ms", 0),
    maxGateRetries: a.num("--max-gate-retries", -1),
  };
}

// ══════════════════════════════════════════════════════ prompts

/**
 * The prompt is IDENTICAL across all arms. The only things that vary between
 * arms are the overlay (steering, mcp) and the CLI mode. If the prompt varied
 * too, the experiment could no longer attribute the effect to the configuration.
 */
function taskPrompt(task: SelectedPr): string {
  const body = task.description.trim();
  return `# Task

${task.title}

${body || "(the work item carried no description beyond the title)"}

## Execution context

- You are in a clean worktree of repository ${task.repo}, at the commit before this change.
- Implement the task completely, directly in the code. There is no review step afterwards.
- Follow the conventions that already exist in the repository.
`;
}

function repairPrompt(task: SelectedPr, failures: GateResult[]): string {
  const blocks = failures
    .map(
      (f) =>
        `### ${f.name}\n$ ${f.command}\nexit ${f.exitCode}\n\n${clip(f.output.trim(), 2500)}`,
    )
    .join("\n\n");

  return `# Repair

The task below was implemented in this worktree, but the deterministic gates
came back red. Fix what broke.

Original task: ${task.title}

Repair rules:
- Fix only what the gates point at. Do not widen the scope.
- Do not disable a lint rule, delete a test, or relax configuration to pass.

## Red gates

${blocks}
`;
}

// ══════════════════════════════════════════════════════ gates

interface GateSpec {
  name: string;
  command: string | null;
}

/**
 * The deterministic gates. The repository's own suite enters here as a
 * regression gate: it already exists at the base commit, so the agent can see
 * and run it without that leaking the held-out grader, planted only afterwards.
 */
function gateSpecs(profile: ProjectProfile): GateSpec[] {
  const c = profile.probe.commands;
  return [
    { name: "lint", command: c.lint },
    { name: "typecheck", command: c.typecheck },
    { name: "arch", command: c.arch },
    { name: "test", command: c.test },
  ];
}

async function runGates(
  specs: GateSpec[],
  cwd: string,
  timeoutMs: number,
): Promise<GateResult[]> {
  const results: GateResult[] = [];
  for (const spec of specs) {
    if (!spec.command) {
      results.push({
        name: spec.name,
        command: null,
        passed: null,
        exitCode: null,
        durationMs: 0,
        output: "gate not applicable to this repository",
      });
      continue;
    }
    const res = await runCommand(spec.command, { cwd, timeoutMs });
    results.push({
      name: spec.name,
      command: spec.command,
      passed: res.ok,
      exitCode: res.exitCode,
      durationMs: res.durationMs,
      output: res.output,
    });
  }
  return results;
}

function failedGates(results: GateResult[]): GateResult[] {
  return results.filter((g) => g.passed === false);
}

// ══════════════════════════════════════════════════════ grader held-out

interface HeldOutResult {
  passed: number;
  failed: number;
  total: number;
  ran: boolean;
  overwrites: string[];
  detail: GateResult[];
}

/**
 * Plants the original PR's tests in the worktree and runs them one by one.
 *
 * One by one on purpose: it yields partial signal (2 of 3 passed) and does not
 * depend on parsing the output of any specific runner. The agent never sees
 * these files — they only appear after it has finished.
 */
async function gradeHeldOut(
  worktree: string,
  task: SelectedPr,
  profile: ProjectProfile,
  touchedBefore: string[],
  timeoutMs: number,
): Promise<HeldOutResult> {
  const empty: HeldOutResult = {
    passed: 0,
    failed: 0,
    total: 0,
    ran: false,
    overwrites: [],
    detail: [],
  };
  if (task.testFiles.length === 0) return empty;

  const touchedSet = new Set(touchedBefore);
  const overwrites = task.testFiles.filter((f) => touchedSet.has(f));

  const restored = await checkoutPaths(workRepo(worktree), task.headCommit, task.testFiles);
  if (restored.length === 0) return { ...empty, overwrites };

  const template = profile.probe.commands.testFile;
  const detail: GateResult[] = [];
  let passed = 0;
  let failed = 0;

  if (template) {
    for (const file of restored) {
      const cmd = fillFiles(template, [file]);
      const res = await runCommand(cmd, { cwd: worktree, timeoutMs });
      if (res.ok) passed++;
      else failed++;
      detail.push({
        name: `test:${file}`,
        command: cmd,
        passed: res.ok,
        exitCode: res.exitCode,
        durationMs: res.durationMs,
        output: res.ok ? "" : res.output,
      });
    }
  } else if (profile.probe.commands.test) {
    // no way to scope by file: the whole suite becomes a single verdict
    const res = await runCommand(profile.probe.commands.test, { cwd: worktree, timeoutMs });
    passed = res.ok ? 1 : 0;
    failed = res.ok ? 0 : 1;
    detail.push({
      name: "test:suite",
      command: profile.probe.commands.test,
      passed: res.ok,
      exitCode: res.exitCode,
      durationMs: res.durationMs,
      output: res.ok ? "" : res.output,
    });
  } else {
    return { ...empty, overwrites };
  }

  return { passed, failed, total: passed + failed, ran: true, overwrites, detail };
}

// ══════════════════════════════════════════════════════ scope

function scopeMetrics(
  touched: string[],
  task: SelectedPr,
  overlayPaths: Set<string>,
): { outside: string[]; missed: string[] } {
  const golden = new Set([...task.prodFiles, ...task.testFiles]);
  const outside = touched.filter(
    (f) => !golden.has(f) && !overlayPaths.has(f) && !isHarnessPath(f),
  );
  const missedSource = task.prodFiles.filter((f) => !touched.includes(f));
  return { outside, missed: missedSource };
}

/** Harness noise of our own that never counts as invented scope. */
function isHarnessPath(file: string): boolean {
  return (
    file.startsWith(".kiro/") ||
    file.startsWith("node_modules/") ||
    file === "node_modules" ||
    file.startsWith(".bench/")
  );
}

// ══════════════════════════════════════════════════════ one run

interface RunContext {
  cfg: BenchConfig;
  agent: AgentConfig;
  root: string;
  opts: Options;
  gateTimeoutMs: number;
}

async function executeRun(
  ctx: RunContext,
  entry: PlanEntry,
  task: SelectedPr,
  arm: Arm,
  profile: ProjectProfile,
): Promise<RunRecord> {
  const startedAt = new Date();
  const t0 = Date.now();
  const worktree = path.join(ctx.root, "work", entry.runId);
  const logPath = path.join(ctx.root, "logs", `${entry.runId}.log`);
  const mirror = openRepo(entry.mirrorPath);

  const record: RunRecord = {
    runId: entry.runId,
    arm: entry.arm,
    taskId: entry.taskId,
    repo: entry.repo,
    rep: entry.rep,
    mode: arm.mode,
    model: ctx.cfg.model ?? null,
    startedAt: startedAt.toISOString(),
    endedAt: startedAt.toISOString(),
    wallClockMs: 0,
    agentMs: 0,
    exitCode: null,
    agentTurns: 0,
    timedOut: false,
    usageFromStream: emptyUsage(),
    creditsBefore: null,
    creditsAfter: null,
    creditsDelta: null,
    filesTouched: [],
    filesOutsideGoldenDiff: [],
    goldenFilesMissed: [],
    heldOutOverwrites: [],
    gates: { lint: null, typecheck: null, arch: null, test: null },
    gateDetail: [],
    heldOutTests: { passed: 0, failed: 0, total: 0, ran: false },
    success: false,
    status: "setup-failed",
    notes: "",
  };

  const finish = (): RunRecord => {
    const end = new Date();
    record.endedAt = end.toISOString();
    record.wallClockMs = Date.now() - t0;
    return record;
  };

  // ── 1. worktree at the base commit
  try {
    if (!(await ensureCommit(mirror, task.baseCommit))) {
      record.notes = `base commit ${task.baseCommit} unreachable in the mirror`;
      return finish();
    }
    await addWorktree(mirror, worktree, task.baseCommit);
  } catch (err) {
    record.notes = `worktree failed: ${err instanceof Error ? err.message : String(err)}`;
    return finish();
  }

  try {
    // ── 2. dependencies
    const install = await installDeps(
      worktree,
      path.join(ctx.root, "cache", "deps"),
      profile.probe.lockfileHash,
      ctx.cfg.install?.enabled === false ? null : profile.probe.commands.install,
      ctx.opts.installStrategy,
      ctx.cfg.install?.timeoutMs ?? 900_000,
    );
    if (!install.ok) {
      record.notes = `install: ${install.detail}`;
      return finish();
    }

    // ── 3. the arm's overlay
    for (const rel of arm.overlay.remove) await removePath(path.join(worktree, rel));
    const overlayPaths = new Set(await materialize(worktree, arm.overlay.files));

    // ── 4. agent, with a repair loop when the arm enforces gates
    //
    // An arm without enforceGates runs the agent once and stops: that is
    // exactly the difference A3 tests. An arm with enforceGates hands the red
    // gates back to the agent until they go green or the turn budget runs out —
    // and every extra turn lands on the credit bill, which is the whole point.
    const maxRetries = arm.overlay.enforceGates ? ctx.opts.maxGateRetries : 0;
    const specs = gateSpecs(profile);
    let usage: UsageSnapshot = emptyUsage();
    let agentMs = 0;
    let turns = 0;
    let lastExit: number | null = null;
    let gates: GateResult[] | null = null;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const prompt =
        attempt === 0 ? taskPrompt(task) : repairPrompt(task, failedGates(gates ?? []));
      const res = await runAgent(ctx.agent, {
        prompt,
        cwd: worktree,
        mode: arm.mode,
        extraArgs: arm.overlay.extraArgs,
        model: ctx.cfg.model ?? null,
        logPath,
      });
      turns++;
      agentMs += res.durationMs;
      usage = addUsage(usage, res.usage);
      lastExit = res.exitCode;
      record.timedOut = record.timedOut || res.timedOut;
      if (res.spawnError) {
        record.notes = `agent did not execute: ${res.spawnError}`;
        record.status = "agent-failed";
        record.agentTurns = turns;
        record.agentMs = agentMs;
        record.exitCode = lastExit;
        record.usageFromStream = usage;
        return finish();
      }

      if (!arm.overlay.enforceGates) break;
      gates = await runGates(specs, worktree, ctx.gateTimeoutMs);
      if (failedGates(gates).length === 0) break;
    }

    record.agentTurns = turns;
    record.agentMs = agentMs;
    record.exitCode = lastExit;
    record.usageFromStream = usage;

    // ── 5. what the agent touched, before planting the grader
    const touched = (await touchedFiles(workRepo(worktree))).filter((f) => !isHarnessPath(f));
    record.filesTouched = touched;
    const scope = scopeMetrics(touched, task, overlayPaths);
    record.filesOutsideGoldenDiff = scope.outside;
    record.goldenFilesMissed = scope.missed;

    // ── 6. final gates, STILL with no grader on disk. The repair loop already
    //      left a fresh result from the last turn; only re-run what never ran.
    const finalGates = gates ?? (await runGates(specs, worktree, ctx.gateTimeoutMs));
    for (const g of finalGates) record.gates[g.name] = g.passed;

    // ── 7. held-out grader: plant the PR tests and run them one by one
    const held = await gradeHeldOut(worktree, task, profile, touched, ctx.gateTimeoutMs);
    record.heldOutTests = {
      passed: held.passed,
      failed: held.failed,
      total: held.total,
      ran: held.ran,
    };
    record.heldOutOverwrites = held.overwrites;
    record.gateDetail = [...finalGates, ...held.detail];

    // ── 8. verdict
    const gatesGreen = finalGates.every((g) => g.passed !== false);
    const testsGreen = held.ran && held.failed === 0 && held.total > 0;
    record.success = gatesGreen && testsGreen;
    record.status = record.success ? "ok" : "graded-failed";
    if (!held.ran) {
      record.notes = task.testFiles.length
        ? "held-out grader did not run: no test command in the profile"
        : "task with no held-out test: cannot be approved automatically";
    }
    return finish();
  } finally {
    if (!ctx.opts.keepWorktrees) {
      await removeWorktree(mirror, worktree).catch(() => undefined);
    }
  }
}

/** Bare mirror or ordinary clone: the worktree comes out the same either way. */
function openRepo(dir: string): GitRepo {
  const isBare = existsSync(path.join(dir, "HEAD")) && !existsSync(path.join(dir, ".git"));
  return isBare ? bareRepo(dir) : workRepo(dir);
}

// ══════════════════════════════════════════════════════ main

function summarize(record: RunRecord): string {
  const verdict = record.success
    ? green("PASS")
    : record.status === "setup-failed" || record.status === "agent-failed"
      ? red(record.status.toUpperCase())
      : yellow("FAIL");
  const tests = record.heldOutTests.ran
    ? `${record.heldOutTests.passed}/${record.heldOutTests.total} tests`
    : "no grader";
  const gates = Object.entries(record.gates)
    .map(([k, v]) => `${k}:${v === null ? "-" : v ? "ok" : "x"}`)
    .join(" ");
  const cost =
    record.usageFromStream.totalTokens !== null
      ? `${record.usageFromStream.totalTokens} tok`
      : record.usageFromStream.costUsd !== null
        ? `$${record.usageFromStream.costUsd}`
        : "cost n/a";
  return (
    `${verdict}  ${tests}  ${gates}  scope+${record.filesOutsideGoldenDiff.length}  ` +
    `turns:${record.agentTurns}  ${fmtMs(record.wallClockMs)}  ${cost}`
  );
}

const USAGE = `
bench-run — executes the plan: worktree, arm overlay, agent, grader, gates

  node src/bench-run.ts [options]

  --config <file>           benchmark config               (bench.config.json)
  --manifest <file>         select-prs manifest            (manifest.json)
  --root <dir>              working root                   (from config, or .bench)

selection
  --only-arms A0,A3         only these arms
  --only-tasks id1,id2      only these tasks
  --only-repos a,b          only these repositories
  --from <n>                start at this position in the plan
  --limit <n>               cap on runs in this execution
  --force                   re-execute runs already recorded

execution
  --dry-run                 show what would run, without invoking the agent
  --install-strategy <s>    symlink | copy | fresh | none   (symlink)
  --max-gate-retries <n>    repair turns in gated arms      (config, or 2)
  --pause-ms <n>            pause between runs
  --keep-worktrees          do not delete the worktree (for debugging)

Runs already recorded in obs/runs.jsonl are skipped: you can interrupt and resume.
`;

async function main(): Promise<void> {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    console.log(USAGE.trim());
    return;
  }
  const opts = parseOptions(process.argv.slice(2));
  const cfg = await readJson<BenchConfig>(opts.config);
  if (!cfg) throw new Error(`Config not found: ${opts.config}`);

  const root = path.resolve(opts.root || cfg.root || ".bench");
  const planPath = path.join(root, "plan.json");
  const plan = await readJson<Plan>(planPath);
  if (!plan?.entries?.length) {
    throw new Error(`Plan empty or missing: ${planPath}\n   Run bench-init.ts first.`);
  }

  const manifest = await readJson<Manifest>(opts.manifest);
  if (!manifest?.tasks?.length) throw new Error(`Manifest empty or missing: ${opts.manifest}`);
  const taskById = new Map(manifest.tasks.map((t) => [t.id, t]));

  const agent = resolveAgentConfig(cfg);
  const maxGateRetries =
    opts.maxGateRetries >= 0 ? opts.maxGateRetries : (cfg.maxGateRetries ?? 2);
  const ctx: RunContext = {
    cfg,
    agent,
    root,
    opts: { ...opts, maxGateRetries },
    gateTimeoutMs: cfg.gateTimeoutMs ?? 600_000,
  };

  if (!cfg.model) {
    warn("cfg.model is not set: with no pinned model the result does not hold.");
  }

  const alreadyDone = opts.force ? new Set<string>() : await completedRunIds(root);
  const armCache = new Map<string, Arm>();
  const profileCache = new Map<string, ProjectProfile>();

  const queue = plan.entries.filter((e) => {
    if (e.order < opts.from) return false;
    if (opts.onlyArms.length && !opts.onlyArms.includes(e.arm)) return false;
    if (opts.onlyTasks.length && !opts.onlyTasks.includes(e.taskId)) return false;
    if (opts.onlyRepos.length && !opts.onlyRepos.includes(e.repo)) return false;
    if (alreadyDone.has(e.runId)) return false;
    return true;
  });

  const selected = queue.slice(0, Number.isFinite(opts.limit) ? opts.limit : undefined);

  console.log(bold(`\nbench-run — ${selected.length} run(s) of ${plan.totalRuns} in the plan`));
  info(`model: ${cfg.model ?? dim("(not pinned)")}   root: ${root}`);
  if (alreadyDone.size) info(`${alreadyDone.size} run(s) already recorded will be skipped`);
  if (opts.dryRun) info(yellow("--dry-run: no agent will be invoked"));

  let done = 0;
  let passes = 0;

  for (const entry of selected) {
    const task = taskById.get(entry.taskId);
    if (!task) {
      warn(`${entry.runId}: task ${entry.taskId} is not in the manifest — skipping`);
      continue;
    }

    const armKey = `${entry.repo}/${entry.arm}`;
    let arm = armCache.get(armKey);
    if (!arm) {
      const loaded = await readJson<Arm>(path.join(root, "arms", entry.repo, `${entry.arm}.json`));
      if (!loaded) {
        warn(`${entry.runId}: arm ${armKey} not found — skipping`);
        continue;
      }
      arm = loaded;
      armCache.set(armKey, arm);
    }

    let profile = profileCache.get(entry.repo);
    if (!profile) {
      const loaded = await readJson<ProjectProfile>(
        path.join(root, "projects", `${entry.repo}.json`),
      );
      if (!loaded) {
        warn(`${entry.runId}: profile for ${entry.repo} not found — skipping`);
        continue;
      }
      profile = loaded;
      profileCache.set(entry.repo, profile);
    }

    done++;
    const head = `${cyan(`[${done}/${selected.length}]`)} ${entry.runId} ${dim(`${arm.label} / ${task.title.slice(0, 40)}`)}`;

    if (opts.dryRun) {
      console.log(`${head}\n    ${dim(`worktree @ ${task.baseCommit.slice(0, 8)} | overlay: ${Object.keys(arm.overlay.files).join(", ") || "none"} | gates: ${arm.overlay.enforceGates}`)}`);
      continue;
    }

    console.log(head);
    const record = await executeRun(ctx, entry, task, arm, profile);
    await appendRun(root, record);
    if (record.success) passes++;
    console.log(`    ${summarize(record)}`);
    if (record.notes) console.log(`    ${dim(record.notes)}`);

    if (opts.pauseMs > 0) await new Promise((r) => setTimeout(r, opts.pauseMs));
  }

  console.log("");
  if (opts.dryRun) {
    ok(`${done} run(s) would be executed`);
  } else {
    ok(`${done} run(s) completed, ${passes} approved`);
    info(dim(`results at ${path.join(root, "obs/runs.jsonl")}`));
    info(dim(`analysis:  node src/bench-report.ts --root ${root}`));
  }
}

main().catch((err) => {
  console.log("");
  fail(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
