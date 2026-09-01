import type { ProviderName, RepoSpec } from "../types.ts";
import type { PrProvider, ProviderContext } from "./base.ts";
import { azureDevOps } from "./azure-devops.ts";
import { github } from "./github.ts";
import { localGit } from "./local-git.ts";

const REGISTRY: Record<ProviderName, PrProvider> = {
  "azure-devops": azureDevOps,
  github,
  "local-git": localGit,
};

export function getProvider(name: ProviderName): PrProvider {
  const p = REGISTRY[name];
  if (!p) {
    throw new Error(
      `Provider desconhecido: ${name}. Use um de: ${Object.keys(REGISTRY).join(", ")}`,
    );
  }
  return p;
}

/**
 * Escolhe o provider quando a config nao declara um.
 * A ordem reflete o custo: o que ja tem clone local nao precisa de API.
 */
export function detectProvider(
  cfgProvider: ProviderName | undefined,
  repo: RepoSpec,
  org?: string,
  project?: string,
): ProviderName {
  if (repo.provider) return repo.provider;
  if (cfgProvider) return cfgProvider;

  const url = repo.remoteUrl ?? "";
  if (/dev\.azure\.com|visualstudio\.com/.test(url)) return "azure-devops";
  if (/github\.com/.test(url)) return "github";
  if (url) return "local-git";

  if (org && project) return "azure-devops";
  if (org) return "github";
  return "local-git";
}

export type { PrProvider, ProviderContext };
export { azureDevOps, github, localGit };
