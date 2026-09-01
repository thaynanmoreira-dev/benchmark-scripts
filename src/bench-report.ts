#!/usr/bin/env node
/**
 * bench-report.ts
 *
 * Reads obs/runs.jsonl and answers the benchmark's question:
 * which arm delivers the most approved tasks per credit spent.
 *
 * Primary metric: cost per approved task. Not raw pass@1 — a cheap arm that
 * fails half the time costs more in total than an expensive arm that lands it.
 *
 * It also runs the validity checks. If the variance between reps is larger
 * than the difference between arms, the benchmark concluded nothing, and the
 * report says so instead of letting you pick whichever number you like.
 *
 * Usage:
 *   node src/bench-report.ts --root .bench
 *   node src/bench-report.ts --by-task --markdown report.md
 *
 * No external dependencies. Node >= 22.6.
 */

import path from "node:path";

import { readArgs } from "./lib/args.ts";
import { readJson, writeJson, writeText } from "./lib/fsx.ts";
import { bold, cyan, dim, fail, green, info, ok, red, rule, table, warn, yellow } from "./lib/log.ts";
import { loadRuns } from "./lib/obs.ts";
import { fmtMs, mcnemar, mean, stdev, wilson } from "./lib/stats.ts";
import type { BenchConfig, Plan, RunRecord } from "./lib/types.ts";

interface CreditSnapshot {
  at: string;
  balance: number;
  label?: string;
  _exemplo?: boolean;
}

interface ArmStats {
  arm: string;
  label: string;
  runs: number;
  cells: number;
  successes: number;
  pass1: number;
  pass1Lo: number;
  pass1Hi: number;
  costTotal: number | null;
  costPerRun: number | null;
  costPerSuccess: number | null;
  costUnit: string;
  tokensPerRun: number | null;
  scopeCreep: number;
  completeness: number;
  turns: number;
  wallClockMs: number;
  /** Cost deviation within the same cell (arm x task). */
  withinCellStdev: number;
  setupFailures: number;
  timeouts: number;
}

// ─────────────────────────────────────────────────── cost per run

type CostUnit = "credits" | "USD" | "tokens" | "n/a";

/**
 * Picks ONE cost unit for the whole report, ordered by how directly it answers
 * the team's question. Mixing units between arms would produce a meaningless
 * comparison, so the unit is global.
 */
function pickCostUnit(runs: RunRecord[]): CostUnit {
  if (runs.some((r) => r.creditsDelta !== null || r.usageFromStream.credits !== null)) {
    return "credits";
  }
  if (runs.some((r) => r.usageFromStream.costUsd !== null)) return "USD";
  if (runs.some((r) => r.usageFromStream.totalTokens !== null)) return "tokens";
  return "n/a";
}

function costOf(run: RunRecord, unit: CostUnit): number | null {
  switch (unit) {
    case "credits":
      return run.creditsDelta ?? run.usageFromStream.credits;
    case "USD":
      return run.usageFromStream.costUsd;
    case "tokens":
      return run.usageFromStream.totalTokens;
    default:
      return null;
  }
}

/**
 * Spreads a hand-read credit balance across the runs in each window.
 *
 * This only works if the arms were run SERIALLY, with one snapshot before and
 * another after each block. Outside that the number is fiction, and the report
 * says so.
 */
function attributeManualCredits(runs: RunRecord[], snapshots: CreditSnapshot[]): number {
  const valid = snapshots
    .filter((s) => !s._exemplo && s.at && typeof s.balance === "number")
    .sort((a, b) => a.at.localeCompare(b.at));
  if (valid.length < 2) return 0;

  let attributed = 0;
  for (let i = 0; i < valid.length - 1; i++) {
    const from = valid[i];
    const to = valid[i + 1];
    const spent = from.balance - to.balance;
    if (spent <= 0) continue;
    const inWindow = runs.filter((r) => r.startedAt >= from.at && r.startedAt < to.at);
    if (inWindow.length === 0) continue;
    const share = spent / inWindow.length;
    for (const r of inWindow) {
      r.creditsBefore = from.balance;
      r.creditsAfter = to.balance;
      r.creditsDelta = share;
      attributed++;
    }
  }
  return attributed;
}

// ─────────────────────────────────────────────────── aggregation

function cellKey(r: RunRecord): string {
  return `${r.arm}|${r.taskId}`;
}

function completenessOf(run: RunRecord): number {
  const missed = run.goldenFilesMissed.length;
  const touchedGolden = run.filesTouched.length - run.filesOutsideGoldenDiff.length;
  const totalGolden = missed + touchedGolden;
  if (totalGolden <= 0) return missed === 0 ? 1 : 0;
  return Math.max(0, Math.min(1, touchedGolden / totalGolden));
}

function aggregate(runs: RunRecord[], unit: CostUnit, labels: Map<string, string>): ArmStats[] {
  const byArm = new Map<string, RunRecord[]>();
  for (const r of runs) {
    const list = byArm.get(r.arm) ?? [];
    list.push(r);
    byArm.set(r.arm, list);
  }

  const stats: ArmStats[] = [];
  for (const [arm, armRuns] of byArm) {
    const successes = armRuns.filter((r) => r.success).length;
    const [lo, hi] = wilson(successes, armRuns.length);
    const costs = armRuns.map((r) => costOf(r, unit)).filter((c): c is number => c !== null);
    const costTotal = costs.length ? costs.reduce((a, b) => a + b, 0) : null;

    // within-cell variance: reps of the same (arm x task)
    const cells = new Map<string, number[]>();
    for (const r of armRuns) {
      const c = costOf(r, unit);
      if (c === null) continue;
      const key = cellKey(r);
      cells.set(key, [...(cells.get(key) ?? []), c]);
    }
    const withinCellStdev = mean(
      [...cells.values()].filter((v) => v.length > 1).map((v) => stdev(v)),
    );

    const tokens = armRuns
      .map((r) => r.usageFromStream.totalTokens)
      .filter((t): t is number => t !== null);

    stats.push({
      arm,
      label: labels.get(arm) ?? "",
      runs: armRuns.length,
      cells: new Set(armRuns.map(cellKey)).size,
      successes,
      pass1: armRuns.length ? successes / armRuns.length : 0,
      pass1Lo: lo,
      pass1Hi: hi,
      costTotal,
      costPerRun: costTotal !== null && costs.length ? costTotal / costs.length : null,
      costPerSuccess: costTotal !== null && successes > 0 ? costTotal / successes : null,
      costUnit: unit,
      tokensPerRun: tokens.length ? mean(tokens) : null,
      scopeCreep: mean(armRuns.map((r) => r.filesOutsideGoldenDiff.length)),
      completeness: mean(armRuns.map(completenessOf)),
      turns: mean(armRuns.map((r) => r.agentTurns)),
      wallClockMs: mean(armRuns.map((r) => r.wallClockMs)),
      withinCellStdev,
      setupFailures: armRuns.filter((r) => r.status === "setup-failed" || r.status === "agent-failed")
        .length,
      timeouts: armRuns.filter((r) => r.timedOut).length,
    });
  }

  return stats.sort((a, b) => a.arm.localeCompare(b.arm));
}

// ─────────────────────────────────────────────────── paired comparison

interface Paired {
  arm: string;
  onlyBaseline: number;
  onlyTreatment: number;
  both: number;
  neither: number;
  p: number;
}

/** A task passes in an arm if the majority of its repetitions passed. */
function passedByTask(runs: RunRecord[], arm: string): Map<string, boolean> {
  const byTask = new Map<string, RunRecord[]>();
  for (const r of runs) {
    if (r.arm !== arm) continue;
    byTask.set(r.taskId, [...(byTask.get(r.taskId) ?? []), r]);
  }
  const out = new Map<string, boolean>();
  for (const [task, list] of byTask) {
    const ok = list.filter((r) => r.success).length;
    out.set(task, ok * 2 > list.length);
  }
  return out;
}

/**
 * Compares each arm to the baseline ON THE SAME TASKS.
 *
 * Two loose success rates hide the fact that the arms ran the same set: what
 * separates one from the other are the tasks where they disagreed, nothing else.
 */
function comparePaired(runs: RunRecord[], baselineId: string): Paired[] {
  const base = passedByTask(runs, baselineId);
  const arms = [...new Set(runs.map((r) => r.arm))].filter((a) => a !== baselineId).sort();

  return arms.map((arm) => {
    const treatment = passedByTask(runs, arm);
    let onlyBaseline = 0;
    let onlyTreatment = 0;
    let both = 0;
    let neither = 0;
    for (const [task, baselinePassed] of base) {
      const treatmentPassed = treatment.get(task);
      if (treatmentPassed === undefined) continue;
      if (baselinePassed && treatmentPassed) both++;
      else if (baselinePassed) onlyBaseline++;
      else if (treatmentPassed) onlyTreatment++;
      else neither++;
    }
    return { arm, onlyBaseline, onlyTreatment, both, neither, p: mcnemar(onlyBaseline, onlyTreatment).p };
  });
}

/**
 * A task only discriminates if the baseline sometimes passes and sometimes fails.
 *
 * If the baseline always passes there is nothing to improve; if it always fails
 * the problem is the task, not the configuration. Either way it enters the
 * tally pulling the mean and carries no information about which arm is better.
 */
function screenForDiscrimination(
  runs: RunRecord[],
  baselineId: string,
): { task: string; rate: number; verdict: string }[] {
  const byTask = new Map<string, RunRecord[]>();
  for (const r of runs) {
    if (r.arm !== baselineId) continue;
    byTask.set(r.taskId, [...(byTask.get(r.taskId) ?? []), r]);
  }
  const out: { task: string; rate: number; verdict: string }[] = [];
  for (const [task, list] of byTask) {
    const rate = list.filter((r) => r.success).length / list.length;
    const verdict =
      rate >= 0.9 ? "too easy" : rate <= 0.1 ? "too hard" : "discriminates";
    out.push({ task, rate, verdict });
  }
  return out.sort((a, b) => a.rate - b.rate);
}

// ─────────────────────────────────────────────────── validity

interface Validity {
  level: "ok" | "warning" | "invalid";
  messages: string[];
}

function checkValidity(runs: RunRecord[], stats: ArmStats[], plan: Plan | null): Validity {
  const messages: string[] = [];
  let level: Validity["level"] = "ok";
  const escalate = (l: Validity["level"]): void => {
    if (l === "invalid" || (l === "warning" && level === "ok")) level = l;
  };

  const models = new Set(runs.map((r) => r.model ?? "(not pinned)"));
  if (models.size > 1) {
    escalate("invalid");
    messages.push(
      `The model changed midway through the benchmark: ${[...models].join(", ")}. ` +
        `The comparison between arms does not hold — redo it with a single model.`,
    );
  }
  if (models.has("(not pinned)")) {
    escalate("warning");
    messages.push("Some runs have no recorded model. Pin cfg.model before running.");
  }

  const cellCounts = new Map<string, number>();
  for (const r of runs) cellCounts.set(cellKey(r), (cellCounts.get(cellKey(r)) ?? 0) + 1);
  const thin = [...cellCounts.entries()].filter(([, n]) => n < 3);
  if (thin.length) {
    escalate("warning");
    messages.push(
      `${thin.length} cell(s) with fewer than 3 repetitions. The agent is stochastic: ` +
        `with n < 3 the difference between arms may be pure chance.`,
    );
  }

  if (plan && runs.length < plan.totalRuns) {
    escalate("warning");
    messages.push(
      `${plan.totalRuns - runs.length} of ${plan.totalRuns} planned runs have not run yet. ` +
        `Comparing arms with uneven coverage biases the result.`,
    );
  }

  const withCost = stats.filter((s) => s.costPerRun !== null);
  if (withCost.length >= 2) {
    const costs = withCost.map((s) => s.costPerRun as number);
    const spread = Math.max(...costs) - Math.min(...costs);
    const noise = Math.max(...withCost.map((s) => s.withinCellStdev));
    if (noise > 0 && noise > spread) {
      escalate("invalid");
      messages.push(
        `Noise larger than signal: the variation between repetitions of the SAME cell ` +
          `(stdev ${num(noise)}) exceeds the difference between arms (${num(spread)}). ` +
          `This benchmark concludes nothing: what separates the arms fits inside the ` +
          `chance interval. Raise the repetitions or pick less noisy tasks.`,
      );
    }
  }

  const brokenRuns = runs.filter(
    (r) => r.status === "setup-failed" || r.status === "agent-failed",
  );
  if (brokenRuns.length > runs.length * 0.1) {
    escalate("warning");
    messages.push(
      `${brokenRuns.length} run(s) failed before any grading (setup or agent). ` +
        `Investigate .bench/logs/ before reading the numbers.`,
    );
  }

  const noGrader = runs.filter((r) => !r.heldOutTests.ran).length;
  if (noGrader) {
    escalate("warning");
    messages.push(
      `${noGrader} run(s) with no held-out grader executed: those tasks can never be ` +
        `approved. Run select-prs with --require-tests.`,
    );
  }

  return { level, messages };
}

// ─────────────────────────────────────────────────── output

function pct(v: number): string {
  return `${(v * 100).toFixed(0)}%`;
}

/** Adaptive precision: cost in USD and in tokens do not share a scale. */
function num(v: number | null): string {
  if (v === null) return "-";
  const abs = Math.abs(v);
  const digits = abs === 0 ? 0 : abs < 0.01 ? 4 : abs < 1 ? 3 : abs < 100 ? 2 : 0;
  return v.toLocaleString("en-US", { maximumFractionDigits: digits });
}

function delta(value: number | null, baseline: number | null, lowerIsBetter: boolean): string {
  if (value === null || baseline === null || baseline === 0) return "";
  const change = (value - baseline) / baseline;
  if (Math.abs(change) < 0.005) return dim("=");
  const better = lowerIsBetter ? change < 0 : change > 0;
  const text = `${change > 0 ? "+" : ""}${(change * 100).toFixed(0)}%`;
  return better ? green(text) : red(text);
}

function printReport(stats: ArmStats[], unit: CostUnit, baselineId: string): void {
  const baseline = stats.find((s) => s.arm === baselineId) ?? stats[0];

  rule(`cost per approved task (${unit})`);
  table(
    [
      { header: "arm", width: 4 },
      { header: "configuration", width: 28 },
      { header: "runs", width: 5, align: "right" },
      { header: "pass@1", width: 7, align: "right" },
      { header: "CI95", width: 13, align: "right" },
      { header: `cost/run`, width: 10, align: "right" },
      { header: `cost/passed`, width: 12, align: "right" },
      { header: `vs ${baseline?.arm ?? "-"}`, width: 12, align: "right" },
    ],
    stats.map((s) => [
      s.arm,
      s.label.slice(0, 28),
      String(s.runs),
      pct(s.pass1),
      `${pct(s.pass1Lo)}..${pct(s.pass1Hi)}`,
      num(s.costPerRun),
      num(s.costPerSuccess),
      delta(s.costPerSuccess, baseline?.costPerSuccess ?? null, true),
    ]),
  );

  rule("quality and behaviour");
  table(
    [
      { header: "arm", width: 4 },
      { header: "invented scope", width: 17, align: "right" },
      { header: "completeness", width: 11, align: "right" },
      { header: "turns", width: 7, align: "right" },
      { header: "wall-clock", width: 11, align: "right" },
      { header: "noise/cell", width: 13, align: "right" },
      { header: "broken", width: 10, align: "right" },
    ],
    stats.map((s) => [
      s.arm,
      `${s.scopeCreep.toFixed(2)} files/run`,
      pct(s.completeness),
      s.turns.toFixed(1),
      fmtMs(s.wallClockMs),
      num(s.withinCellStdev),
      `${s.setupFailures}${s.timeouts ? ` (+${s.timeouts} t/o)` : ""}`,
    ]),
  );
}

function printPaired(paired: Paired[], baselineId: string): void {
  rule(`paired comparison against ${baselineId}`);
  table(
    [
      { header: "arm", width: 4 },
      { header: `${baselineId} only`, width: 10, align: "right" },
      { header: "arm only", width: 9, align: "right" },
      { header: "both", width: 8, align: "right" },
      { header: "none", width: 7, align: "right" },
      { header: "p (McNemar)", width: 12, align: "right" },
      { header: "reading", width: 26 },
    ],
    paired.map((x) => {
      const disagreements = x.onlyBaseline + x.onlyTreatment;
      const reading =
        disagreements === 0
          ? dim("tied on everything")
          : disagreements < 6
            ? yellow(`only ${disagreements} disagreement(s)`)
            : x.p < 0.05
              ? x.onlyTreatment > x.onlyBaseline
                ? green("better than the baseline")
                : red("worse than the baseline")
              : "difference not separable";
      return [
        x.arm,
        String(x.onlyBaseline),
        String(x.onlyTreatment),
        String(x.both),
        String(x.neither),
        x.p < 0.0001 ? "<0.0001" : x.p.toFixed(4),
        reading,
      ];
    }),
  );
  console.log(
    dim(
      "  Only the tasks where the arms disagreed carry information. With fewer than\n" +
        "  six disagreements the test concludes nothing, however different the means look.",
    ),
  );
}

function printDiscrimination(
  items: { task: string; rate: number; verdict: string }[],
  baselineId: string,
): void {
  const useless = items.filter((i) => i.verdict !== "discriminates");
  if (useless.length === 0) return;

  rule("tasks that do not discriminate");
  table(
    [
      { header: "task", width: 30 },
      { header: `${baselineId} passes`, width: 12, align: "right" },
      { header: "verdict", width: 16 },
    ],
    useless.map((i) => [i.task.slice(0, 30), pct(i.rate), i.verdict]),
  );
  console.log(
    dim(
      `  ${useless.length} of ${items.length} task(s) do not separate the arms: the baseline\n` +
        "  always passes or always fails. They enter the mean carrying no information.\n" +
        "  Replace them with tasks the baseline passes between 30% and 70% of the time.",
    ),
  );
}

function printByTask(runs: RunRecord[], unit: CostUnit): void {
  rule("by task");
  const tasks = [...new Set(runs.map((r) => r.taskId))].sort();
  const arms = [...new Set(runs.map((r) => r.arm))].sort();

  table(
    [
      { header: "task", width: 26 },
      ...arms.map((a) => ({ header: a, width: 9, align: "right" as const })),
    ],
    tasks.map((task) => [
      task.slice(0, 26),
      ...arms.map((arm) => {
        const cell = runs.filter((r) => r.taskId === task && r.arm === arm);
        if (cell.length === 0) return "-";
        const okCount = cell.filter((r) => r.success).length;
        const costs = cell.map((r) => costOf(r, unit)).filter((c): c is number => c !== null);
        return `${okCount}/${cell.length}${costs.length ? dim(` ${num(mean(costs))}`) : ""}`;
      }),
    ]),
  );
}

function markdown(stats: ArmStats[], unit: CostUnit, validity: Validity, baselineId: string): string {
  const baseline = stats.find((s) => s.arm === baselineId) ?? stats[0];
  const rows = stats
    .map(
      (s) =>
        `| ${s.arm} | ${s.label} | ${s.runs} | ${pct(s.pass1)} | ${num(s.costPerRun)} | ` +
        `${num(s.costPerSuccess)} | ${s.scopeCreep.toFixed(2)} | ${pct(s.completeness)} |`,
    )
    .join("\n");

  const best = stats
    .filter((s) => s.costPerSuccess !== null)
    .sort((a, b) => (a.costPerSuccess as number) - (b.costPerSuccess as number))[0];

  return `# Configuration benchmark result

Generated at ${new Date().toISOString()}. Cost unit: **${unit}**.
Baseline: **${baseline?.arm ?? "-"}**.

## Primary metric — cost per approved task

| arm | configuration | runs | pass@1 | cost/run | cost/passed | invented scope | completeness |
|---|---|---|---|---|---|---|---|
${rows}

${
  best
    ? `Lowest cost per approved task: **${best.arm} — ${best.label}** ` +
      `(${num(best.costPerSuccess)} ${unit} per approved task, pass@1 ${pct(best.pass1)}).`
    : "No arm recorded any cost: use the manual snapshots in obs/credits.json."
}

## Validity

Status: **${validity.level}**

${validity.messages.length ? validity.messages.map((m) => `- ${m}`).join("\n") : "- No problem detected by the automatic checks."}

## Before adopting

Compare the number above with the criterion you wrote in \`obs/PRE-REGISTRATION.md\`
**before** looking at this data. If the criterion was not met, the winner here is
no reason to change anything.

An offline benchmark measures isolated tasks. It does not measure day-to-day
friction, a hook the dev works around, or the accumulated context of a
three-day feature. Validate the winner with two weeks of real use before
settling the question.
`;
}

// ─────────────────────────────────────────────────── main

const USAGE = `
bench-report — cost per approved task, per arm, with validity checks

  node src/bench-report.ts [options]

  --root <dir>              working root                   (from config, or .bench)
  --config <file>           config, only to find the root  (bench.config.json)
  --baseline <arm>          arm to compare against         (A0)
  --only-arms A0,A3         restrict the analysis
  --by-task                 break the result down by task
  --markdown <file>         write the report as markdown
`;

async function main(): Promise<void> {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    console.log(USAGE.trim());
    return;
  }
  const a = readArgs(process.argv.slice(2));
  const configPath = a.str("--config", "bench.config.json") as string;
  const cfg = await readJson<BenchConfig>(configPath);
  const root = path.resolve(a.str("--root", "") || cfg?.root || ".bench");
  const baselineId = a.str("--baseline", "A0") as string;

  const runs = await loadRuns(root);
  if (runs.length === 0) {
    throw new Error(
      `No run in ${path.join(root, "obs/runs.jsonl")}.\n   Run bench-run.ts first.`,
    );
  }

  const filterArms = a.list("--only-arms");
  const filtered = filterArms.length ? runs.filter((r) => filterArms.includes(r.arm)) : runs;

  // dedup: the same runId counts once, and the most recent record wins
  const byId = new Map<string, RunRecord>();
  for (const r of filtered) byId.set(r.runId, r);
  const unique = [...byId.values()];
  const duplicates = filtered.length - unique.length;

  const credits = await readJson<{ snapshots: CreditSnapshot[] }>(
    path.join(root, "obs", "credits.json"),
  );
  const attributed = attributeManualCredits(unique, credits?.snapshots ?? []);

  const unit = pickCostUnit(unique);
  const plan = await readJson<Plan>(path.join(root, "plan.json"));

  const labels = new Map<string, string>();
  for (const r of unique) {
    if (labels.has(r.arm)) continue;
    const arm = await readJson<{ label: string }>(
      path.join(root, "arms", r.repo, `${r.arm}.json`),
    );
    if (arm?.label) labels.set(r.arm, arm.label);
  }

  const stats = aggregate(unique, unit, labels);
  const validity = checkValidity(unique, stats, plan);

  console.log(bold(`\nbench-report — ${unique.length} run(s), ${stats.length} arm(s)`));
  info(`cost unit: ${unit === "n/a" ? yellow("none") : cyan(unit)}   root: ${root}`);
  if (attributed) info(`${attributed} run(s) with credits attributed from a manual snapshot`);
  if (duplicates) info(dim(`${duplicates} duplicated runId line(s) ignored`));

  printReport(stats, unit, baselineId);

  const paired = comparePaired(unique, baselineId);
  if (paired.length > 0) printPaired(paired, baselineId);

  const discrimination = screenForDiscrimination(unique, baselineId);
  printDiscrimination(discrimination, baselineId);

  if (a.bool("--by-task")) printByTask(unique, unit);

  rule("validity");
  if (validity.messages.length === 0) {
    ok("no problem detected by the automatic checks");
  } else {
    for (const m of validity.messages) {
      if (validity.level === "invalid") fail(m);
      else warn(m);
    }
  }

  if (unit === "n/a") {
    warn(
      "No cost recorded. The CLI stream exposes no usage: run the arms serially and " +
        `fill in the snapshots at ${path.join(root, "obs/credits.json")}.`,
    );
  }

  await writeJson(path.join(root, "obs", "report.json"), {
    generatedAt: new Date().toISOString(),
    root,
    costUnit: unit,
    baseline: baselineId,
    totalRuns: unique.length,
    arms: stats,
    paired,
    discrimination,
    validity,
  });

  const mdPath = a.str("--markdown");
  if (mdPath) {
    await writeText(mdPath, markdown(stats, unit, validity, baselineId));
    info(`markdown at ${mdPath}`);
  }

  console.log("");
  ok(`report at ${path.join(root, "obs/report.json")}`);
  info(
    dim(
      "Compare it with the adoption criterion you wrote BEFORE looking at these numbers, " +
        `in ${path.join(root, "obs/PRE-REGISTRATION.md")}.`,
    ),
  );
}

main().catch((err) => {
  console.log("");
  fail(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
