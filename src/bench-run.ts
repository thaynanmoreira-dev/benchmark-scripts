#!/usr/bin/env node
/**
 * bench-run.ts
 *
 * O runner. Consome .bench/plan.json e executa cada celula (arm x tarefa x rep).
 *
 * Para cada entrada, na ordem randomizada do plano:
 *   1. worktree detached do mirror no baseCommit
 *   2. instala dependencias (cache compartilhado por hash de lockfile)
 *   3. aplica o overlay do arm: apaga config pre-existente, escreve steering/mcp
 *   4. dispara o CLI do agente com a descricao da task
 *      -> arm com enforceGates entra em loop de reparo com lint/typecheck/arch
 *   5. fotografa os arquivos tocados (ANTES de plantar o grader)
 *   6. planta os testes held-out vindos do commit do PR e roda um a um
 *   7. roda os gates deterministicos
 *   8. compara o que foi tocado com o golden diff -> metrica de escopo
 *   9. append de uma linha em obs/runs.jsonl
 *  10. destroi o worktree
 *
 * Interrompeu no meio? Rode de novo: runs ja gravados sao pulados.
 *
 * Uso:
 *   node src/bench-run.ts --config bench.config.json
 *   node src/bench-run.ts --only-arms A0,A3 --limit 12
 *   node src/bench-run.ts --dry-run
 *
 * Sem dependencias externas. Node >= 22.6.
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
 * O prompt e IDENTICO em todos os arms. A unica coisa que varia entre arms e o
 * overlay (steering, mcp) e o modo do CLI. Se o prompt mudar junto, o
 * experimento deixa de atribuir o efeito a configuracao.
 */
function taskPrompt(task: SelectedPr): string {
  const body = task.description.trim();
  return `# Tarefa

${task.title}

${body || "(o work item nao trouxe descricao alem do titulo)"}

## Contexto de execucao

- Voce esta num worktree limpo do repositorio ${task.repo}, no commit anterior a esta mudanca.
- Implemente a tarefa por completo, direto no codigo. Nao existe etapa de revisao depois.
- Siga as convencoes que ja existem no repositorio.
`;
}

function repairPrompt(task: SelectedPr, failures: GateResult[]): string {
  const blocks = failures
    .map(
      (f) =>
        `### ${f.name}\n$ ${f.command}\nexit ${f.exitCode}\n\n${clip(f.output.trim(), 2500)}`,
    )
    .join("\n\n");

  return `# Reparo

A tarefa abaixo foi implementada neste worktree, mas os gates deterministicos
ficaram vermelhos. Corrija o que quebrou.

Tarefa original: ${task.title}

Regras do reparo:
- Corrija apenas o que os gates apontam. Nao amplie o escopo.
- Nao desative regra de lint, nao apague teste e nao relaxe configuracao para passar.

## Gates vermelhos

${blocks}
`;
}

// ══════════════════════════════════════════════════════ gates

interface GateSpec {
  name: string;
  command: string | null;
}

/**
 * Os gates deterministicos. A suite propria do repo entra aqui como gate de
 * regressao: ela ja existe no commit base, entao o agente pode ve-la e roda-la
 * sem que isso vaze o grader held-out, que so e plantado depois.
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
        output: "gate nao aplicavel a este repositorio",
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
 * Planta os testes do PR original no worktree e roda um por um.
 *
 * Um por um de proposito: da sinal parcial (2 de 3 passaram) e nao depende de
 * parsear a saida de nenhum runner especifico. O agente nunca ve estes
 * arquivos — eles so aparecem depois que ele terminou.
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
    // sem forma de escopar por arquivo: a suite inteira vira um unico veredito
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

// ══════════════════════════════════════════════════════ escopo

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

/** Ruido do proprio harness que nunca conta como escopo inventado. */
function isHarnessPath(file: string): boolean {
  return (
    file.startsWith(".kiro/") ||
    file.startsWith("node_modules/") ||
    file === "node_modules" ||
    file.startsWith(".bench/")
  );
}

// ══════════════════════════════════════════════════════ um run

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

  // ── 1. worktree no commit base
  try {
    if (!(await ensureCommit(mirror, task.baseCommit))) {
      record.notes = `commit base ${task.baseCommit} inacessivel no mirror`;
      return finish();
    }
    await addWorktree(mirror, worktree, task.baseCommit);
  } catch (err) {
    record.notes = `worktree falhou: ${err instanceof Error ? err.message : String(err)}`;
    return finish();
  }

  try {
    // ── 2. dependencias
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

    // ── 3. overlay do arm
    for (const rel of arm.overlay.remove) await removePath(path.join(worktree, rel));
    const overlayPaths = new Set(await materialize(worktree, arm.overlay.files));

    // ── 4. agente, com loop de reparo quando o arm exige gates
    //
    // Arm sem enforceGates roda o agente uma vez e ponto: e exatamente essa a
    // diferenca que A3 testa. Arm com enforceGates devolve os gates vermelhos
    // ao agente ate ficarem verdes ou acabar o orcamento de turnos — e cada
    // turno extra entra na conta de credito, que e o ponto do experimento.
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
        record.notes = `agente nao executou: ${res.spawnError}`;
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

    // ── 5. o que o agente tocou, antes de plantar o grader
    const touched = (await touchedFiles(workRepo(worktree))).filter((f) => !isHarnessPath(f));
    record.filesTouched = touched;
    const scope = scopeMetrics(touched, task, overlayPaths);
    record.filesOutsideGoldenDiff = scope.outside;
    record.goldenFilesMissed = scope.missed;

    // ── 6. gates finais, AINDA sem o grader no disco. O laco de reparo ja
    //      deixou um resultado fresco do ultimo turno; so recalcula quem nao rodou.
    const finalGates = gates ?? (await runGates(specs, worktree, ctx.gateTimeoutMs));
    for (const g of finalGates) record.gates[g.name] = g.passed;

    // ── 7. grader held-out: planta os testes do PR e roda um a um
    const held = await gradeHeldOut(worktree, task, profile, touched, ctx.gateTimeoutMs);
    record.heldOutTests = {
      passed: held.passed,
      failed: held.failed,
      total: held.total,
      ran: held.ran,
    };
    record.heldOutOverwrites = held.overwrites;
    record.gateDetail = [...finalGates, ...held.detail];

    // ── 8. veredito
    const gatesGreen = finalGates.every((g) => g.passed !== false);
    const testsGreen = held.ran && held.failed === 0 && held.total > 0;
    record.success = gatesGreen && testsGreen;
    record.status = record.success ? "ok" : "graded-failed";
    if (!held.ran) {
      record.notes = task.testFiles.length
        ? "grader held-out nao rodou: sem comando de teste no perfil"
        : "tarefa sem teste held-out: nao pode ser aprovada automaticamente";
    }
    return finish();
  } finally {
    if (!ctx.opts.keepWorktrees) {
      await removeWorktree(mirror, worktree).catch(() => undefined);
    }
  }
}

/** Mirror bare ou clone comum: o worktree sai dos dois do mesmo jeito. */
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
    ? `${record.heldOutTests.passed}/${record.heldOutTests.total} testes`
    : "sem grader";
  const gates = Object.entries(record.gates)
    .map(([k, v]) => `${k}:${v === null ? "-" : v ? "ok" : "x"}`)
    .join(" ");
  const cost =
    record.usageFromStream.totalTokens !== null
      ? `${record.usageFromStream.totalTokens} tok`
      : record.usageFromStream.costUsd !== null
        ? `$${record.usageFromStream.costUsd}`
        : "custo n/d";
  return (
    `${verdict}  ${tests}  ${gates}  escopo+${record.filesOutsideGoldenDiff.length}  ` +
    `turnos:${record.agentTurns}  ${fmtMs(record.wallClockMs)}  ${cost}`
  );
}

const USAGE = `
bench-run — executa o plano: worktree, overlay do arm, agente, grader, gates

  node src/bench-run.ts [opcoes]

  --config <arquivo>        config do benchmark            (bench.config.json)
  --manifest <arquivo>      manifest do select-prs         (manifest.json)
  --root <dir>              raiz de trabalho               (da config, ou .bench)

selecao
  --only-arms A0,A3         so estes arms
  --only-tasks id1,id2      so estas tarefas
  --only-repos a,b          so estes repos
  --from <n>                comeca nesta posicao do plano
  --limit <n>               teto de runs nesta execucao
  --force                   reexecuta runs ja gravados

execucao
  --dry-run                 mostra o que rodaria, sem invocar o agente
  --install-strategy <s>    symlink | copy | fresh | none   (symlink)
  --max-gate-retries <n>    turnos de reparo nos arms com gates (config, ou 2)
  --pause-ms <n>            pausa entre runs
  --keep-worktrees          nao apaga o worktree (para depurar)

Runs ja gravados em obs/runs.jsonl sao pulados: pode interromper e retomar.
`;

async function main(): Promise<void> {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    console.log(USAGE.trim());
    return;
  }
  const opts = parseOptions(process.argv.slice(2));
  const cfg = await readJson<BenchConfig>(opts.config);
  if (!cfg) throw new Error(`Config nao encontrado: ${opts.config}`);

  const root = path.resolve(opts.root || cfg.root || ".bench");
  const planPath = path.join(root, "plan.json");
  const plan = await readJson<Plan>(planPath);
  if (!plan?.entries?.length) {
    throw new Error(`Plano vazio ou ausente: ${planPath}\n   Rode bench-init.ts antes.`);
  }

  const manifest = await readJson<Manifest>(opts.manifest);
  if (!manifest?.tasks?.length) throw new Error(`Manifest vazio ou ausente: ${opts.manifest}`);
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
    warn("cfg.model nao definido: sem modelo travado o resultado nao se sustenta.");
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

  console.log(bold(`\nbench-run — ${selected.length} run(s) de ${plan.totalRuns} no plano`));
  info(`modelo: ${cfg.model ?? dim("(nao travado)")}   raiz: ${root}`);
  if (alreadyDone.size) info(`${alreadyDone.size} run(s) ja gravados serao pulados`);
  if (opts.dryRun) info(yellow("--dry-run: nenhum agente sera invocado"));

  let done = 0;
  let passes = 0;

  for (const entry of selected) {
    const task = taskById.get(entry.taskId);
    if (!task) {
      warn(`${entry.runId}: tarefa ${entry.taskId} nao esta no manifest — pulando`);
      continue;
    }

    const armKey = `${entry.repo}/${entry.arm}`;
    let arm = armCache.get(armKey);
    if (!arm) {
      const loaded = await readJson<Arm>(path.join(root, "arms", entry.repo, `${entry.arm}.json`));
      if (!loaded) {
        warn(`${entry.runId}: arm ${armKey} nao encontrado — pulando`);
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
        warn(`${entry.runId}: perfil de ${entry.repo} nao encontrado — pulando`);
        continue;
      }
      profile = loaded;
      profileCache.set(entry.repo, profile);
    }

    done++;
    const head = `${cyan(`[${done}/${selected.length}]`)} ${entry.runId} ${dim(`${arm.label} / ${task.title.slice(0, 40)}`)}`;

    if (opts.dryRun) {
      console.log(`${head}\n    ${dim(`worktree @ ${task.baseCommit.slice(0, 8)} | overlay: ${Object.keys(arm.overlay.files).join(", ") || "nenhum"} | gates: ${arm.overlay.enforceGates}`)}`);
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
    ok(`${done} run(s) seriam executados`);
  } else {
    ok(`${done} run(s) concluidos, ${passes} aprovados`);
    info(dim(`resultados em ${path.join(root, "obs/runs.jsonl")}`));
    info(dim(`analise:  node src/bench-report.ts --root ${root}`));
  }
}

main().catch((err) => {
  console.log("");
  fail(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
