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
 * Instala dependencias no worktree reaproveitando um cache por hash de
 * lockfile. Com ~160 runs, instalar do zero em cada um domina o wall-clock
 * e nao muda nada no que esta sendo medido.
 *
 * symlink  node_modules do cache e ligado no worktree (rapido, default)
 * copy     copia o cache (mais lento, sobrevive a ferramenta que odeia symlink)
 * fresh    instala do zero em todo run (so para diagnosticar)
 * none     nao instala nada
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
    return done(false, false, `${installCmd} falhou (exit ${res.exitCode}): ${res.output.slice(-400)}`);
  }

  // primeira instalacao alimenta o cache para os proximos runs
  if (strategy !== "fresh" && cacheDir && existsSync(target)) {
    try {
      await mkdir(path.dirname(cacheDir), { recursive: true });
      await rename(target, cacheDir);
      await symlink(cacheDir, target, "dir");
      return done(true, false, `instalado e cacheado em ${cacheDir}`);
    } catch {
      // rename entre dispositivos diferentes: segue sem cache
      return done(true, false, `instalado (cache indisponivel)`);
    }
  }

  return done(true, false, "instalado");
}
