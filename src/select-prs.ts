#!/usr/bin/env node
/**
 * select-prs.ts
 *
 * Monta o golden dataset: PRs ja mergeadas, estratificadas por tamanho de
 * alteracao. O menor PR do corpus vira 0%, o maior vira 100%, e o script
 * escolhe os PRs mais proximos das porcentagens-alvo pedidas.
 *
 * Funciona com qualquer repositorio:
 *   local-git     nao precisa de API nem token. Le merges do proprio historico.
 *   github        GITHUB_TOKEN opcional para repo publico.
 *   azure-devops  AZDO_PAT obrigatorio.
 *
 * Saida: manifest.json com base commit para o worktree, descricao da task e a
 * lista de arquivos de teste held-out que serao o grader.
 *
 * Uso:
 *   node src/select-prs.ts --config bench.config.json --targets 0,25,50,75,100
 *   node src/select-prs.ts --provider local-git --repo-dir ./meu-repo --name api
 *
 * Sem dependencias externas. Node >= 22.6.
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
  org: "minha-org",
  project: "meu-projeto",
  repos: [
    { name: "servico-exemplo", dir: "./repos/servico-exemplo" },
    { name: "outro-servico", remoteUrl: "https://github.com/minha-org/outro-servico.git" },
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
      `Config nao encontrado: ${opts.config}\n\n` +
        `Crie um JSON assim:\n${JSON.stringify(CONFIG_EXAMPLE, null, 2)}\n\n` +
        `Ou aponte um clone direto:\n` +
        `  node src/select-prs.ts --repo-dir ./meu-repo --name meu-repo`,
    );
  }
  if (opts.provider) cfg.provider = opts.provider;
  if (opts.org) cfg.org = opts.org;
  if (opts.project) cfg.project = opts.project;
  if (opts.repoFilter.length) {
    cfg.repos = cfg.repos.filter((r) => opts.repoFilter.includes(r.name));
    if (cfg.repos.length === 0) {
      throw new Error(`Nenhum repo da config bate com --repos ${opts.repoFilter.join(",")}`);
    }
  }
  return cfg;
}

/**
 * Um clone local existente e usado como esta. Caso contrario materializa um
 * mirror bare em <root>/mirrors, que e o mesmo que o runner usa depois.
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
      `Sem clone para ${repo.name}: informe "dir" (clone local) ou "remoteUrl" na config.`,
    );
  }
  if (noFetch) throw new Error(`--no-fetch, mas ${repo.name} nao tem clone em ${mirrorDir}`);
  info(`${repo.name}: clonando mirror de ${url}`);
  return await ensureMirror(mirrorDir, url, false);
}

// ─────────────────────────────────────────────────────── medicao

async function measurePr(
  repoName: string,
  git: GitRepo,
  pr: PullRequestRef,
  excludePatterns: RegExp[],
): Promise<MeasuredPr | null> {
  if (!(await ensureCommit(git, pr.headCommit, pr.fetchRefs))) return null;
  if (!(await ensureCommit(git, pr.targetCommit, pr.fetchRefs))) return null;

  // merge-base e a base real do diff; cai para o commit alvo se nao houver
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
      info(`cache: ${cached.length} PRs de ${opts.cache} ${dim("(--refresh para refazer)")}`);
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
      warn(`${repo.name}: provider ${providerName} nao esta pronto — falta ${missing.join("; ")}`);
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
  info(`cache salvo em ${opts.cache}`);
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
    warn("Todos os PRs tem o mesmo tamanho sob esta metrica. sizePercent = 0 para todos.");
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

/** Alerta quando min/max puro esta sendo dominado por outlier. */
function warnOnSkew(scored: ScoredPr[], opts: Options): void {
  if (opts.clampLow !== 0 || opts.clampHigh !== 100 || opts.scale === "log") return;
  const sorted = scored.map((p) => p.rawMetric).sort((a, b) => a - b);
  const p95 = percentile(sorted, 95);
  const max = sorted[sorted.length - 1];
  const median = percentile(sorted, 50);
  if (p95 > 0 && max / p95 > 4) {
    warn(
      `Distribuicao enviesada: maior PR = ${fmt(max)}, p95 = ${fmt(Math.round(p95))}, ` +
        `mediana = ${fmt(Math.round(median))}.\n` +
        `   O outlier esta definindo o 100% e comprimindo o resto perto de 0%.\n` +
        `   Considere:  --clamp 5:95   ou   --scale log`,
    );
  }
}

// ─────────────────────────────────────────────────────── selecao

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

// ─────────────────────────────────────────────────────── relatorio

function report(scored: ScoredPr[], selected: SelectedPr[], opts: Options): void {
  const sorted = scored.map((p) => p.rawMetric).sort((a, b) => a - b);

  rule("corpus");
  info(`PRs elegiveis:  ${scored.length}`);
  info(`Metrica:        ${opts.metric} (escala ${opts.scale})`);
  info(`Clamp:          p${opts.clampLow} .. p${opts.clampHigh}`);
  info(
    `Distribuicao:   min ${fmt(sorted[0] ?? 0)} | ` +
      `p25 ${fmt(Math.round(percentile(sorted, 25)))} | ` +
      `p50 ${fmt(Math.round(percentile(sorted, 50)))} | ` +
      `p75 ${fmt(Math.round(percentile(sorted, 75)))} | ` +
      `max ${fmt(sorted[sorted.length - 1] ?? 0)}`,
  );

  rule("selecionados");
  table(
    [
      { header: "alvo", width: 5, align: "right" },
      { header: "real", width: 7, align: "right" },
      { header: opts.metric, width: 10, align: "right" },
      { header: "arq", width: 4, align: "right" },
      { header: "tst", width: 3 },
      { header: "tarefa", width: 60 },
    ],
    selected.map((pr) => [
      `${pr.bucket}%`,
      `${pr.sizePercent}%`,
      fmt(pr.rawMetric),
      String(pr.metrics.files),
      pr.metrics.hasTests ? "sim" : "-",
      `${pr.id} ${pr.title.slice(0, 44)}`,
    ]),
  );
}

// ─────────────────────────────────────────────────────── extra tasks

/**
 * Tarefas escritas a mao, anexadas ao manifest. E aqui que entra a isca de
 * escopo: um requisito propositalmente vago, para medir invencao de feature.
 */
async function loadExtraTasks(file: string | undefined): Promise<SelectedPr[]> {
  if (!file) return [];
  const raw = await readJson<{ tasks: Array<Partial<SelectedPr>> }>(file);
  if (!raw?.tasks?.length) {
    warn(`--extra-tasks ${file}: nenhum item em "tasks"`);
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
select-prs — monta o golden dataset a partir de PRs ja mergeadas

  node src/select-prs.ts [opcoes]

fonte
  --config <arquivo>        config do benchmark            (bench.config.json)
  --repo-dir <caminho>      atalho: um clone local, sem config
  --name <nome>             nome do repo quando usar --repo-dir
  --provider <nome>         local-git | github | azure-devops
  --org / --project         sobrescrevem a config
  --repos a,b               so estes repos da config
  --target-branch <ref>     branch alvo dos PRs            (default do repo)
  --since <ISO>             so PRs fechadas depois disso
  --max-prs-per-repo <n>    teto de PRs buscadas           (200)
  --no-fetch                proibe clonar; exige clone local

tamanho e selecao
  --targets 0,25,50,75,100  porcentagens-alvo de tamanho
  --per-bucket <n>          PRs por alvo                   (1)
  --metric <m>              churn | prod-churn | additions | files
  --scale linear|log        log para churn de cauda pesada
  --clamp lo:hi             percentis que definem 0% e 100%  (0:100)
  --min-files / --max-files filtro por numero de arquivos   (1 / 200)
  --require-tests           so PRs com teste (grader held-out)
  --exclude a,b             globs extras fora da metrica

saida
  --extra-tasks <arquivo>   anexa tarefas manuais (isca de escopo)
  --cache <arquivo>         cache das medicoes             (.pr-cache.json)
  --refresh                 refaz a medicao ignorando o cache
  --out <arquivo>           manifest de saida              (manifest.json)

variaveis: AZDO_PAT, GITHUB_TOKEN, PR_MODE=merges|commits
`;

async function main(): Promise<void> {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    console.log(USAGE.trim());
    return;
  }
  const opts = parseOptions(process.argv.slice(2));
  const cfg = await loadConfig(opts);

  console.log(bold("\nselect-prs — montando o golden dataset"));
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
      `Nenhum PR passou nos filtros (${measured.length} medidos).\n` +
        `   Afrouxe --min-files / --max-files / --require-tests, ou aumente --max-prs-per-repo.`,
    );
  }

  const scored = score(eligible, opts);
  warnOnSkew(scored, opts);

  const selected = select(scored, opts);
  report(scored, selected, opts);

  const extra = await loadExtraTasks(opts.extraTasks);
  if (extra.length) info(`+ ${extra.length} tarefa(s) manual(is) de ${opts.extraTasks}`);

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
  ok(`${manifest.tasks.length} tarefas escritas em ${opts.out}`);

  const semTeste = selected.filter((p) => !p.metrics.hasTests);
  if (semTeste.length) {
    warn(
      `${semTeste.length} tarefa(s) sem arquivo de teste nao servem como grader held-out ` +
        `(${semTeste.map((p) => p.id).join(", ")}). Rode com --require-tests.`,
    );
  }
}

main().catch((err) => {
  console.log("");
  fail(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
