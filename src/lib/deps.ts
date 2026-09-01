import { cp, mkdir, rename, symlink } from "node:fs/promises";
import path from "node:path";

import { existsSync, removePath } from "./fsx.ts";
import { runCommand, type CommandResult } from "./shell.ts";

export type InstallStrategy = "symlink" | "copy" | "fresh" | "none";

export interface InstallOutcome {
  strategy: InstallStrategy;
  cacheHit: boolean;
  ok: boolean;
  durationMs: number;
  detail: string;
}

/**
 * Installs dependencies into the worktree, reusing a cache keyed by lockfile
 * hash. Across ~160 runs, installing from scratch each time dominates the wall
 * clock and changes nothing about what is being measured.
 *
 * symlink  the cache's node_modules is linked into the worktree (fast, default)
 * copy     copies the cache (slower, survives tools that hate symlinks)
 * fresh    installs from scratch on every run (diagnostics only)
 * none     installs nothing
 */
export async function installDeps(
  worktree: string,
  cacheRoot: string,
  lockfileHash: string | null,
  installCmd: string | null,
  strategy: InstallStrategy,
  timeoutMs: number,
): Promise<InstallOutcome> {
  const startedAt = Date.now();
  const done = (ok: boolean, cacheHit: boolean, detail: string): InstallOutcome => ({
    strategy,
    cacheHit,
    ok,
    durationMs: Date.now() - startedAt,
    detail,
  });

  if (strategy === "none" || !installCmd) {
    return done(true, false, "instalacao desligada");
  }

  const target = path.join(worktree, "node_modules");
  const cacheDir = lockfileHash ? path.join(cacheRoot, lockfileHash, "node_modules") : null;

  if (strategy !== "fresh" && cacheDir && existsSync(cacheDir)) {
    await removePath(target);
    if (strategy === "symlink") {
      await symlink(cacheDir, target, "dir");
      return done(true, true, `symlink -> ${cacheDir}`);
    }
    await cp(cacheDir, target, { recursive: true, dereference: false });
    return done(true, true, `copia de ${cacheDir}`);
  }

  const res: CommandResult = await runCommand(installCmd, { cwd: worktree, timeoutMs });
  if (!res.ok) {
    return done(false, false, `${installCmd} failed (exit ${res.exitCode}): ${res.output.slice(-400)}`);
  }

  // the first install seeds the cache for the runs that follow
  if (strategy !== "fresh" && cacheDir && existsSync(target)) {
    try {
      await mkdir(path.dirname(cacheDir), { recursive: true });
      await rename(target, cacheDir);
      await symlink(cacheDir, target, "dir");
      return done(true, false, `instalado e cacheado em ${cacheDir}`);
    } catch {
      // rename across devices: carry on without the cache
      return done(true, false, `instalado (cache indisponivel)`);
    }
  }

  return done(true, false, "instalado");
}
