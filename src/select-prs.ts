#!/usr/bin/env node
/**
 * select-prs.ts
 *
 * Builds the golden dataset: already-merged PRs, stratified by change size.
 * The smallest PR in the corpus becomes 0%, the largest becomes 100%, and the
 * script picks the PRs closest to the requested target percentages.
 *
 * Works with any repository:
 *   local-git     needs no API and no token. Reads merges from the history itself.
 *   github        GITHUB_TOKEN optional for a public repository.
 *   azure-devops  AZDO_PAT required.
 *
 * Output: manifest.json with the base commit for the worktree, the task
 * description and the list of held-out test files that act as the grader.
 *
 * Usage:
 *   node src/select-prs.ts --config bench.config.json --targets 0,25,50,75,100
 *   node src/select-prs.ts --provider local-git --repo-dir ./my-repo --name api
 *
 * No external dependencies. Node >= 22.6.
 */

import path from "node:path";

import { readArgs } from "./lib/args.ts";
import { existsSync, readJson, writeJson } from "./lib/fsx.ts";
import { DEFAULT_EXCLUDES, globToRegExp } from "./lib/glob.ts";
import {
  bareRepo,
  ensureCommit,
  ensureMirror,
  mergeBase,
  numstat,
  workRepo,
  type GitRepo,
} from "./lib/git.ts";
import { fail, info, ok, rule, table, warn, dim, bold } from "./lib/log.ts";
import { detectProvider, getProvider } from "./lib/providers/index.ts";
import { fmt, percentile } from "./lib/stats.ts";
import type {
  BenchConfig,
  Manifest,
  MeasuredPr,
  ProviderName,
  PullRequestRef,
  RepoSpec,
  ScoredPr,
  SelectedPr,
} from "./lib/types.ts";

type MetricName = "churn" | "prod-churn" | "additions" | "files";
type ScaleName = "linear" | "log";

interface Options {
  config: string;
  root: string;
  provider?: ProviderName;
  org?: string;
  project?: string;
  repoFilter: string[];
  repoDir?: string;
  repoName?: string;
  targets: number[];
  metric: MetricName;
  scale: ScaleName;
  clampLow: number;
  clampHigh: number;
  perBucket: number;
  since?: string;
  targetBranch?: string;
  minFiles: number;
  maxFiles: number;
  requireTests: boolean;
  exclude: string[];
  maxPrsPerRepo: number;
  cache: string;
  refresh: boolean;
  noFetch: boolean;
  extraTasks?: string;
  out: string;
}

function parseOptions(argv: string[]): Options {
  const a = readArgs(argv);
  const clamp = a.str("--clamp", "0:100") ?? "0:100";
  const [lowRaw, highRaw] = clamp.split(":").map(Number);

  return {
    config: a.str("--config", "bench.config.json") as string,
    root: path.resolve(a.str("--root", ".bench") as string),
    provider: a.str("--provider") as ProviderName | undefined,
    org: a.str("--org"),
    project: a.str("--project"),
    repoFilter: a.list("--repos"),
    repoDir: a.str("--repo-dir"),
    repoName: a.str("--name"),
    targets: a.nums("--targets", "0,25,50,75,100"),
    metric: (a.str("--metric", "churn") ?? "churn") as MetricName,
    scale: (a.str("--scale", "linear") ?? "linear") as ScaleName,
    clampLow: Number.isFinite(lowRaw) ? lowRaw : 0,
    clampHigh: Number.isFinite(highRaw) ? highRaw : 100,
    perBucket: a.num("--per-bucket", 1),
    since: a.str("--since"),
    targetBranch: a.str("--target-branch"),
    minFiles: a.num("--min-files", 1),
    maxFiles: a.num("--max-files", 200),
    requireTests: a.bool("--require-tests"),
    exclude: [...DEFAULT_EXCLUDES, ...a.list("--exclude")],
    maxPrsPerRepo: a.num("--max-prs-per-repo", 200),
    cache: a.str("--cache", ".pr-cache.json") as string,
    refresh: a.bool("--refresh"),
    noFetch: a.bool("--no-fetch"),
    extraTasks: a.str("--extra-tasks"),
    out: a.str("--out", "manifest.json") as string,
  };
}

// ─────────────────────────────────────────────────────── config

const CONFIG_EXAMPLE = {
  provider: "local-git",
  org: "my-org",
  project: "my-project",
  repos: [
    { name: "example-service", dir: "./repos/example-service" },
    { name: "other-service", remoteUrl: "https://github.com/my-org/other-service.git" },
  ],
};

async function loadConfig(opts: Options): Promise<BenchConfig> {
  if (opts.repoDir) {
    const name = opts.repoName ?? path.basename(path.resolve(opts.repoDir));
    return {
      provider: opts.provider ?? "local-git",
      org: opts.org,
      project: opts.project,
      repos: [{ name, dir: opts.repoDir }],
    };
  }

  const cfg = await readJson<BenchConfig>(opts.config);
  if (!cfg) {
    throw new Error(
      `Config not found: ${opts.config}\n\n` +
        `Create a JSON like this:\n${JSON.stringify(CONFIG_EXAMPLE, null, 2)}\n\n` +
        `Or point at a clone directly:\n` +
        `  node src/select-prs.ts --repo-dir ./my-repo --name my-repo`,
    );
  }
  if (opts.provider) cfg.provider = opts.provider;
  if (opts.org) cfg.org = opts.org;
  if (opts.project) cfg.project = opts.project;
  if (opts.repoFilter.length) {
    cfg.repos = cfg.repos.filter((r) => opts.repoFilter.includes(r.name));
    if (cfg.repos.length === 0) {
      throw new Error(`No repository in the config matches --repos ${opts.repoFilter.join(",")}`);
    }
  }
  return cfg;
}

/**
 * An existing local clone is used as is. Otherwise it materializes a bare
 * mirror in <root>/mirrors, the same one the runner uses later.
 */
export async function resolveRepoGit(
  root: string,
  repo: RepoSpec,
  provider: ReturnType<typeof getProvider>,
  cfg: BenchConfig,
  noFetch: boolean,
): Promise<GitRepo> {
  if (repo.dir && existsSync(repo.dir)) {
    const isBare = existsSync(path.join(repo.dir, "HEAD")) && !existsSync(path.join(repo.dir, ".git"));
    return isBare ? bareRepo(path.resolve(repo.dir)) : workRepo(path.resolve(repo.dir));
  }

  const mirrorDir = path.join(root, "mirrors", `${repo.name}.git`);
  if (existsSync(mirrorDir)) return bareRepo(mirrorDir);

  const url =
    repo.remoteUrl ??
    provider.remoteUrl({ repoName: repo.name, git: bareRepo(mirrorDir), org: cfg.org, project: cfg.project });
  if (!url) {
    throw new Error(
      `No clone for ${repo.name}: set "dir" (local clone) or "remoteUrl" in the config.`,
    );
  }
  if (noFetch) throw new Error(`--no-fetch, but ${repo.name} has no clone at ${mirrorDir}`);
  info(`${repo.name}: cloning mirror from ${url}`);
  return await ensureMirror(mirrorDir, url, false);
}

// ─────────────────────────────────────────────────────── measurement

async function measurePr(
  repoName: string,
  git: GitRepo,
  pr: PullRequestRef,
  excludePatterns: RegExp[],
): Promise<MeasuredPr | null> {
  if (!(await ensureCommit(git, pr.headCommit, pr.fetchRefs))) return null;
  if (!(await ensureCommit(git, pr.targetCommit, pr.fetchRefs))) return null;

  // merge-base is the real diff base; falls back to the target commit if absent
  const base = (await mergeBase(git, pr.targetCommit, pr.headCommit)) ?? pr.targetCommit;

  let stats;
  try {
    stats = await numstat(git, base, pr.headCommit, excludePatterns);
  } catch {
    return null;
  }

  const kept = stats.filter((s) => !s.excluded);
  const prod = kept.filter((s) => !s.isTest);
  const tests = kept.filter((s) => s.isTest);
  const churn = (arr: typeof kept): number =>
    arr.reduce((acc, s) => acc + s.additions + s.deletions, 0);

  return {
    id: `${repoName}#${pr.id}`,
    kind: "golden-pr",
    repo: repoName,
    prId: pr.id,
    title: pr.title,
    description: pr.description,
    url: pr.url,
    targetBranch: pr.targetBranch,
    baseCommit: base,
    headCommit: pr.headCommit,
    mergeCommit: pr.mergeCommit,
    closedDate: pr.closedDate,
    metrics: {
      files: kept.length,
      additions: kept.reduce((a, s) => a + s.additions, 0),
      deletions: kept.reduce((a, s) => a + s.deletions, 0),
      churn: churn(kept),
      prodChurn: churn(prod),
      testChurn: churn(tests),
      hasTests: tests.length > 0,
    },
    prodFiles: prod.map((s) => s.path),
    testFiles: tests.map((s) => s.path),
  };
}

async function collect(cfg: BenchConfig, opts: Options): Promise<MeasuredPr[]> {
  if (!opts.refresh && existsSync(opts.cache)) {
    const cached = await readJson<MeasuredPr[]>(opts.cache);
    if (cached?.length) {
      info(`cache: ${cached.length} PRs from ${opts.cache} ${dim("(--refresh to redo it)")}`);
      return cached;
    }
  }

  const excludePatterns = opts.exclude.map(globToRegExp);
  const measured: MeasuredPr[] = [];

  for (const repo of cfg.repos) {
    const providerName = detectProvider(cfg.provider, repo, cfg.org, cfg.project);
    const provider = getProvider(providerName);
    const git = await resolveRepoGit(opts.root, repo, provider, cfg, opts.noFetch);

    const missing = provider.missingRequirements({
      repoName: repo.name,
      git,
      org: cfg.org,
      project: cfg.project,
      remoteUrl: repo.remoteUrl,
    });
    if (missing.length) {
      warn(`${repo.name}: provider ${providerName} is not ready — missing ${missing.join("; ")}`);
      continue;
    }

    const targetBranch = opts.targetBranch ?? repo.defaultBranch ?? "main";
    process.stdout.write(`  ${repo.name} ${dim(`[${providerName}]`)}: buscando PRs... `);

    let prs: PullRequestRef[];
    try {
      prs = await provider.listMergedPrs(
        { repoName: repo.name, git, org: cfg.org, project: cfg.project, remoteUrl: repo.remoteUrl },
        { targetBranch, max: opts.maxPrsPerRepo, since: opts.since },
      );
    } catch (err) {
      console.log("");
      warn(`${repo.name}: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }

    process.stdout.write(`${prs.length} encontradas, medindo diffs`);
    let done = 0;
    for (const pr of prs) {
      if (pr.isDraft) continue;
      if (opts.since && pr.closedDate && pr.closedDate < opts.since) continue;
      const m = await measurePr(repo.name, git, pr, excludePatterns);
      if (m) {
        measured.push(m);
        done++;
        if (done % 25 === 0) process.stdout.write(".");
      }
    }
    console.log(` -> ${done} medidas`);
  }

  await writeJson(opts.cache, measured);
  info(`cache saved at ${opts.cache}`);
  return measured;
}

// ─────────────────────────────────────────────────────── scoring

function rawMetricOf(pr: MeasuredPr, metric: MetricName): number {
  switch (metric) {
    case "additions":
      return pr.metrics.additions;
    case "files":
      return pr.metrics.files;
    case "prod-churn":
      return pr.metrics.prodChurn;
    default:
      return pr.metrics.churn;
  }
}

function score(prs: MeasuredPr[], opts: Options): ScoredPr[] {
  const raws = prs.map((p) => rawMetricOf(p, opts.metric));
  const scaled = raws.map((v) => (opts.scale === "log" ? Math.log10(v + 1) : v));

  const sorted = [...scaled].sort((a, b) => a - b);
  const lo = percentile(sorted, opts.clampLow);
  const hi = percentile(sorted, opts.clampHigh);
  const span = hi - lo;

  if (span <= 0) {
    warn("All PRs have the same size under this metric. sizePercent = 0 for all of them.");
  }

  return prs.map((pr, i) => {
    const clamped = Math.min(hi, Math.max(lo, scaled[i]));
    const norm = span > 0 ? (clamped - lo) / span : 0;
    return {
      ...pr,
      rawMetric: raws[i],
      scaledMetric: scaled[i],
      sizePercent: Number((norm * 100).toFixed(2)),
    };
  });
}

/** Warns when a raw min/max is being dominated by an outlier. */
function warnOnSkew(scored: ScoredPr[], opts: Options): void {
  if (opts.clampLow !== 0 || opts.clampHigh !== 100 || opts.scale === "log") return;
  const sorted = scored.map((p) => p.rawMetric).sort((a, b) => a - b);
  const p95 = percentile(sorted, 95);
  const max = sorted[sorted.length - 1];
  const median = percentile(sorted, 50);
  if (p95 > 0 && max / p95 > 4) {
    warn(
      `Skewed distribution: largest PR = ${fmt(max)}, p95 = ${fmt(Math.round(p95))}, ` +
        `median = ${fmt(Math.round(median))}.\n` +
        `   The outlier is defining 100% and squeezing the rest near 0%.\n` +
        `   Consider:  --clamp 5:95   or   --scale log`,
    );
  }
}

// ─────────────────────────────────────────────────────── selection

function select(scored: ScoredPr[], opts: Options): SelectedPr[] {
  const pool = [...scored];
  const chosen: SelectedPr[] = [];

  for (const target of opts.targets) {
    for (let k = 0; k < opts.perBucket; k++) {
      if (pool.length === 0) break;
      let bestIdx = 0;
      let bestDist = Infinity;
      for (let i = 0; i < pool.length; i++) {
        const d = Math.abs(pool[i].sizePercent - target);
        if (d < bestDist) {
          bestDist = d;
          bestIdx = i;
        }
      }
      const [pick] = pool.splice(bestIdx, 1);
      chosen.push({ ...pick, bucket: target, distanceToBucket: Number(bestDist.toFixed(2)) });
    }
  }

  return chosen.sort((a, b) => a.bucket - b.bucket || a.sizePercent - b.sizePercent);
}

// ─────────────────────────────────────────────────────── report

function report(scored: ScoredPr[], selected: SelectedPr[], opts: Options): void {
  const sorted = scored.map((p) => p.rawMetric).sort((a, b) => a - b);

  rule("corpus");
  info(`eligible PRs:   ${scored.length}`);
  info(`Metric:         ${opts.metric} (${opts.scale} scale)`);
  info(`Clamp:          p${opts.clampLow} .. p${opts.clampHigh}`);
  info(
    `Distribution:   min ${fmt(sorted[0] ?? 0)} | ` +
      `p25 ${fmt(Math.round(percentile(sorted, 25)))} | ` +
      `p50 ${fmt(Math.round(percentile(sorted, 50)))} | ` +
      `p75 ${fmt(Math.round(percentile(sorted, 75)))} | ` +
      `max ${fmt(sorted[sorted.length - 1] ?? 0)}`,
  );

  rule("selected");
  table(
    [
      { header: "target", width: 7, align: "right" },
      { header: "actual", width: 7, align: "right" },
      { header: opts.metric, width: 10, align: "right" },
      { header: "files", width: 5, align: "right" },
      { header: "tst", width: 3 },
      { header: "task", width: 60 },
    ],
    selected.map((pr) => [
      `${pr.bucket}%`,
      `${pr.sizePercent}%`,
      fmt(pr.rawMetric),
      String(pr.metrics.files),
      pr.metrics.hasTests ? "yes" : "-",
      `${pr.id} ${pr.title.slice(0, 44)}`,
    ]),
  );
}

// ─────────────────────────────────────────────────────── extra tasks

/**
 * Hand-written tasks, appended to the manifest. This is where the scope bait
 * goes: a deliberately vague requirement, to measure invented features.
 */
async function loadExtraTasks(file: string | undefined): Promise<SelectedPr[]> {
  if (!file) return [];
  const raw = await readJson<{ tasks: Array<Partial<SelectedPr>> }>(file);
  if (!raw?.tasks?.length) {
    warn(`--extra-tasks ${file}: no item in "tasks"`);
    return [];
  }
  return raw.tasks.map((t, i) => {
    const missing = ["id", "repo", "title", "baseCommit"].filter(
      (k) => !(t as Record<string, unknown>)[k],
    );
    if (missing.length) {
      throw new Error(`--extra-tasks item ${i}: faltam campos ${missing.join(", ")}`);
    }
    return {
      kind: "scope-bait",
      prId: 0,
      description: "",
      url: null,
      targetBranch: "main",
      headCommit: t.baseCommit as string,
      mergeCommit: null,
      closedDate: null,
      metrics: {
        files: 0,
        additions: 0,
        deletions: 0,
        churn: 0,
        prodChurn: 0,
        testChurn: 0,
        hasTests: false,
      },
      prodFiles: [],
      testFiles: [],
      rawMetric: 0,
      scaledMetric: 0,
      sizePercent: 0,
      bucket: -1,
      distanceToBucket: 0,
      ...t,
    } as SelectedPr;
  });
}

// ─────────────────────────────────────────────────────── main

const USAGE = `
select-prs — builds the golden dataset from already-merged PRs

  node src/select-prs.ts [options]

source
  --config <file>           benchmark config               (bench.config.json)
  --repo-dir <path>         shortcut: one local clone, no config
  --name <name>             repository name when using --repo-dir
  --provider <name>         local-git | github | azure-devops
  --org / --project         override the config
  --repos a,b               only these repositories from the config
  --target-branch <ref>     target branch of the PRs       (repo default)
  --since <ISO>             only PRs closed after this
  --max-prs-per-repo <n>    cap on PRs fetched             (200)
  --no-fetch                forbid cloning; require a local clone

size and selection
  --targets 0,25,50,75,100  target size percentages
  --per-bucket <n>          PRs per target                 (1)
  --metric <m>              churn | prod-churn | additions | files
  --scale linear|log        log for heavy-tailed churn
  --clamp lo:hi             percentiles defining 0% and 100%  (0:100)
  --min-files / --max-files filter by file count            (1 / 200)
  --require-tests           only PRs with tests (held-out grader)
  --exclude a,b             extra globs kept out of the metric

output
  --extra-tasks <file>      append manual tasks (scope bait)
  --cache <file>            measurement cache              (.pr-cache.json)
  --refresh                 redo the measurement, ignoring the cache
  --out <file>              output manifest                (manifest.json)

variables: AZDO_PAT, GITHUB_TOKEN, PR_MODE=merges|commits
`;

async function main(): Promise<void> {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    console.log(USAGE.trim());
    return;
  }
  const opts = parseOptions(process.argv.slice(2));
  const cfg = await loadConfig(opts);

  console.log(bold("\nselect-prs — building the golden dataset"));
  const measured = await collect(cfg, opts);

  const eligible = measured.filter((p) => {
    if (p.metrics.files < opts.minFiles) return false;
    if (p.metrics.files > opts.maxFiles) return false;
    if (p.metrics.churn === 0) return false;
    if (opts.requireTests && !p.metrics.hasTests) return false;
    return true;
  });

  if (eligible.length === 0) {
    throw new Error(
      `No PR passed the filters (${measured.length} measured).\n` +
        `   Loosen --min-files / --max-files / --require-tests, or raise --max-prs-per-repo.`,
    );
  }

  const scored = score(eligible, opts);
  warnOnSkew(scored, opts);

  const selected = select(scored, opts);
  report(scored, selected, opts);

  const extra = await loadExtraTasks(opts.extraTasks);
  if (extra.length) info(`+ ${extra.length} manual task(s) from ${opts.extraTasks}`);

  const providerName = detectProvider(cfg.provider, cfg.repos[0] ?? { name: "" }, cfg.org, cfg.project);
  const manifest: Manifest = {
    generatedAt: new Date().toISOString(),
    provider: providerName,
    criteria: {
      metric: opts.metric,
      scale: opts.scale,
      clamp: [opts.clampLow, opts.clampHigh],
      targets: opts.targets,
      perBucket: opts.perBucket,
      requireTests: opts.requireTests,
      minFiles: opts.minFiles,
      maxFiles: opts.maxFiles,
      since: opts.since ?? null,
      excludes: opts.exclude,
    },
    corpusSize: scored.length,
    tasks: [...selected, ...extra],
  };
  await writeJson(opts.out, manifest);

  console.log("");
  ok(`${manifest.tasks.length} tasks written to ${opts.out}`);

  const untested = selected.filter((p) => !p.metrics.hasTests);
  if (untested.length) {
    warn(
      `${untested.length} task(s) with no test file cannot serve as a held-out grader ` +
        `(${untested.map((p) => p.id).join(", ")}). Run with --require-tests.`,
    );
  }
}

main().catch((err) => {
  console.log("");
  fail(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
