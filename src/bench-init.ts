#!/usr/bin/env node
/**
 * bench-init.ts
 *
 * Bootstrap for the agent configuration benchmark.
 *
 * Flow:
 *   1. materialize bare mirrors of the repositories (run worktrees come from here)
 *   2. deterministic stack probe (package.json, lockfile, tree, CI)
 *   3. semantic pass via the agent CLI, ONCE per repository, cached
 *   4. write the project profile   -> .bench/projects/<repo>.json
 *   5. generate the arms PER REPO  -> .bench/arms/<repo>/<arm>.json
 *   6. observability scaffolding   -> .bench/obs/
 *   7. emit the randomized plan    -> .bench/plan.json
 *
 * The runner consumes plan.json. This script executes no task.
 *
 * Usage:
 *   node src/bench-init.ts --probe-agent          # calibrate the adapter first
 *   node src/bench-init.ts --config bench.config.json
 *
 * No external dependencies. Node >= 22.6.
 */

import path from "node:path";

import { DEFAULT_AGENT, parseJsonLoose, resolveAgentConfig, runAgent } from "./lib/agent.ts";
import { readArgs } from "./lib/args.ts";
import { buildArms } from "./lib/arms.ts";
import { existsSync, readJson, writeJson } from "./lib/fsx.ts";
import { addWorktree, bareRepo, ensureMirror, removeWorktree, resolveDefaultBranch, workRepo } from "./lib/git.ts";
import { bold, clip, dim, fail, info, ok, step, warn } from "./lib/log.ts";
import { scaffoldObservability } from "./lib/obs.ts";
import { probeStack } from "./lib/probe.ts";
import { detectProvider, getProvider } from "./lib/providers/index.ts";
import { mulberry32, shuffle } from "./lib/stats.ts";
import type {
  AgentConfig,
  Arm,
  BenchConfig,
  Manifest,
  PlanEntry,
  ProjectProfile,
  RepoSpec,
  SemanticProfile,
  StackProbe,
} from "./lib/types.ts";
import type { GitRepo } from "./lib/git.ts";

const CONFIG_EXAMPLE: BenchConfig = {
  provider: "local-git",
  org: "your-org",
  project: "your-project",
  repos: [{ name: "example-service", dir: "./repos/example-service" }],
  model: "RECORD THE PINNED MODEL",
  reps: 3,
  seed: 42,
  agent: DEFAULT_AGENT,
};

// ══════════════════════════════════════════════════════ mirrors

async function resolveRepo(
  root: string,
  repo: RepoSpec,
  cfg: BenchConfig,
  refresh: boolean,
): Promise<{ git: GitRepo; mirrorPath: string }> {
  if (repo.dir && existsSync(repo.dir)) {
    const abs = path.resolve(repo.dir);
    const isBare = existsSync(path.join(abs, "HEAD")) && !existsSync(path.join(abs, ".git"));
    info(`${repo.name}: usando clone local ${dim(abs)}`);
    return { git: isBare ? bareRepo(abs) : workRepo(abs), mirrorPath: abs };
  }

  const providerName = detectProvider(cfg.provider, repo, cfg.org, cfg.project);
  const provider = getProvider(providerName);
  const mirrorDir = path.join(root, "mirrors", `${repo.name}.git`);
  const url =
    repo.remoteUrl ??
    provider.remoteUrl({
      repoName: repo.name,
      git: bareRepo(mirrorDir),
      org: cfg.org,
      project: cfg.project,
    });
  if (!url) {
    throw new Error(
      `${repo.name}: no "dir" and no "remoteUrl", and provider ${providerName} cannot derive the URL.`,
    );
  }

  process.stdout.write(
    `  ${repo.name}: ${existsSync(mirrorDir) ? "atualizando" : "clonando"} mirror... `,
  );
  const git = await ensureMirror(mirrorDir, url, refresh);
  console.log("ok");
  return { git, mirrorPath: mirrorDir };
}

/** Throwaway checkout used only for the probe. */
async function probeCheckout(root: string, repo: RepoSpec, git: GitRepo): Promise<string | null> {
  if (!git.bare) return git.dir; // a clone with a working tree already does
  const wt = path.join(root, "probe", repo.name);
  const branch = await resolveDefaultBranch(git, repo.defaultBranch);
  try {
    await addWorktree(git, wt, branch);
    return wt;
  } catch (err) {
    warn(`${repo.name}: could not create a probe worktree (${String(err).slice(0, 120)})`);
    return null;
  }
}

// ══════════════════════════════════════════════════════ semantic pass

function semanticPrompt(probe: StackProbe): string {
  return `You are profiling a repository to configure a benchmark. Read whatever files you need.

Facts already collected (no need to reconfirm):
- Ecosystem: ${probe.ecosystem}
- Frameworks: ${probe.framework.join(", ") || "not detected"}
- Test runner: ${probe.testRunner ?? "none"}
- Monorepo: ${probe.isMonorepo ? (probe.workspaceTool ?? "yes") : "no"}
- Persistence: ${[...probe.deps.db, ...probe.deps.orm].join(", ") || "none"}
- Messaging: ${probe.deps.messaging.join(", ") || "none"}

Directory structure:
${probe.srcTree.slice(0, 120).join("\n")}

Answer with a JSON object ONLY, no code fences and no surrounding text:

{
  "architectureStyle": "short description, e.g. Clean Architecture with CQRS per module",
  "layers": [
    { "name": "domain", "globs": ["src/*/domain/**"], "mayImport": [] },
    { "name": "application", "globs": ["src/*/application/**"], "mayImport": ["domain"] }
  ],
  "domainSummary": "2 to 3 sentences on what this service does for the business",
  "criticalInvariants": ["rules whose breach causes an incident"],
  "testFileConvention": "e.g. *.spec.ts next to the file",
  "suggestedNonGoals": ["things an agent tends to do here without being asked"],
  "confidence": "high | medium | low",
  "notes": "whatever stayed ambiguous"
}

Base it on what is in the code. With no evidence for a field, use low confidence and say so in notes.`;
}

function fallbackSemantic(probe: StackProbe): SemanticProfile {
  return {
    architectureStyle: probe.framework.join(" + ") || "undetermined",
    layers: [],
    domainSummary: "",
    criticalInvariants: [],
    testFileConvention: probe.testRunner === "vitest" ? "*.test.ts" : "*.spec.ts",
    suggestedNonGoals: [],
    confidence: "low",
    notes:
      "Agent CLI unavailable or output not parseable. Fill this in by hand before " +
      "running the benchmark: bad steering contaminates A2 onwards equally.",
  };
}

function isSemanticProfile(v: unknown): v is SemanticProfile {
  return typeof v === "object" && v !== null && "architectureStyle" in v;
}

// ══════════════════════════════════════════════════════ plan

async function buildPlan(
  manifestPath: string,
  cfg: BenchConfig,
  armsByRepo: Map<string, Arm[]>,
  profiles: ProjectProfile[],
): Promise<PlanEntry[]> {
  const manifest = await readJson<Manifest>(manifestPath);
  if (!manifest?.tasks?.length) {
    warn(
      `${manifestPath} not found or empty. Run select-prs.ts first.\n` +
        `   The plan comes out empty; the rest of the bootstrap stays valid.`,
    );
    return [];
  }

  const byRepo = new Map(profiles.map((p) => [p.repo, p]));
  const reps = cfg.reps ?? 3;
  const cells: PlanEntry[] = [];
  const orphans = new Set<string>();

  for (const task of manifest.tasks) {
    const profile = byRepo.get(task.repo);
    const arms = armsByRepo.get(task.repo);
    if (!profile || !arms) {
      orphans.add(task.repo);
      continue;
    }
    for (const arm of arms) {
      for (let r = 1; r <= reps; r++) {
        cells.push({
          order: 0,
          runId: `${arm.id}.${task.id}.${r}`.replace(/#/g, "-"),
          arm: arm.id,
          taskId: task.id,
          repo: task.repo,
          rep: r,
          baseCommit: task.baseCommit,
          mirrorPath: profile.mirrorPath,
        });
      }
    }
  }

  if (orphans.size) {
    warn(
      `Tasks from unprofiled repositories were ignored: ${[...orphans].join(", ")}. ` +
        `Include those repositories in the bench-init config.`,
    );
  }

  // randomized order: without it, service drift over the day turns into an
  // "arm effect" in the final result
  const rand = mulberry32(cfg.seed ?? 42);
  return shuffle(cells, rand).map((c, i) => ({ ...c, order: i + 1 }));
}

// ══════════════════════════════════════════════════════ CLI probe

async function probeAgent(adapter: AgentConfig): Promise<void> {
  console.log(bold(`\nTestando adapter: ${adapter.cmd} ${adapter.args.join(" ")}`));
  info(`modo de prompt: ${adapter.promptMode}`);

  const res = await runAgent(adapter, {
    prompt: 'Answer with the JSON {"ok":true} and nothing else.',
    cwd: process.cwd(),
  });

  if (res.spawnError) {
    fail(`could not execute "${adapter.cmd}": ${res.spawnError}`);
  }
  info(`exit code: ${res.exitCode}${res.timedOut ? " (timeout)" : ""}`);
  console.log(dim("\n--- out bruta (2000 chars) ---"));
  console.log(clip(res.raw, 2000));
  console.log(dim("\n--- texto extraido (1000 chars) ---"));
  console.log(clip(res.text, 1000));
  console.log(dim("\n--- parsed JSON ---"));
  console.log(JSON.stringify(parseJsonLoose(res.text)));
  console.log(dim("\n--- usage accounting found in the stream ---"));
  console.log(JSON.stringify(res.usage, null, 2));

  console.log("");
  if (res.usage.source === "stream") {
    ok(
      "The stream exposes usage. The runner captures cost automatically and you " +
        "can parallelize the runs.",
    );
  } else {
    warn(
      "No usage field in the stream. Run the arms SERIALLY and record the dashboard " +
        "balance in .bench/obs/credits.json before and after each block.",
    );
  }
  console.log(
    dim(
      `\nIf the extracted text came back empty or dirty, adjust "agent" in bench.config.json:\n` +
        `  - the correct flags for your CLI build\n` +
        `  - promptMode "arg" + promptFlag if it does not accept stdin\n` +
        `  - modeArgs.vibe / modeArgs.spec for the mode flags\n` +
        `  - modelFlag to pin the model`,
    ),
  );
}

// ══════════════════════════════════════════════════════ main

const USAGE = `
bench-init — mirrors, project profile, arms, observability and plan

  node src/bench-init.ts [options]

  --probe-agent             invokes the agent CLI once and shows the raw
                            output, the extracted text and whether the stream
                            carries usage. Run this BEFORE anything else.
  --config <file>           benchmark config               (bench.config.json)
  --manifest <file>         select-prs manifest            (manifest.json)
  --root <dir>              working root                   (.bench)
  --repos a,b               only these repositories from the config
  --no-agent                skip the semantic pass (profile falls back)
  --refresh-semantic        redo the semantic pass even with a valid cache
  --no-fetch                do not update mirrors that already exist
`;

async function main(): Promise<void> {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    console.log(USAGE.trim());
    return;
  }
  const a = readArgs(process.argv.slice(2));
  const configPath = a.str("--config", "bench.config.json") as string;
  const manifestPath = a.str("--manifest", "manifest.json") as string;
  const cfg = await readJson<BenchConfig>(configPath);

  if (a.bool("--probe-agent") || a.bool("--probe-kiro")) {
    await probeAgent(resolveAgentConfig(cfg ?? {}));
    return;
  }

  if (!cfg) {
    throw new Error(
      `Config not found: ${configPath}\n\nExample:\n${JSON.stringify(CONFIG_EXAMPLE, null, 2)}`,
    );
  }

  const root = path.resolve(cfg.root ?? a.str("--root", ".bench") ?? ".bench");
  const adapter = resolveAgentConfig(cfg);
  const forceSemantic = a.bool("--refresh-semantic");
  const skipSemantic = a.bool("--no-agent") || a.bool("--no-kiro");
  const refreshMirrors = !a.bool("--no-fetch");
  const stripExisting = cfg.baselineStripsExistingConfig !== false;

  const repoFilter = a.list("--repos");
  const repos = repoFilter.length ? cfg.repos.filter((r) => repoFilter.includes(r.name)) : cfg.repos;
  if (repos.length === 0) throw new Error("No repository selected.");

  step(1, 5, "Mirrors");
  const gitByRepo = new Map<string, { git: GitRepo; mirrorPath: string }>();
  for (const repo of repos) {
    gitByRepo.set(repo.name, await resolveRepo(root, repo, cfg, refreshMirrors));
  }

  step(2, 5, "Probe (deterministic first, LLM only for what is left)");
  const profiles: ProjectProfile[] = [];

  for (const repo of repos) {
    const { git, mirrorPath } = gitByRepo.get(repo.name)!;
    const wt = await probeCheckout(root, repo, git);
    if (!wt) continue;

    const probe = await probeStack(repo.name, wt);
    info(
      `${repo.name}: ${probe.framework.join("+") || probe.ecosystem} | ${probe.packageManager} | ` +
        `${probe.testRunner ?? "no runner"}` +
        (probe.existingKiro.steering.length || probe.existingKiro.mcp
          ? ` | already has agent config in version control`
          : ""),
    );
    if (probe.existingKiro.steering.length || probe.existingKiro.mcp || probe.existingKiro.agentsMd) {
      warn(
        `${repo.name} keeps agent configuration in version control. ` +
          (stripExisting
            ? "The arms will wipe it in the worktree so that A0 is a clean baseline."
            : 'baselineStripsExistingConfig=false: A0 is NOT a clean baseline, but "current config".'),
      );
    }

    const profilePath = path.join(root, "projects", `${repo.name}.json`);
    const cached = await readJson<ProjectProfile>(profilePath);
    const cacheValid =
      cached?.semantic &&
      cached.semanticSource !== "fallback" &&
      cached.probe.lockfileHash === probe.lockfileHash &&
      probe.lockfileHash !== null &&
      !forceSemantic;

    let semantic: SemanticProfile | null = null;
    let source: ProjectProfile["semanticSource"] = "fallback";

    if (cacheValid) {
      semantic = cached!.semantic;
      source = "cached";
      info(`  semantic profile reused from cache (lockfile unchanged)`);
    } else if (!skipSemantic) {
      process.stdout.write(`    profiling with ${adapter.cmd}... `);
      const res = await runAgent(adapter, { prompt: semanticPrompt(probe), cwd: wt });
      const parsed = res.ok ? parseJsonLoose<unknown>(res.text) : null;
      if (isSemanticProfile(parsed)) {
        semantic = parsed;
        source = "agent";
        console.log(`ok (confidence: ${parsed.confidence})`);
      } else {
        console.log(
          `failed (exit ${res.exitCode}${res.spawnError ? `, ${res.spawnError}` : ""}) — fallback`,
        );
      }
    }

    profiles.push({
      repo: repo.name,
      generatedAt: new Date().toISOString(),
      mirrorPath,
      probe,
      semantic: semantic ?? fallbackSemantic(probe),
      semanticSource: source,
    });

    if (git.bare && wt !== git.dir) await removeWorktree(git, wt);
  }

  for (const p of profiles) {
    await writeJson(path.join(root, "projects", `${p.repo}.json`), p);
  }

  step(3, 5, "Arms (one set per repository — steering follows each architecture)");
  const armsByRepo = new Map<string, Arm[]>();
  for (const p of profiles) {
    const arms = buildArms(p, stripExisting);
    armsByRepo.set(p.repo, arms);
    for (const arm of arms) {
      await writeJson(path.join(root, "arms", p.repo, `${arm.id}.json`), arm);
    }
    info(`${p.repo}: ${arms.map((x) => x.id).join(" ")}  ${dim(arms[0].overlay.remove.length ? `(strip: ${arms[0].overlay.remove.join(", ")})` : "")}`);
  }

  step(4, 5, "Observability");
  await scaffoldObservability(root, cfg);
  info("obs/runs.jsonl, obs/schema.json, obs/credits.json, obs/PRE-REGISTRATION.md");

  step(5, 5, "Execution plan");
  const plan = await buildPlan(manifestPath, cfg, armsByRepo, profiles);
  await writeJson(path.join(root, "plan.json"), {
    generatedAt: new Date().toISOString(),
    model: cfg.model ?? null,
    reps: cfg.reps ?? 3,
    seed: cfg.seed ?? 42,
    arms: [...new Set([...armsByRepo.values()].flat().map((x) => x.id))],
    totalRuns: plan.length,
    entries: plan,
  });
  info(`${plan.length} runs in randomized order (seed ${cfg.seed ?? 42})`);

  const lowConf = profiles.filter((p) => p.semantic.confidence === "low");
  if (lowConf.length) {
    warn(
      `Low confidence in: ${lowConf.map((p) => p.repo).join(", ")}\n` +
        `   Review .bench/projects/*.json before spending quota — bad steering contaminates ` +
        `A2 onwards equally, and the benchmark then measures your wrong description, not the config.`,
    );
  }
  if (!cfg.model) {
    warn("cfg.model is not set. Pin a model before running, or the result does not hold.");
  }

  console.log("");
  ok(`bootstrap ready at ${root}`);
  info(`next: fill in ${path.join(root, "obs/PRE-REGISTRATION.md")}, then run`);
  info(dim(`  node src/bench-run.ts --config ${configPath}`));
}

main().catch((err) => {
  console.log("");
  fail(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
