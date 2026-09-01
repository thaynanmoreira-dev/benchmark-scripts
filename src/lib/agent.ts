import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";

import type { AgentConfig, UsageSnapshot } from "./types.ts";

/**
 * Adapter para o CLI do agente. O harness nao assume nada sobre o formato de
 * saida: aceita texto puro, stream-json e mistura dos dois. Calibre com
 * `node src/bench-init.ts --probe-agent` antes de gastar cota.
 */

export const DEFAULT_AGENT: AgentConfig = {
  cmd: "kiro-cli",
  args: ["chat", "--no-interactive", "--trust-tools=read,grep"],
  promptMode: "stdin",
  modeArgs: { vibe: [], spec: [] },
  timeoutMs: 900_000,
};

export interface AgentInvocation {
  prompt: string;
  cwd: string;
  mode?: "vibe" | "spec";
  extraArgs?: string[];
  model?: string | null;
  /** Caminho para gravar a saida bruta. Ajuda a depurar run ruim. */
  logPath?: string;
}

export interface AgentResult {
  ok: boolean;
  /** Texto extraido do stream — o que o agente "disse". */
  text: string;
  /** Saida bruta, stdout + stderr, como veio. */
  raw: string;
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  usage: UsageSnapshot;
  /** Erro de spawn (binario ausente, por exemplo). */
  spawnError: string | null;
}

export function emptyUsage(): UsageSnapshot {
  return {
    inputTokens: null,
    outputTokens: null,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    totalTokens: null,
    costUsd: null,
    credits: null,
    samples: 0,
    basis: "nenhum",
    source: "none",
  };
}

function buildArgs(cfg: AgentConfig, inv: AgentInvocation): string[] {
  const args = [...cfg.args];
  const modeArgs = inv.mode ? cfg.modeArgs?.[inv.mode] ?? [] : [];
  args.push(...modeArgs, ...(inv.extraArgs ?? []));
  if (inv.model && cfg.modelFlag) args.push(cfg.modelFlag, inv.model);
  if (cfg.promptMode === "arg") {
    if (cfg.promptFlag) args.push(cfg.promptFlag);
    args.push(inv.prompt);
  }
  return args;
}

export async function runAgent(cfg: AgentConfig, inv: AgentInvocation): Promise<AgentResult> {
  const args = buildArgs(cfg, inv);
  const timeoutMs = cfg.timeoutMs ?? DEFAULT_AGENT.timeoutMs ?? 900_000;
  const startedAt = Date.now();

  if (inv.logPath) await mkdir(path.dirname(inv.logPath), { recursive: true });
  const logStream = inv.logPath ? createWriteStream(inv.logPath, { flags: "a" }) : null;

  return await new Promise<AgentResult>((resolve) => {
    let out = "";
    let err = "";
    let timedOut = false;
    let settled = false;

    const child = spawn(cfg.cmd, args, {
      cwd: inv.cwd,
      env: { ...process.env, ...(cfg.env ?? {}) },
      stdio: ["pipe", "pipe", "pipe"],
    });

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);

    const finish = (exitCode: number | null, spawnError: string | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      logStream?.end();
      const raw = out + (err ? `\n--- stderr ---\n${err}` : "");
      resolve({
        ok: exitCode === 0 && !timedOut,
        text: extractText(out) || extractText(raw),
        raw,
        exitCode,
        timedOut,
        durationMs: Date.now() - startedAt,
        usage: extractUsage(raw),
        spawnError,
      });
    };

    child.stdout.on("data", (d: Buffer) => {
      const s = d.toString();
      out += s;
      logStream?.write(s);
    });
    child.stderr.on("data", (d: Buffer) => {
      const s = d.toString();
      err += s;
      logStream?.write(s);
    });

    if (cfg.promptMode === "stdin") {
      child.stdin.on("error", () => {
        /* CLI que fecha stdin cedo */
      });
      child.stdin.write(inv.prompt);
      child.stdin.end();
    } else {
      child.stdin.end();
    }

    child.on("error", (e) => finish(null, e.message));
    child.on("close", (code) => finish(code, null));
  });
}

// ─────────────────────────────────────────────────── parsing da saida

/** Tolerante: aceita texto puro ou stream-json com blocos de texto. */
export function extractText(raw: string): string {
  const lines = raw.split("\n").filter((l) => l.trim());
  const jsonLines = lines.filter((l) => l.trimStart().startsWith("{"));
  if (jsonLines.length === 0 || jsonLines.length < lines.length / 2) return raw;

  const chunks: string[] = [];
  for (const line of jsonLines) {
    const obj = tryParse(line);
    if (!obj) continue;
    walk(obj, (node) => {
      if (typeof (node as Record<string, unknown>).text === "string") {
        chunks.push((node as Record<string, unknown>).text as string);
      }
    });
  }
  return chunks.length ? chunks.join("") : raw;
}

/** Extrai o primeiro objeto JSON do texto, tolerando cercas de codigo. */
export function parseJsonLoose<T>(text: string): T | null {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1] : text;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  const direct = tryParse(candidate.slice(start, end + 1));
  if (direct) return direct as T;
  // fecho extra depois do objeto: tenta encurtar ate parsear
  for (let i = end; i > start; i = candidate.lastIndexOf("}", i - 1)) {
    const attempt = tryParse(candidate.slice(start, i + 1));
    if (attempt) return attempt as T;
  }
  return null;
}

function tryParse(s: string): unknown | null {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

function walk(node: unknown, visit: (o: object) => void, depth = 0): void {
  if (depth > 12 || node === null || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const item of node) walk(item, visit, depth + 1);
    return;
  }
  visit(node);
  for (const value of Object.values(node as Record<string, unknown>)) {
    walk(value, visit, depth + 1);
  }
}

// ─────────────────────────────────────────────────── custo

const TOKEN_KEYS: Record<string, keyof UsageSnapshot> = {
  input_tokens: "inputTokens",
  inputTokens: "inputTokens",
  prompt_tokens: "inputTokens",
  output_tokens: "outputTokens",
  outputTokens: "outputTokens",
  completion_tokens: "outputTokens",
  cache_read_input_tokens: "cacheReadTokens",
  cacheReadInputTokens: "cacheReadTokens",
  cache_creation_input_tokens: "cacheWriteTokens",
  cacheCreationInputTokens: "cacheWriteTokens",
};

const COST_KEYS = ["total_cost_usd", "cost_usd", "costUsd", "total_cost"];
const CREDIT_KEYS = ["credits", "credits_used", "creditsUsed", "credit_cost"];

type TokenCounts = Partial<Record<keyof UsageSnapshot, number>>;

/** Contagens que este objeto declara diretamente, sem olhar os filhos. */
function ownTokens(node: Record<string, unknown>): TokenCounts | null {
  const counts: TokenCounts = {};
  let found = false;
  for (const [key, field] of Object.entries(TOKEN_KEYS)) {
    const v = node[key];
    if (typeof v === "number" && Number.isFinite(v)) {
      counts[field] = (counts[field] ?? 0) + v;
      found = true;
    }
  }
  return found ? counts : null;
}

/**
 * Acha o unico no de contabilidade que representa este evento.
 *
 * Isto e o que impede a contagem multipla. Um CLI real repete o mesmo consumo
 * em varios lugares do mesmo objeto — o Claude Code, por exemplo, publica os
 * mesmos tokens em `usage`, de novo em `usage.iterations[]` e mais uma vez em
 * `modelUsage[modelo]` com as chaves em camelCase. Somar tudo multiplicava o
 * consumo por oito no teste com o CLI de verdade.
 *
 * Regra: prefere o no sob a chave `usage`; na falta dele, o primeiro no em
 * largura que declare tokens. Achou, para de descer — o que estiver aninhado
 * abaixo e detalhamento do mesmo consumo, nao consumo adicional.
 */
function readUsageNode(root: unknown): TokenCounts | null {
  const queue: unknown[] = [root];
  const fallbacks: TokenCounts[] = [];

  while (queue.length > 0) {
    const node = queue.shift();
    if (node === null || typeof node !== "object") continue;

    if (Array.isArray(node)) {
      queue.push(...node);
      continue;
    }

    const rec = node as Record<string, unknown>;
    const usageChild = rec.usage ?? rec.usageMetadata;
    if (usageChild && typeof usageChild === "object" && !Array.isArray(usageChild)) {
      const direct = ownTokens(usageChild as Record<string, unknown>);
      if (direct) return direct;
    }

    const own = ownTokens(rec);
    if (own) {
      fallbacks.push(own);
      continue; // nao desce: filhos so detalham este mesmo consumo
    }

    queue.push(...Object.values(rec));
  }

  return fallbacks[0] ?? null;
}

function maxNumberByKey(root: unknown, keys: string[]): number | null {
  let best: number | null = null;
  walk(root, (node) => {
    const rec = node as Record<string, unknown>;
    for (const key of keys) {
      const v = rec[key];
      if (typeof v === "number" && Number.isFinite(v)) {
        best = best === null ? v : Math.max(best, v);
      }
    }
  });
  return best;
}

function addCounts(a: TokenCounts, b: TokenCounts): TokenCounts {
  const out: TokenCounts = { ...a };
  for (const [k, v] of Object.entries(b) as Array<[keyof UsageSnapshot, number]>) {
    out[k] = ((out[k] as number | undefined) ?? 0) + v;
  }
  return out;
}

/**
 * Varre a saida bruta atras da contabilidade de uso do CLI.
 *
 * Duas formas de stream sao suportadas, nesta ordem de preferencia:
 *
 *   terminal  O CLI fecha a invocacao com um evento de resumo que ja traz o
 *             total acumulado (e reconhecido por trazer custo). Esse evento e
 *             a verdade: os eventos anteriores sao parciais do mesmo total, e
 *             somar todos contaria o mesmo consumo varias vezes.
 *   somado    Nao ha evento de resumo. Cada evento contribui uma vez, e o
 *             total e a soma.
 *
 * `basis` registra qual das duas valeu, e `samples` quantos eventos entraram,
 * para que o numero possa ser conferido a mao contra o dashboard.
 */
export function extractUsage(raw: string): UsageSnapshot {
  const usage = emptyUsage();
  const events: unknown[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trimStart();
    if (!trimmed.startsWith("{")) continue;
    const obj = tryParse(trimmed);
    if (obj) events.push(obj);
  }
  if (events.length === 0) return usage;

  const withCost = events.filter((e) => maxNumberByKey(e, COST_KEYS) !== null);
  const withCredits = events.filter((e) => maxNumberByKey(e, CREDIT_KEYS) !== null);

  const somarEventos = (): { counts: TokenCounts | null; samples: number } => {
    let counts: TokenCounts | null = null;
    let samples = 0;
    for (const event of events) {
      const node = readUsageNode(event);
      if (!node) continue;
      counts = counts ? addCounts(counts, node) : node;
      samples++;
    }
    return { counts, samples };
  };

  let counts: TokenCounts | null = null;
  const resumo = withCost.length > 0 ? withCost[withCost.length - 1] : null;
  const doResumo = resumo ? readUsageNode(resumo) : null;

  if (doResumo) {
    // o resumo traz o acumulado da invocacao inteira; os parciais que o
    // precedem sao o mesmo consumo detalhado, e somar contaria duas vezes
    counts = doResumo;
    usage.basis = "terminal";
    usage.samples = 1;
  } else {
    // ha CLI que fecha com custo mas deixa os tokens so nos eventos de
    // mensagem. Nesse caso o custo vem do resumo e os tokens, da soma.
    const somado = somarEventos();
    counts = somado.counts;
    usage.basis = somado.samples > 0 ? "somado" : "nenhum";
    usage.samples = somado.samples;
  }

  if (counts) {
    usage.inputTokens = counts.inputTokens ?? null;
    usage.outputTokens = counts.outputTokens ?? null;
    usage.cacheReadTokens = counts.cacheReadTokens ?? null;
    usage.cacheWriteTokens = counts.cacheWriteTokens ?? null;
    const total =
      (usage.inputTokens ?? 0) +
      (usage.outputTokens ?? 0) +
      (usage.cacheReadTokens ?? 0) +
      (usage.cacheWriteTokens ?? 0);
    usage.totalTokens = total > 0 ? total : null;
  }

  usage.costUsd =
    withCost.length > 0 ? maxNumberByKey(withCost[withCost.length - 1], COST_KEYS) : null;
  usage.credits =
    withCredits.length > 0
      ? maxNumberByKey(withCredits[withCredits.length - 1], CREDIT_KEYS)
      : null;
  usage.source =
    usage.totalTokens !== null || usage.costUsd !== null || usage.credits !== null
      ? "stream"
      : "none";
  return usage;
}

/** Soma dois snapshots. Usado quando um run tem varios turnos de reparo. */
export function addUsage(a: UsageSnapshot, b: UsageSnapshot): UsageSnapshot {
  const add = (x: number | null, y: number | null): number | null =>
    x === null && y === null ? null : (x ?? 0) + (y ?? 0);
  return {
    inputTokens: add(a.inputTokens, b.inputTokens),
    outputTokens: add(a.outputTokens, b.outputTokens),
    cacheReadTokens: add(a.cacheReadTokens, b.cacheReadTokens),
    cacheWriteTokens: add(a.cacheWriteTokens, b.cacheWriteTokens),
    totalTokens: add(a.totalTokens, b.totalTokens),
    costUsd: add(a.costUsd, b.costUsd),
    credits: add(a.credits, b.credits),
    samples: a.samples + b.samples,
    basis: a.basis === "nenhum" ? b.basis : a.basis,
    source: a.source === "stream" || b.source === "stream" ? "stream" : "none",
  };
}

/** Resolve o adapter aceitando o alias legado `kiro`. */
export function resolveAgentConfig(cfg: {
  agent?: AgentConfig;
  kiro?: AgentConfig;
}): AgentConfig {
  return { ...DEFAULT_AGENT, ...(cfg.kiro ?? {}), ...(cfg.agent ?? {}) };
}
