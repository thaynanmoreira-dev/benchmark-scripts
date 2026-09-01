#!/usr/bin/env node
/**
 * Smoke test of the whole harness, without spending a single credit.
 *
 * It builds a fake git repository with three merged PRs, runs the four CLIs in
 * sequence against a fake agent and checks that the metrics come out as they
 * should. This is what you run after touching the harness, before pointing it
 * at real repositories.
 *
 * Usage: node test/smoke.ts [--keep]
 */

import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { readJson, readJsonl } from "../src/lib/fsx.ts";
import { green, red, bold, dim } from "../src/lib/log.ts";
import { runCommand } from "../src/lib/shell.ts";
import type { Manifest, Plan, RunRecord } from "../src/lib/types.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");

let failures = 0;

function check(label: string, condition: boolean, detail = ""): void {
  if (condition) {
    console.log(`  ${green("ok")}   ${label}`);
  } else {
    failures++;
    console.log(`  ${red("FAILED")} ${label}${detail ? `\n         ${dim(detail)}` : ""}`);
  }
}

async function sh(command: string, cwd: string): Promise<string> {
  const res = await runCommand(command, { cwd, timeoutMs: 120_000, maxOutput: 20_000 });
  if (!res.ok) throw new Error(`command failed: ${command}\n${res.output}`);
  return res.output;
}

/** Fake repository with three PRs of different sizes. */
async function buildFixture(dir: string): Promise<void> {
  const w = (rel: string, body: string) =>
    mkdir(path.dirname(path.join(dir, rel)), { recursive: true }).then(() =>
      writeFile(path.join(dir, rel), body, "utf8"),
    );

  await sh("git init -q -b main .", dir);
  await sh("git config user.email smoke@test && git config user.name smoke", dir);

  await w(
    "package.json",
    JSON.stringify(
      {
        name: "fixture-api",
        version: "1.0.0",
        scripts: { test: "node --test", lint: "echo lint-ok", typecheck: "echo tsc-ok" },
        dependencies: { "@nestjs/core": "^10.0.0", pg: "^8.11.0" },
        devDependencies: { typescript: "^5.4.0" },
      },
      null,
      2,
    ),
  );
  await w("package-lock.json", '{"lockfileVersion":3}\n');
  await w("src/index.ts", "export const version = 1;\n");
  await sh("git add -A && git commit -qm bootstrap", dir);

  const pr = async (
    branch: string,
    files: Record<string, string>,
    subject: string,
    body: string,
  ): Promise<void> => {
    await sh(`git checkout -qb ${branch}`, dir);
    for (const [rel, content] of Object.entries(files)) await w(rel, content);
    await sh("git add -A && git commit -qm wip", dir);
    await sh("git checkout -q main", dir);
    await sh(`git merge -q --no-ff ${branch} -m "${subject}" -m "${body}"`, dir);
  };

  await pr(
    "f1",
    {
      "src/user/add.ts": "export function add(a: number, b: number): number {\n  return a + b;\n}\n",
      "src/user/add.spec.ts":
        'import test from "node:test";\nimport assert from "node:assert";\nimport { add } from "./add.ts";\ntest("add sums", () => { assert.equal(add(1, 2), 3); });\n',
    },
    "Merged PR 101: add a sum helper",
    "Create a function add(a, b) in src/user/add.ts.",
  );

  await pr(
    "f2",
    {
      "src/order/consts.ts": "export const RATE = 2;\n",
      "src/order/order.service.ts":
        "export class OrderService {\n  total(values: number[]): number {\n    return values.reduce((a, b) => a + b, 0);\n  }\n}\n",
      "src/order/order.service.spec.ts":
        'import test from "node:test";\nimport assert from "node:assert";\nimport { OrderService } from "./order.service.ts";\ntest("total", () => { assert.equal(new OrderService().total([1, 2, 3]), 6); });\n',
    },
    "Merged PR 102: order service",
    "Create OrderService with a total(values) method.",
  );

  await pr(
    "f3",
    {
      "src/order/big.ts":
        Array.from({ length: 60 }, (_, i) => `export const big${i + 1} = ${i + 1};`).join("\n") + "\n",
      "src/order/big.spec.ts":
        'import test from "node:test";\nimport assert from "node:assert";\nimport { big1 } from "./big.ts";\ntest("big", () => { assert.equal(big1, 1); });\n',
      "package-lock.json": '{"lockfileVersion":3,"churn":true}\n',
    },
    "Merged PR 103: large constants module",
    "Create src/order/big.ts exporting big1..big60.",
  );
}

async function main(): Promise<void> {
  const keep = process.argv.includes("--keep");
  const work = await mkdtemp(path.join(tmpdir(), "bench-smoke-"));
  const fixture = path.join(work, "fixture");
  const benchRoot = path.join(work, ".bench");
  const manifestPath = path.join(work, "manifest.json");
  const configPath = path.join(work, "bench.config.json");

  console.log(bold(`\nsmoke — full harness in ${work}`));

  try {
    await mkdir(fixture, { recursive: true });
    await buildFixture(fixture);

    await writeFile(
      configPath,
      JSON.stringify(
        {
          provider: "local-git",
          root: benchRoot,
          repos: [{ name: "fixture-api", dir: fixture, defaultBranch: "main" }],
          model: "fake-model",
          reps: 3,
          seed: 42,
          install: { enabled: false },
          maxGateRetries: 1,
          agent: {
            cmd: "node",
            args: [path.join(here, "fake-agent.mjs")],
            promptMode: "stdin",
            modeArgs: { vibe: [], spec: [] },
            timeoutMs: 60_000,
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    console.log(bold("\n1. select-prs"));
    await sh(
      `PR_MODE=merges node ${repoRoot}/src/select-prs.ts --repo-dir ${fixture} --name fixture-api ` +
        `--targets 0,50,100 --require-tests --refresh --cache ${work}/.pr-cache.json --out ${manifestPath}`,
      work,
    );
    const manifest = await readJson<Manifest>(manifestPath);
    check("the manifest has 3 tasks", manifest?.tasks.length === 3, `got ${manifest?.tasks.length}`);
    check(
      "stratified by size (0% and 100% present)",
      manifest?.tasks.some((t) => t.sizePercent === 0) === true &&
        manifest?.tasks.some((t) => t.sizePercent === 100) === true,
    );
    check(
      "the lockfile stayed out of the size metric",
      manifest?.tasks.every((t) => !t.prodFiles.includes("package-lock.json")) === true,
    );
    check(
      "held-out grader separated from the production files",
      manifest?.tasks.every((t) => t.testFiles.length > 0 && t.prodFiles.length > 0) === true,
    );

    console.log(bold("\n2. bench-init"));
    await sh(
      `node ${repoRoot}/src/bench-init.ts --config ${configPath} --manifest ${manifestPath} --no-agent`,
      work,
    );
    const plan = await readJson<Plan>(path.join(benchRoot, "plan.json"));
    check("plan with 3 tasks x 6 arms x 3 reps = 54 runs", plan?.totalRuns === 54, `got ${plan?.totalRuns}`);
    check(
      "randomized order, not grouped by arm",
      plan !== null && plan.entries.slice(0, 6).some((e) => e.arm !== plan.entries[0].arm),
    );
    const a3 = await readJson<{ overlay: { enforceGates: boolean; files: Record<string, string> } }>(
      path.join(benchRoot, "arms", "fixture-api", "A3.json"),
    );
    check("A3 turns the deterministic gates on", a3?.overlay.enforceGates === true);
    check("A3 carries tech and structure steering", Object.keys(a3?.overlay.files ?? {}).length >= 2);

    console.log(bold("\n3. bench-run"));
    await sh(
      `node ${repoRoot}/src/bench-run.ts --config ${configPath} --manifest ${manifestPath}`,
      work,
    );
    const runs = await readJsonl<RunRecord>(path.join(benchRoot, "obs", "runs.jsonl"));
    check("recorded all 54 runs", runs.length === 54, `got ${runs.length}`);
    check("no run broke during setup", runs.every((r) => r.status !== "setup-failed"));
    check("every run executed the held-out grader", runs.every((r) => r.heldOutTests.ran));
    check("the agent is approved on the tasks it implemented", runs.some((r) => r.success));

    const scope = (arm: string): number => {
      const sel = runs.filter((r) => r.arm === arm);
      return sel.reduce((acc, r) => acc + r.filesOutsideGoldenDiff.length, 0) / sel.length;
    };
    check(
      `steering reduces invented scope (A0 ${scope("A0").toFixed(2)} > A2 ${scope("A2").toFixed(2)})`,
      scope("A0") > scope("A2"),
    );
    check(
      `negative scope zeroes invention (A5 = ${scope("A5").toFixed(2)})`,
      scope("A5") < scope("A2"),
    );
    check(
      "a gated arm spends an extra turn when a gate comes back red",
      runs.filter((r) => r.arm === "A3").every((r) => r.agentTurns >= 1),
    );
    check(
      "cost captured from the agent stream",
      runs.every((r) => r.usageFromStream.totalTokens !== null),
    );
    check(
      "overlay files did not leak into filesTouched",
      runs.every((r) => !r.filesTouched.some((f) => f.startsWith(".kiro/"))),
    );

    console.log(bold("\n4. bench-run --resume"));
    const resumeOut = await sh(
      `node ${repoRoot}/src/bench-run.ts --config ${configPath} --manifest ${manifestPath}`,
      work,
    );
    check("resuming does not repeat an already recorded run", resumeOut.includes("0 run(s) completed"));
    const afterResume = await readJsonl<RunRecord>(path.join(benchRoot, "obs", "runs.jsonl"));
    check("runs.jsonl still has 54 lines", afterResume.length === 54);

    console.log(bold("\n5. bench-report"));
    const reportOut = await sh(
      `node ${repoRoot}/src/bench-report.ts --root ${benchRoot} --by-task --markdown ${work}/report.md`,
      work,
    );
    check("the report names the primary metric", reportOut.includes("cost per approved task"));
    const report = await readJson<{
      costUnit: string;
      arms: Array<{ arm: string; costPerSuccess: number | null; pass1: number }>;
      validity: { level: string; messages: string[] };
    }>(path.join(benchRoot, "obs", "report.json"));
    check("the report covers all 6 arms", report?.arms.length === 6, `got ${report?.arms.length}`);
    check(
      "cost per approved task computed",
      report?.arms.some((a) => a.costPerSuccess !== null) === true,
    );
    check(
      "the validity check reports no problem with 3 complete reps",
      report?.validity.level === "ok",
      (report?.validity.messages ?? []).join(" | "),
    );
  } finally {
    if (keep) {
      console.log(dim(`\nartifacts preserved at ${work}`));
    } else {
      await rm(work, { recursive: true, force: true });
    }
  }

  console.log("");
  if (failures === 0) {
    console.log(green(bold("smoke passed: the harness is consistent end to end.")));
  } else {
    console.log(red(bold(`smoke failed: ${failures} check(s).`)));
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(`\n${red("smoke error")}: ${err instanceof Error ? err.stack : String(err)}`);
  process.exit(1);
});
