import { readFile, writeFile, mkdir, rm, appendFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";

export async function readJson<T>(p: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(p, "utf8")) as T;
  } catch {
    return null;
  }
}

export async function writeJson(p: string, data: unknown): Promise<void> {
  await mkdir(path.dirname(p), { recursive: true });
  await writeFile(p, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

export async function writeText(p: string, data: string): Promise<void> {
  await mkdir(path.dirname(p), { recursive: true });
  await writeFile(p, data, "utf8");
}

export async function appendLine(p: string, line: string): Promise<void> {
  await mkdir(path.dirname(p), { recursive: true });
  await appendFile(p, `${line}\n`, "utf8");
}

/** Le um .jsonl ignorando linha corrompida. O arquivo e append-only. */
export async function readJsonl<T>(p: string): Promise<T[]> {
  if (!existsSync(p)) return [];
  const raw = await readFile(p, "utf8");
  const out: T[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as T);
    } catch {
      /* linha truncada por kill no meio do append */
    }
  }
  return out;
}

export async function firstExisting(dir: string, names: string[]): Promise<string | null> {
  for (const n of names) if (existsSync(path.join(dir, n))) return n;
  return null;
}

export function hash(s: string): string {
  return createHash("sha256").update(s).digest("hex").slice(0, 12);
}

export async function removePath(p: string): Promise<void> {
  await rm(p, { recursive: true, force: true });
}

/** Escreve garantindo o diretorio-pai. Usado no overlay dos arms. */
export async function materialize(
  root: string,
  files: Record<string, string>,
): Promise<string[]> {
  const written: string[] = [];
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, content, "utf8");
    written.push(rel);
  }
  return written;
}

export { existsSync };
