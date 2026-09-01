import path from "node:path";

import { appendLine, existsSync, readJsonl, writeJson, writeText } from "./fsx.ts";
import type { BenchConfig, RunRecord } from "./types.ts";

/**
 * Observability. One append-only file is the source of truth for results.
 * Never rewrite an existing line: a run interrupted midway leaves a truncated
 * line, which the reader discards, and the next execution redoes that run.
 */

export function obsDir(root: string): string {
  return path.join(root, "obs");
}

export function runsPath(root: string): string {
  return path.join(obsDir(root), "runs.jsonl");
}

export const OBS_SCHEMA = {
  file: "runs.jsonl",
  note: "Append-only. One line per run. Never rewrite an existing line.",
  fields: {
    runId: "string — <arm>.<taskId>.<rep>, with # replaced by -",
    arm: "string",
    taskId: "string — <repo>#<prId>",
    repo: "string",
    rep: "number",
    mode: "vibe | spec",
    model: "string | null — pinned for the whole benchmark",
    startedAt: "ISO",
    endedAt: "ISO",
    wallClockMs: "number — setup + agent + grading",
    agentMs: "number — time inside the agent CLI only",
    exitCode: "number | null",
    agentTurns: "number — 1 = first attempt; >1 = repair after a red gate",
    timedOut: "boolean",
    usageFromStream: "object — tokens summed, cost/credits from the max observed",
    creditsBefore: "number | null — manual snapshot from the dashboard",
    creditsAfter: "number | null",
    creditsDelta: "number | null",
    filesTouched: "string[] — what the agent wrote, before planting the grader",
    filesOutsideGoldenDiff: "string[] — invented-scope metric",
    goldenFilesMissed: "string[] — files from the original PR the agent never touched",
    heldOutOverwrites: "string[] — tests the agent wrote that the grader overwrote",
    gates: "{ lint, typecheck, arch } — true | false | null (not applicable)",
    gateDetail: "array of command, exit code, duration and truncated output",
    heldOutTests: "{ passed, failed, total, ran }",
    success: "boolean — every held-out test passes AND no gate is red",
    status: "ok | agent-failed | setup-failed | graded-failed",
    notes: "string",
  },
  derived: {
    creditsPerSuccess: "sum(cost) / count(success) per arm — the deciding metric",
    pass1: "count(success) / count(runs) per arm",
    scopeCreep: "mean(filesOutsideGoldenDiff.length) per arm",
    completeness: "mean(1 - goldenFilesMissed/goldenFiles) per arm — half-done task",
  },
};

export async function appendRun(root: string, record: RunRecord): Promise<void> {
  await appendLine(runsPath(root), JSON.stringify(record));
}

export async function loadRuns(root: string): Promise<RunRecord[]> {
  return await readJsonl<RunRecord>(runsPath(root));
}

/** Runs already recorded, by runId. The runner uses it to resume where it stopped. */
export async function completedRunIds(root: string): Promise<Set<string>> {
  const runs = await loadRuns(root);
  return new Set(runs.map((r) => r.runId));
}

export async function scaffoldObservability(root: string, cfg: BenchConfig): Promise<void> {
  const dir = obsDir(root);
  await writeJson(path.join(dir, "schema.json"), OBS_SCHEMA);

  if (!existsSync(runsPath(root))) await writeText(runsPath(root), "");

  const creditsFile = path.join(dir, "credits.json");
  if (!existsSync(creditsFile)) {
    await writeJson(creditsFile, {
      note:
        "Manual credit snapshots. Use these when the CLI stream exposes no usage. " +
        "Run the arms serially and record the dashboard balance before and after each block. " +
        "bench-report matches these snapshots to runs by time interval.",
      model: cfg.model ?? "RECORD THE PINNED MODEL HERE",
      snapshots: [
        {
          _example: true,
          at: "2026-01-01T10:00:00Z",
          balance: 0,
          label: "before block A0",
        },
      ],
    });
  }

  const preReg = path.join(dir, "PRE-REGISTRATION.md");
  if (!existsSync(preReg)) {
    await writeText(
      preReg,
      `# Benchmark pre-registration

Fill this in BEFORE looking at any result. It protects you from later picking
the number that confirms what you already wanted.

## Adoption criterion

> I adopt the winning arm if: ______________________________________
> (example: credits per approved task drop >= 30% against A0, with no pass@1 loss)

## Primary metric

Credits per approved task.

## Secondary metrics

pass@1, files outside the golden diff, golden files never touched, wall-clock.

## Pinned model

${cfg.model ?? "(define before running)"}

## Repetitions per cell

${cfg.reps ?? 3}

## What invalidates this benchmark

- [ ] variance between reps larger than the difference between arms
- [ ] fewer than 3 reps per cell
- [ ] arms run in a fixed order (service drift becomes a fake effect)
- [ ] model switched midway
- [ ] low-confidence semantic profile feeding the steering of A2 onwards

## Decision recorded on ____ / ____ / ______, by ______________________
`,
    );
  }
}
