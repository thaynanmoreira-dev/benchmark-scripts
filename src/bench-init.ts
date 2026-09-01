#!/usr/bin/env node
/**
 * bench-init.ts
 *
 * Bootstrap do benchmark de configuracoes do agente.
 *
 * Fluxo:
 *   1. materializa mirrors bare dos repos (os worktrees de run saem daqui)
 *   2. sonda deterministica da stack (package.json, lockfile, arvore, CI)
 *   3. passada semantica via CLI do agente, UMA vez por repo, cacheada
 *   4. escreve o perfil do projeto  -> .bench/projects/<repo>.json
 *   5. gera os arms POR REPO        -> .bench/arms/<repo>/<arm>.json
 *   6. scaffolding de observabilidade -> .bench/obs/
 *   7. emite o plano randomizado    -> .bench/plan.json
 *
 * O runner consome plan.json. Este script nao executa nenhuma tarefa.
 *
 * Uso:
 *   node src/bench-init.ts --probe-agent          # calibre o adapter primeiro
 *   node src/bench-init.ts --config bench.config.json
 *
 * Sem dependencias externas. Node >= 22.6.
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
  org: "sua-org",
  project: "seu-projeto",
  repos: [{ name: "servico-exemplo", dir: "./repos/servico-exemplo" }],
  model: "REGISTRE O MODELO TRAVADO",
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
      `${repo.name}: sem "dir" nem "remoteUrl", e o provider ${providerName} nao consegue derivar a URL.`,
    );
  }

  process.stdout.write(
    `  ${repo.name}: ${existsSync(mirrorDir) ? "atualizando" : "clonando"} mirror... `,
  );
  const git = await ensureMirror(mirrorDir, url, refresh);
  console.log("ok");
  return { git, mirrorPath: mirrorDir };
}

/** Checkout descartavel usado so para a sondagem. */
async function probeCheckout(root: string, repo: RepoSpec, git: GitRepo): Promise<string | null> {
  if (!git.bare) return git.dir; // clone com working tree ja serve
  const wt = path.join(root, "probe", repo.name);
  const branch = await resolveDefaultBranch(git, repo.defaultBranch);
  try {
    await addWorktree(git, wt, branch);
    return wt;
  } catch (err) {
    warn(`${repo.name}: nao consegui criar worktree de sondagem (${String(err).slice(0, 120)})`);
    return null;
  }
}

// ══════════════════════════════════════════════════════ passada semantica

function semanticPrompt(probe: StackProbe): string {
  return `Voce esta perfilando um repositorio para configurar um benchmark. Leia os arquivos que precisar.

Fatos ja coletados (nao precisa reconfirmar):
- Ecossistema: ${probe.ecosystem}
- Frameworks: ${probe.framework.join(", ") || "nao detectado"}
- Test runner: ${probe.testRunner ?? "nenhum"}
- Monorepo: ${probe.isMonorepo ? (probe.workspaceTool ?? "sim") : "nao"}
- Persistencia: ${[...probe.deps.db, ...probe.deps.orm].join(", ") || "nenhuma"}
- Mensageria: ${probe.deps.messaging.join(", ") || "nenhuma"}

Estrutura de diretorios:
${probe.srcTree.slice(0, 120).join("\n")}

Responda SOMENTE com um objeto JSON, sem cercas de codigo e sem texto ao redor:

{
  "architectureStyle": "descricao curta, ex: Clean Architecture com CQRS por modulo",
  "layers": [
    { "name": "domain", "globs": ["src/*/domain/**"], "mayImport": [] },
    { "name": "application", "globs": ["src/*/application/**"], "mayImport": ["domain"] }
  ],
  "domainSummary": "2 a 3 frases sobre o que este servico faz no negocio",
  "criticalInvariants": ["regras cuja quebra causa incidente"],
  "testFileConvention": "ex: *.spec.ts ao lado do arquivo",
  "suggestedNonGoals": ["coisas que um agente costuma fazer aqui sem ser pedido"],
  "confidence": "high | medium | low",
  "notes": "o que ficou ambiguo"
}

Baseie-se no que esta no codigo. Sem evidencia para um campo, use confianca baixa e diga em notes.`;
}

function fallbackSemantic(probe: StackProbe): SemanticProfile {
  return {
    architectureStyle: probe.framework.join(" + ") || "nao determinado",
    layers: [],
    domainSummary: "",
    criticalInvariants: [],
    testFileConvention: probe.testRunner === "vitest" ? "*.test.ts" : "*.spec.ts",
    suggestedNonGoals: [],
    confidence: "low",
    notes:
      "CLI do agente indisponivel ou saida nao parseavel. Preencha a mao antes de rodar o " +
      "benchmark: steering ruim contamina A2 em diante por igual.",
  };
}

function isSemanticProfile(v: unknown): v is SemanticProfile {
  return typeof v === "object" && v !== null && "architectureStyle" in v;
}

// ══════════════════════════════════════════════════════ plano

async function buildPlan(
  manifestPath: string,
  cfg: BenchConfig,
  armsByRepo: Map<string, Arm[]>,
  profiles: ProjectProfile[],
): Promise<PlanEntry[]> {
  const manifest = await readJson<Manifest>(manifestPath);
  if (!manifest?.tasks?.length) {
    warn(
      `${manifestPath} nao encontrado ou vazio. Rode select-prs.ts antes.\n` +
        `   O plano sai vazio, o resto do bootstrap continua valido.`,
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
      `Tarefas de repos sem perfil foram ignoradas: ${[...orphans].join(", ")}. ` +
        `Inclua esses repos na config do bench-init.`,
    );
  }

  // ordem randomizada: sem isso, drift do servico ao longo do dia vira
  // "efeito do arm" no resultado final
  const rand = mulberry32(cfg.seed ?? 42);
  return shuffle(cells, rand).map((c, i) => ({ ...c, order: i + 1 }));
}

// ══════════════════════════════════════════════════════ probe do CLI

async function probeAgent(adapter: AgentConfig): Promise<void> {
  console.log(bold(`\nTestando adapter: ${adapter.cmd} ${adapter.args.join(" ")}`));
  info(`modo de prompt: ${adapter.promptMode}`);

  const res = await runAgent(adapter, {
    prompt: 'Responda apenas com o JSON {"ok":true} e nada mais.',
    cwd: process.cwd(),
  });

  if (res.spawnError) {
    fail(`nao consegui executar "${adapter.cmd}": ${res.spawnError}`);
  }
  info(`exit code: ${res.exitCode}${res.timedOut ? " (timeout)" : ""}`);
  console.log(dim("\n--- saida bruta (2000 chars) ---"));
  console.log(clip(res.raw, 2000));
  console.log(dim("\n--- texto extraido (1000 chars) ---"));
  console.log(clip(res.text, 1000));
  console.log(dim("\n--- JSON parseado ---"));
  console.log(JSON.stringify(parseJsonLoose(res.text)));
  console.log(dim("\n--- contabilidade de uso encontrada no stream ---"));
  console.log(JSON.stringify(res.usage, null, 2));

  console.log("");
  if (res.usage.source === "stream") {
    ok(
      "O stream expoe uso. O runner captura custo automaticamente e voce pode " +
        "paralelizar os runs.",
    );
  } else {
    warn(
      "Nenhum campo de uso no stream. Rode os arms EM SERIE e registre o saldo do " +
        "dashboard em .bench/obs/credits.json antes e depois de cada bloco.",
    );
  }
  console.log(
    dim(
      `\nSe o texto extraido veio vazio ou sujo, ajuste "agent" no bench.config.json:\n` +
        `  - flags corretas do seu build do CLI\n` +
        `  - promptMode "arg" + promptFlag se ele nao aceitar stdin\n` +
        `  - modeArgs.vibe / modeArgs.spec para as flags de modo\n` +
        `  - modelFlag para travar o modelo`,
    ),
  );
}

// ══════════════════════════════════════════════════════ main

const USAGE = `
bench-init — mirrors, perfil do projeto, arms, observabilidade e plano

  node src/bench-init.ts [opcoes]

  --probe-agent             invoca o CLI do agente uma vez e mostra a saida
                            bruta, o texto extraido e se ha uso no stream.
                            Rode isto ANTES de qualquer outra coisa.
  --config <arquivo>        config do benchmark            (bench.config.json)
  --manifest <arquivo>      manifest do select-prs         (manifest.json)
  --root <dir>              raiz de trabalho               (.bench)
  --repos a,b               so estes repos da config
  --no-agent                pula a passada semantica (perfil vira fallback)
  --refresh-semantic        refaz a passada semantica mesmo com cache valido
  --no-fetch                nao atualiza os mirrors ja existentes
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
      `Config nao encontrado: ${configPath}\n\nExemplo:\n${JSON.stringify(CONFIG_EXAMPLE, null, 2)}`,
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
  if (repos.length === 0) throw new Error("Nenhum repo selecionado.");

  step(1, 5, "Mirrors");
  const gitByRepo = new Map<string, { git: GitRepo; mirrorPath: string }>();
  for (const repo of repos) {
    gitByRepo.set(repo.name, await resolveRepo(root, repo, cfg, refreshMirrors));
  }

  step(2, 5, "Sondagem (deterministica primeiro, LLM so no que sobra)");
  const profiles: ProjectProfile[] = [];

  for (const repo of repos) {
    const { git, mirrorPath } = gitByRepo.get(repo.name)!;
    const wt = await probeCheckout(root, repo, git);
    if (!wt) continue;

    const probe = await probeStack(repo.name, wt);
    info(
      `${repo.name}: ${probe.framework.join("+") || probe.ecosystem} | ${probe.packageManager} | ` +
        `${probe.testRunner ?? "sem runner"}` +
        (probe.existingKiro.steering.length || probe.existingKiro.mcp
          ? ` | ja tem config de agente versionada`
          : ""),
    );
    if (probe.existingKiro.steering.length || probe.existingKiro.mcp || probe.existingKiro.agentsMd) {
      warn(
        `${repo.name} versiona configuracao de agente. ` +
          (stripExisting
            ? "Os arms vao apaga-la no worktree para que A0 seja baseline limpo."
            : 'baselineStripsExistingConfig=false: A0 NAO e baseline limpo, e sim "config atual".'),
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
      info(`  perfil semantico reaproveitado do cache (lockfile inalterado)`);
    } else if (!skipSemantic) {
      process.stdout.write(`    perfilando com ${adapter.cmd}... `);
      const res = await runAgent(adapter, { prompt: semanticPrompt(probe), cwd: wt });
      const parsed = res.ok ? parseJsonLoose<unknown>(res.text) : null;
      if (isSemanticProfile(parsed)) {
        semantic = parsed;
        source = "agent";
        console.log(`ok (confianca: ${parsed.confidence})`);
      } else {
        console.log(
          `falhou (exit ${res.exitCode}${res.spawnError ? `, ${res.spawnError}` : ""}) — fallback`,
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

  step(3, 5, "Arms (um conjunto por repo — steering segue a arquitetura de cada um)");
  const armsByRepo = new Map<string, Arm[]>();
  for (const p of profiles) {
    const arms = buildArms(p, stripExisting);
    armsByRepo.set(p.repo, arms);
    for (const arm of arms) {
      await writeJson(path.join(root, "arms", p.repo, `${arm.id}.json`), arm);
    }
    info(`${p.repo}: ${arms.map((x) => x.id).join(" ")}  ${dim(arms[0].overlay.remove.length ? `(strip: ${arms[0].overlay.remove.join(", ")})` : "")}`);
  }

  step(4, 5, "Observabilidade");
  await scaffoldObservability(root, cfg);
  info("obs/runs.jsonl, obs/schema.json, obs/credits.json, obs/PRE-REGISTRO.md");

  step(5, 5, "Plano de execucao");
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
  info(`${plan.length} runs em ordem randomizada (seed ${cfg.seed ?? 42})`);

  const lowConf = profiles.filter((p) => p.semantic.confidence === "low");
  if (lowConf.length) {
    warn(
      `Confianca baixa em: ${lowConf.map((p) => p.repo).join(", ")}\n` +
        `   Revise .bench/projects/*.json antes de gastar cota — steering ruim contamina ` +
        `A2 em diante por igual e o benchmark mede a sua descricao errada, nao a config.`,
    );
  }
  if (!cfg.model) {
    warn("cfg.model nao definido. Trave um modelo antes de rodar, ou o resultado nao se sustenta.");
  }

  console.log("");
  ok(`bootstrap pronto em ${root}`);
  info(`proximo: preencha ${path.join(root, "obs/PRE-REGISTRO.md")}, depois rode`);
  info(dim(`  node src/bench-run.ts --config ${configPath}`));
}

main().catch((err) => {
  console.log("");
  fail(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
