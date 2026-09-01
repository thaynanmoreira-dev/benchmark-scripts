import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";

import { matchesAny, isTestFile } from "./glob.ts";

const exec = promisify(execFile);

/**
 * Um repositorio git endereçavel. Bare (mirror) ou com working tree.
 * Todo o harness fala com git atraves deste tipo, nunca com cwd implicito.
 */
export interface GitRepo {
  dir: string;
  bare: boolean;
}

export function bareRepo(dir: string): GitRepo {
  return { dir, bare: true };
}

export function workRepo(dir: string): GitRepo {
  return { dir, bare: false };
}

function prefix(repo: GitRepo): string[] {
  return repo.bare ? ["--git-dir", repo.dir] : ["-C", repo.dir];
}

export async function git(repo: GitRepo, args: string[]): Promise<string> {
  const { stdout } = await exec("git", [...prefix(repo), ...args], {
    maxBuffer: 256 * 1024 * 1024,
  });
  return stdout;
}

/** Variante que nao lanca. Util quando "falhou" e uma resposta valida. */
export async function gitTry(repo: GitRepo, args: string[]): Promise<string | null> {
  try {
    return await git(repo, args);
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────── commits e refs

export async function commitExists(repo: GitRepo, sha: string): Promise<boolean> {
  return (await gitTry(repo, ["cat-file", "-e", `${sha}^{commit}`])) !== null;
}

/**
 * Garante o commit no object store. Tenta o sha direto e depois as refs que o
 * provider sugeriu (PR de fork nao tem o sha alcancavel por nenhum branch).
 */
export async function ensureCommit(
  repo: GitRepo,
  sha: string,
  fetchRefs: string[] = [],
): Promise<boolean> {
  if (await commitExists(repo, sha)) return true;
  if ((await gitTry(repo, ["fetch", "--quiet", "origin", sha])) !== null) {
    if (await commitExists(repo, sha)) return true;
  }
  for (const ref of fetchRefs) {
    await gitTry(repo, ["fetch", "--quiet", "origin", `${ref}:${ref}`]);
    if (await commitExists(repo, sha)) return true;
  }
  return false;
}

export async function mergeBase(repo: GitRepo, a: string, b: string): Promise<string | null> {
  const out = await gitTry(repo, ["merge-base", a, b]);
  return out?.trim() || null;
}

export async function revParse(repo: GitRepo, ref: string): Promise<string | null> {
  const out = await gitTry(repo, ["rev-parse", ref]);
  return out?.trim() || null;
}

/** Resolve o branch default do remoto, caindo para main/master. */
export async function resolveDefaultBranch(repo: GitRepo, hint?: string): Promise<string> {
  const candidates = [hint, "origin/HEAD", "main", "master", "origin/main", "origin/master"];
  for (const c of candidates) {
    if (!c) continue;
    const sha = await revParse(repo, c);
    if (sha) return c === "origin/HEAD" ? (await symbolicDefault(repo)) ?? "main" : c;
  }
  return hint ?? "main";
}

async function symbolicDefault(repo: GitRepo): Promise<string | null> {
  const out = await gitTry(repo, ["symbolic-ref", "--short", "origin/HEAD"]);
  return out?.trim().replace(/^origin\//, "") || null;
}

/** Conteudo de um arquivo num commit. null se o path nao existe la. */
export async function showFile(
  repo: GitRepo,
  sha: string,
  filePath: string,
): Promise<string | null> {
  return await gitTry(repo, ["show", `${sha}:${filePath}`]);
}

// ─────────────────────────────────────────────────────── mirrors e worktrees

/** Clona (ou atualiza) um mirror bare. Worktrees de run saem daqui. */
export async function ensureMirror(
  mirrorDir: string,
  remoteUrl: string,
  refresh = true,
): Promise<GitRepo> {
  const repo = bareRepo(mirrorDir);
  if (existsSync(mirrorDir)) {
    if (refresh) await gitTry(repo, ["remote", "update", "--prune"]);
    return repo;
  }
  await mkdir(path.dirname(mirrorDir), { recursive: true });
  await exec("git", ["clone", "--mirror", remoteUrl, mirrorDir], {
    maxBuffer: 64 * 1024 * 1024,
  });
  return repo;
}

/** Worktree detached num commit. Remove um worktree anterior no mesmo path. */
export async function addWorktree(
  mirror: GitRepo,
  target: string,
  ref: string,
): Promise<GitRepo> {
  await removeWorktree(mirror, target);
  await mkdir(path.dirname(target), { recursive: true });
  await git(mirror, ["worktree", "add", "--detach", "--force", target, ref]);
  return workRepo(target);
}

export async function removeWorktree(mirror: GitRepo, target: string): Promise<void> {
  await gitTry(mirror, ["worktree", "remove", "--force", target]);
  await gitTry(mirror, ["worktree", "prune"]);
  await rm(target, { recursive: true, force: true });
}

// ─────────────────────────────────────────────────────── diff

export interface FileStat {
  path: string;
  additions: number;
  deletions: number;
  binary: boolean;
  isTest: boolean;
  excluded: boolean;
}

/** Normaliza rename do numstat: "old => new" e "src/{a => b}/f.ts". */
export function normalizeRenamePath(raw: string): string {
  if (!raw.includes("=>")) return raw;
  const braced = raw.replace(/\{[^}]*=>\s*([^}]*)\}/g, "$1").replace(/\/\//g, "/");
  if (!braced.includes("=>")) return braced;
  const parts = braced.split("=>");
  return parts[parts.length - 1].trim();
}

export function parseNumstat(out: string, excludePatterns: RegExp[]): FileStat[] {
  const stats: FileStat[] = [];
  for (const line of out.split("\n")) {
    if (!line.trim()) continue;
    const [addRaw, delRaw, ...rest] = line.split("\t");
    const filePath = normalizeRenamePath(rest.join("\t").trim());
    if (!filePath) continue;
    const binary = addRaw === "-" || delRaw === "-";
    stats.push({
      path: filePath,
      additions: binary ? 0 : Number(addRaw) || 0,
      deletions: binary ? 0 : Number(delRaw) || 0,
      binary,
      isTest: isTestFile(filePath),
      excluded: matchesAny(filePath, excludePatterns),
    });
  }
  return stats;
}

export async function numstat(
  repo: GitRepo,
  base: string,
  head: string,
  excludePatterns: RegExp[],
): Promise<FileStat[]> {
  const out = await git(repo, ["diff", "--numstat", "-M", `${base}..${head}`]);
  return parseNumstat(out, excludePatterns);
}

/**
 * Arquivos alterados no working tree, incluindo untracked.
 * Esta e a medida de escopo: o que o agente tocou de fato.
 */
export async function touchedFiles(repo: GitRepo): Promise<string[]> {
  const out = await git(repo, ["status", "--porcelain=v1", "--untracked-files=all"]);
  const files = new Set<string>();
  for (const line of out.split("\n")) {
    if (!line.trim()) continue;
    const payload = line.slice(3);
    // rename aparece como "old -> new"; o que importa e o destino
    const parts = payload.split(" -> ");
    const raw = (parts[parts.length - 1] ?? "").trim();
    const unquoted = raw.startsWith('"') && raw.endsWith('"') ? raw.slice(1, -1) : raw;
    if (unquoted) files.add(unquoted);
  }
  return [...files].sort();
}

/** Restaura paths a partir de um commit. Usado para plantar o grader. */
export async function checkoutPaths(
  repo: GitRepo,
  sha: string,
  paths: string[],
): Promise<string[]> {
  const restored: string[] = [];
  for (const p of paths) {
    if ((await gitTry(repo, ["checkout", sha, "--", p])) !== null) restored.push(p);
  }
  return restored;
}

export async function hardReset(repo: GitRepo, sha: string): Promise<void> {
  await gitTry(repo, ["reset", "--hard", sha]);
  await gitTry(repo, ["clean", "-fd"]);
}
