import path from "node:path";

import { appendLine, existsSync, readJsonl, writeJson, writeText } from "./fsx.ts";
import type { BenchConfig, RunRecord } from "./types.ts";

/**
 * Observabilidade. Um arquivo append-only e a fonte da verdade dos resultados.
 * Nunca reescreva uma linha existente: um run interrompido no meio deixa uma
 * linha truncada, que o leitor descarta, e a proxima execucao refaz o run.
 */

export function obsDir(root: string): string {
  return path.join(root, "obs");
}

export function runsPath(root: string): string {
  return path.join(obsDir(root), "runs.jsonl");
}

export const OBS_SCHEMA = {
  file: "runs.jsonl",
  note: "Append-only. Uma linha por run. Nunca reescrever linha existente.",
  fields: {
    runId: "string — <arm>.<taskId>.<rep>, com # trocado por -",
    arm: "string",
    taskId: "string — <repo>#<prId>",
    repo: "string",
    rep: "number",
    mode: "vibe | spec",
    model: "string | null — travado para todo o benchmark",
    startedAt: "ISO",
    endedAt: "ISO",
    wallClockMs: "number — setup + agente + avaliacao",
    agentMs: "number — so o tempo dentro do CLI do agente",
    exitCode: "number | null",
    agentTurns: "number — 1 = tentativa inicial; >1 = reparo por gate vermelho",
    timedOut: "boolean",
    usageFromStream: "objeto — tokens somados, custo/credito pelo maximo observado",
    creditsBefore: "number | null — snapshot manual do dashboard",
    creditsAfter: "number | null",
    creditsDelta: "number | null",
    filesTouched: "string[] — o que o agente escreveu, antes de plantar o grader",
    filesOutsideGoldenDiff: "string[] — metrica de escopo inventado",
    goldenFilesMissed: "string[] — arquivos do PR original que o agente nao tocou",
    heldOutOverwrites: "string[] — testes que o agente escreveu e o grader sobrescreveu",
    gates: "{ lint, typecheck, arch } — true | false | null (nao aplicavel)",
    gateDetail: "array com comando, exit code, duracao e saida truncada",
    heldOutTests: "{ passed, failed, total, ran }",
    success: "boolean — todo teste held-out passa E nenhum gate vermelho",
    status: "ok | agent-failed | setup-failed | graded-failed",
    notes: "string",
  },
  derived: {
    creditsPerSuccess: "sum(custo) / count(success) por arm — a metrica que decide",
    pass1: "count(success) / count(runs) por arm",
    scopeCreep: "mean(filesOutsideGoldenDiff.length) por arm",
    completeness: "mean(1 - goldenFilesMissed/goldenFiles) por arm — task pela metade",
  },
};

export async function appendRun(root: string, record: RunRecord): Promise<void> {
  await appendLine(runsPath(root), JSON.stringify(record));
}

export async function loadRuns(root: string): Promise<RunRecord[]> {
  return await readJsonl<RunRecord>(runsPath(root));
}

/** Runs ja gravados, por runId. O runner usa para retomar de onde parou. */
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
        "Snapshot manual de creditos. Use quando o stream do CLI nao expuser usage. " +
        "Rode os arms em serie e registre o saldo do dashboard antes e depois de cada bloco. " +
        "O bench-report cruza estes snapshots com os runs pelo intervalo de tempo.",
      model: cfg.model ?? "REGISTRE AQUI O MODELO TRAVADO",
      snapshots: [
        {
          _exemplo: true,
          at: "2026-01-01T10:00:00Z",
          balance: 0,
          label: "antes do bloco A0",
        },
      ],
    });
  }

  const preReg = path.join(dir, "PRE-REGISTRO.md");
  if (!existsSync(preReg)) {
    await writeText(
      preReg,
      `# Pre-registro do benchmark

Preencha ANTES de olhar qualquer resultado. Isso te protege de escolher, depois,
o numero que confirma o que voce ja queria.

## Criterio de adocao

> Adoto o arm vencedor se: ______________________________________
> (exemplo: credito por tarefa aprovada cair >= 30% contra A0, sem queda de pass@1)

## Metrica primaria

Creditos por tarefa aprovada.

## Metricas secundarias

pass@1, arquivos fora do golden diff, arquivos do golden nao tocados, wall-clock.

## Modelo travado

${cfg.model ?? "(definir antes de rodar)"}

## Repeticoes por celula

${cfg.reps ?? 3}

## O que invalida este benchmark

- [ ] variancia entre reps maior que a diferenca entre arms
- [ ] menos de 3 reps por celula
- [ ] arms rodados em ordem fixa (drift do servico vira efeito falso)
- [ ] modelo trocado no meio
- [ ] perfil semantico com confidence baixa alimentando o steering de A2 em diante

## Decisao registrada em ____ / ____ / ______, por ______________________
`,
    );
  }
}
