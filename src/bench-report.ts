#!/usr/bin/env node
/**
 * bench-report.ts
 *
 * Le obs/runs.jsonl e responde a pergunta do benchmark:
 * qual arm entrega mais tarefa aprovada por credito gasto.
 *
 * Metrica primaria: custo por tarefa aprovada. Nao pass@1 cru — um arm barato
 * que falha metade das vezes custa mais no total do que um arm caro que acerta.
 *
 * Tambem roda as checagens de validade. Se a variancia entre reps for maior
 * que a diferenca entre arms, o benchmark nao concluiu nada, e o relatorio
 * diz isso em vez de deixar voce escolher o numero que preferir.
 *
 * Uso:
 *   node src/bench-report.ts --root .bench
 *   node src/bench-report.ts --by-task --markdown relatorio.md
 *
 * Sem dependencias externas. Node >= 22.6.
 */

import path from "node:path";

import { readArgs } from "./lib/args.ts";
import { readJson, writeJson, writeText } from "./lib/fsx.ts";
import { bold, cyan, dim, fail, green, info, ok, red, rule, table, warn, yellow } from "./lib/log.ts";
import { loadRuns } from "./lib/obs.ts";
import { fmtMs, mean, stdev, wilson } from "./lib/stats.ts";
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
  /** Desvio do custo dentro da mesma celula (arm x tarefa). */
  withinCellStdev: number;
  setupFailures: number;
  timeouts: number;
}

// ─────────────────────────────────────────────────── custo por run

type CostUnit = "creditos" | "USD" | "tokens" | "n/d";

/**
 * Escolhe UMA unidade de custo para todo o relatorio, na ordem em que ela
 * responde a pergunta do time. Misturar unidade entre arms produziria uma
 * comparacao sem sentido, entao a unidade e global.
 */
function pickCostUnit(runs: RunRecord[]): CostUnit {
  if (runs.some((r) => r.creditsDelta !== null || r.usageFromStream.credits !== null)) {
    return "creditos";
  }
  if (runs.some((r) => r.usageFromStream.costUsd !== null)) return "USD";
  if (runs.some((r) => r.usageFromStream.totalTokens !== null)) return "tokens";
  return "n/d";
}

function costOf(run: RunRecord, unit: CostUnit): number | null {
  switch (unit) {
    case "creditos":
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
 * Distribui saldo de credito lido a mao pelos runs de cada janela.
 *
 * Funciona so se os arms foram rodados EM SERIE, com um snapshot antes e
 * outro depois de cada bloco. Fora disso o numero e ficcao, e o relatorio avisa.
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

// ─────────────────────────────────────────────────── agregacao

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

    // variancia dentro da celula: reps da mesma (arm x tarefa)
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

// ─────────────────────────────────────────────────── validade

interface Validity {
  level: "ok" | "atencao" | "invalido";
  messages: string[];
}

function checkValidity(runs: RunRecord[], stats: ArmStats[], plan: Plan | null): Validity {
  const messages: string[] = [];
  let level: Validity["level"] = "ok";
  const escalate = (l: Validity["level"]): void => {
    if (l === "invalido" || (l === "atencao" && level === "ok")) level = l;
  };

  const models = new Set(runs.map((r) => r.model ?? "(nao travado)"));
  if (models.size > 1) {
    escalate("invalido");
    messages.push(
      `Modelo trocou no meio do benchmark: ${[...models].join(", ")}. ` +
        `A comparacao entre arms nao se sustenta — refaca com um modelo so.`,
    );
  }
  if (models.has("(nao travado)")) {
    escalate("atencao");
    messages.push("Ha runs sem modelo registrado. Trave cfg.model antes de rodar.");
  }

  const cellCounts = new Map<string, number>();
  for (const r of runs) cellCounts.set(cellKey(r), (cellCounts.get(cellKey(r)) ?? 0) + 1);
  const thin = [...cellCounts.entries()].filter(([, n]) => n < 3);
  if (thin.length) {
    escalate("atencao");
    messages.push(
      `${thin.length} celula(s) com menos de 3 repeticoes. O agente e estocastico: ` +
        `com n < 3 a diferenca entre arms pode ser so sorteio.`,
    );
  }

  if (plan && runs.length < plan.totalRuns) {
    escalate("atencao");
    messages.push(
      `${plan.totalRuns - runs.length} de ${plan.totalRuns} runs do plano ainda nao rodaram. ` +
        `Comparar arms com cobertura desigual enviesa o resultado.`,
    );
  }

  const withCost = stats.filter((s) => s.costPerRun !== null);
  if (withCost.length >= 2) {
    const costs = withCost.map((s) => s.costPerRun as number);
    const spread = Math.max(...costs) - Math.min(...costs);
    const noise = Math.max(...withCost.map((s) => s.withinCellStdev));
    if (noise > 0 && noise > spread) {
      escalate("invalido");
      messages.push(
        `Ruido maior que sinal: a variacao entre repeticoes da MESMA celula ` +
          `(desvio ${num(noise)}) supera a diferenca entre os arms (${num(spread)}). ` +
          `Este benchmark nao conclui nada: o que separa os arms cabe dentro do ` +
          `sorteio. Aumente as repeticoes ou escolha tarefas menos ruidosas.`,
      );
    }
  }

  const brokenRuns = runs.filter(
    (r) => r.status === "setup-failed" || r.status === "agent-failed",
  );
  if (brokenRuns.length > runs.length * 0.1) {
    escalate("atencao");
    messages.push(
      `${brokenRuns.length} run(s) falharam antes de qualquer avaliacao (setup ou agente). ` +
        `Investigue .bench/logs/ antes de ler os numeros.`,
    );
  }

  const noGrader = runs.filter((r) => !r.heldOutTests.ran).length;
  if (noGrader) {
    escalate("atencao");
    messages.push(
      `${noGrader} run(s) sem grader held-out executado: essas tarefas nunca podem ser ` +
        `aprovadas. Rode select-prs com --require-tests.`,
    );
  }

  return { level, messages };
}

// ─────────────────────────────────────────────────── saida

function pct(v: number): string {
  return `${(v * 100).toFixed(0)}%`;
}

/** Precisao adaptativa: custo em USD e em token nao cabem na mesma escala. */
function num(v: number | null): string {
  if (v === null) return "-";
  const abs = Math.abs(v);
  const digits = abs === 0 ? 0 : abs < 0.01 ? 4 : abs < 1 ? 3 : abs < 100 ? 2 : 0;
  return v.toLocaleString("pt-BR", { maximumFractionDigits: digits });
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

  rule(`custo por tarefa aprovada (${unit})`);
  table(
    [
      { header: "arm", width: 4 },
      { header: "configuracao", width: 28 },
      { header: "runs", width: 5, align: "right" },
      { header: "pass@1", width: 7, align: "right" },
      { header: "IC95", width: 13, align: "right" },
      { header: `custo/run`, width: 10, align: "right" },
      { header: `custo/aprov`, width: 12, align: "right" },
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

  rule("qualidade e comportamento");
  table(
    [
      { header: "arm", width: 4 },
      { header: "escopo inventado", width: 17, align: "right" },
      { header: "completude", width: 11, align: "right" },
      { header: "turnos", width: 7, align: "right" },
      { header: "wall-clock", width: 11, align: "right" },
      { header: "ruido/celula", width: 13, align: "right" },
      { header: "quebrados", width: 10, align: "right" },
    ],
    stats.map((s) => [
      s.arm,
      `${s.scopeCreep.toFixed(2)} arq/run`,
      pct(s.completeness),
      s.turns.toFixed(1),
      fmtMs(s.wallClockMs),
      num(s.withinCellStdev),
      `${s.setupFailures}${s.timeouts ? ` (+${s.timeouts} t/o)` : ""}`,
    ]),
  );
}

function printByTask(runs: RunRecord[], unit: CostUnit): void {
  rule("por tarefa");
  const tasks = [...new Set(runs.map((r) => r.taskId))].sort();
  const arms = [...new Set(runs.map((r) => r.arm))].sort();

  table(
    [
      { header: "tarefa", width: 26 },
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

  return `# Resultado do benchmark de configuracoes

Gerado em ${new Date().toISOString()}. Unidade de custo: **${unit}**.
Baseline: **${baseline?.arm ?? "-"}**.

## Metrica primaria — custo por tarefa aprovada

| arm | configuracao | runs | pass@1 | custo/run | custo/aprovada | escopo inventado | completude |
|---|---|---|---|---|---|---|---|
${rows}

${
  best
    ? `Menor custo por tarefa aprovada: **${best.arm} — ${best.label}** ` +
      `(${num(best.costPerSuccess)} ${unit} por aprovada, pass@1 ${pct(best.pass1)}).`
    : "Nenhum arm registrou custo: use os snapshots manuais em obs/credits.json."
}

## Validade

Status: **${validity.level}**

${validity.messages.length ? validity.messages.map((m) => `- ${m}`).join("\n") : "- Nenhum problema detectado nas checagens automaticas."}

## Antes de adotar

Compare o numero acima com o criterio que voce escreveu em \`obs/PRE-REGISTRO.md\`
**antes** de olhar estes dados. Se o criterio nao foi batido, o vencedor aqui nao
e motivo para mudar nada.

Benchmark offline mede tarefa isolada. Nao mede friccao no dia a dia, hook que o
dev burla, nem contexto acumulado de uma feature de tres dias. Valide o vencedor
com duas semanas de uso real antes de fechar a questao.
`;
}

// ─────────────────────────────────────────────────── main

const USAGE = `
bench-report — custo por tarefa aprovada, por arm, com checagem de validade

  node src/bench-report.ts [opcoes]

  --root <dir>              raiz de trabalho               (da config, ou .bench)
  --config <arquivo>        config, so para achar a raiz   (bench.config.json)
  --baseline <arm>          arm de comparacao              (A0)
  --only-arms A0,A3         restringe a analise
  --by-task                 abre o resultado por tarefa
  --markdown <arquivo>      escreve o relatorio em markdown
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
      `Nenhum run em ${path.join(root, "obs/runs.jsonl")}.\n   Rode bench-run.ts antes.`,
    );
  }

  const filterArms = a.list("--only-arms");
  const filtered = filterArms.length ? runs.filter((r) => filterArms.includes(r.arm)) : runs;

  // dedup: o mesmo runId so conta uma vez, e vale a gravacao mais recente
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
  info(`unidade de custo: ${unit === "n/d" ? yellow("nenhuma") : cyan(unit)}   raiz: ${root}`);
  if (attributed) info(`${attributed} run(s) com credito atribuido por snapshot manual`);
  if (duplicates) info(dim(`${duplicates} linha(s) duplicada(s) de runId ignorada(s)`));

  printReport(stats, unit, baselineId);
  if (a.bool("--by-task")) printByTask(unique, unit);

  rule("validade");
  if (validity.messages.length === 0) {
    ok("nenhum problema detectado nas checagens automaticas");
  } else {
    for (const m of validity.messages) {
      if (validity.level === "invalido") fail(m);
      else warn(m);
    }
  }

  if (unit === "n/d") {
    warn(
      "Nenhum custo registrado. O stream do CLI nao expoe uso: rode os arms em serie e " +
        `preencha os snapshots em ${path.join(root, "obs/credits.json")}.`,
    );
  }

  await writeJson(path.join(root, "obs", "report.json"), {
    generatedAt: new Date().toISOString(),
    root,
    costUnit: unit,
    baseline: baselineId,
    totalRuns: unique.length,
    arms: stats,
    validity,
  });

  const mdPath = a.str("--markdown");
  if (mdPath) {
    await writeText(mdPath, markdown(stats, unit, validity, baselineId));
    info(`markdown em ${mdPath}`);
  }

  console.log("");
  ok(`relatorio em ${path.join(root, "obs/report.json")}`);
  info(
    dim(
      "Compare com o criterio de adocao que voce escreveu ANTES de olhar estes numeros, " +
        `em ${path.join(root, "obs/PRE-REGISTRO.md")}.`,
    ),
  );
}

main().catch((err) => {
  console.log("");
  fail(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
