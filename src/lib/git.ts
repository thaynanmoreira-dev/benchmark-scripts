import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";

import { matchesAny, isTestFile } from "./glob.ts";

const exec = promisify(execFile);

/**
 * An addressable git repository: bare (a mirror) or with a working tree.
 * The whole harness talks to git through this type, never through an implicit cwd.
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

/** Non-throwing variant. Useful when "it failed" is a valid answer. */
export async function gitTry(repo: GitRepo, args: string[]): Promise<string | null> {
  try {
    return await git(repo, args);
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────── commits and refs

export async function commitExists(repo: GitRepo, sha: string): Promise<boolean> {
  return (await gitTry(repo, ["cat-file", "-e", `${sha}^{commit}`])) !== null;
}

/**
 * Ensures the commit is in the object store. Tries the sha directly, then the
 * refs the provider suggested (a fork PR has no sha reachable from any branch).
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

/** Resolves the remote's default branch, falling back to main/master. */
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

/** A file's contents at a commit. null when the path does not exist there. */
export async function showFile(
  repo: GitRepo,
  sha: string,
  filePath: string,
): Promise<string | null> {
  return await gitTry(repo, ["show", `${sha}:${filePath}`]);
}

// ─────────────────────────────────────────────────────── mirrors and worktrees

/** Clones (or updates) a bare mirror. Run worktrees come from here. */
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

/** A detached worktree at a commit. Removes any previous worktree at that path. */
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

/** Normalises a numstat rename: "old => new" and "src/{a => b}/f.ts". */
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
 * Files changed in the working tree, untracked ones included.
 * This is the scope measurement: what the agent actually touched.
 */
export async function touchedFiles(repo: GitRepo): Promise<string[]> {
  const out = await git(repo, ["status", "--porcelain=v1", "--untracked-files=all"]);
  const files = new Set<string>();
  for (const line of out.split("\n")) {
    if (!line.trim()) continue;
    const payload = line.slice(3);
    // a rename shows up as "old -> new"; the destination is what matters
    const parts = payload.split(" -> ");
    const raw = (parts[parts.length - 1] ?? "").trim();
    const unquoted = raw.startsWith('"') && raw.endsWith('"') ? raw.slice(1, -1) : raw;
    if (unquoted) files.add(unquoted);
  }
  return [...files].sort();
}

/** Restores paths from a commit. Used to plant the grader. */
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
