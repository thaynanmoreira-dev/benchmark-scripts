import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";

import type { AgentConfig, UsageSnapshot } from "./types.ts";

/**
 * Adapter for the agent CLI. The harness assumes nothing about the output
 * format: it accepts plain text, stream-json, and a mixture of the two.
 * Calibrate with `node src/bench-init.ts --probe-agent` before spending quota.
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
  /** Where to write the raw output. Helps debugging a bad run. */
  logPath?: string;
}

export interface AgentResult {
  ok: boolean;
  /** Text extracted from the stream — what the agent "said". */
  text: string;
  /** Raw output, stdout + stderr, exactly as it came. */
  raw: string;
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  usage: UsageSnapshot;
  /** Spawn error (a missing binary, for instance). */
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
    basis: "none",
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
        /* a CLI that closes stdin early */
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

// ─────────────────────────────────────────────────── output parsing

/** Tolerant: accepts plain text or stream-json carrying text blocks. */
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

/** Extracts the first JSON object from the text, tolerating code fences. */
export function parseJsonLoose<T>(text: string): T | null {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1] : text;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  const direct = tryParse(candidate.slice(start, end + 1));
  if (direct) return direct as T;
  // extra closing brace after the object: shorten until it parses
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

// ─────────────────────────────────────────────────── cost

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

/** Counts this object declares directly, without looking at its children. */
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
 * Finds the single accounting node that represents this event.
 *
 * This is what prevents multiple counting. A real CLI repeats the same usage in
 * several places of the same object — Claude Code, for instance, publishes the
 * same tokens under `usage`, again under `usage.iterations[]`, and once more
 * under `modelUsage[model]` with camelCase keys. Summing everything multiplied
 * the usage by eight when tested against the real CLI.
 *
 * Rule: prefer the node under the `usage` key; failing that, the first node in
 * breadth-first order that declares tokens. Once found, stop descending —
 * whatever is nested below details the same usage, it is not extra usage.
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
      continue; // do not descend: children only detail this same usage
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
 * Scans the raw output for the CLI's usage accounting.
 *
 * Two stream shapes are supported, in this order of preference:
 *
 *   terminal  The CLI closes the invocation with a summary event that already
 *             carries the cumulative total (recognised by carrying a cost).
 *             That event is the truth: the earlier events are partials of the
 *             same total, and summing them all would count the same usage
 *             several times over.
 *   summed    There is no summary event. Each event contributes once, and the
 *             total is the sum.
 *
 * `basis` records which of the two applied, and `samples` how many events went
 * in, so the number can be checked by hand against the dashboard.
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

  const sumEvents = (): { counts: TokenCounts | null; samples: number } => {
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
  const summary = withCost.length > 0 ? withCost[withCost.length - 1] : null;
  const fromSummary = summary ? readUsageNode(summary) : null;

  if (fromSummary) {
    // the summary carries the whole invocation's total; the partials before it
    // are the same usage in detail, and summing would count it twice
    counts = fromSummary;
    usage.basis = "terminal";
    usage.samples = 1;
  } else {
    // some CLIs close with a cost but leave the tokens only in the message
    // events. There the cost comes from the summary and the tokens from the sum.
    const summed = sumEvents();
    counts = summed.counts;
    usage.basis = summed.samples > 0 ? "summed" : "none";
    usage.samples = summed.samples;
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

/** Adds two snapshots. Used when a run has several repair turns. */
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
    basis: a.basis === "none" ? b.basis : a.basis,
    source: a.source === "stream" || b.source === "stream" ? "stream" : "none",
  };
}

/** Resolves the adapter, accepting the legacy `kiro` alias. */
export function resolveAgentConfig(cfg: {
  agent?: AgentConfig;
  kiro?: AgentConfig;
}): AgentConfig {
  return { ...DEFAULT_AGENT, ...(cfg.kiro ?? {}), ...(cfg.agent ?? {}) };
}
