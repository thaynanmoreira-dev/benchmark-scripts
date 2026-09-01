import type { GitRepo } from "../git.ts";
import type { ListPrsOptions, ProviderName, PullRequestRef } from "../types.ts";

export interface ProviderContext {
  repoName: string;
  /** Mirror bare do repo. Providers locais leem daqui. */
  git: GitRepo;
  /** Azure DevOps: organizacao. GitHub: owner. */
  org?: string;
  /** Azure DevOps: projeto. */
  project?: string;
  /** URL de clone declarada na config, quando houver. */
  remoteUrl?: string;
}

export interface PrProvider {
  name: ProviderName;
  /** Deriva a URL de clone quando a config nao trouxe uma. */
  remoteUrl(ctx: ProviderContext): string | null;
  /** Requisitos de ambiente ausentes. Vazio = pronto para rodar. */
  missingRequirements(ctx: ProviderContext): string[];
  listMergedPrs(ctx: ProviderContext, opts: ListPrsOptions): Promise<PullRequestRef[]>;
}

/** Aceita `main` ou `refs/heads/main` e devolve o nome curto. */
export function shortBranch(ref: string): string {
  return ref.replace(/^refs\/heads\//, "");
}

/** Aceita `main` ou `refs/heads/main` e devolve a ref completa. */
export function fullRef(ref: string): string {
  return ref.startsWith("refs/") ? ref : `refs/heads/${ref}`;
}

export async function fetchJson<T>(url: string, headers: Record<string, string>): Promise<T> {
  const res = await fetch(url, { headers: { Accept: "application/json", ...headers } });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status} em ${url}\n${text.slice(0, 500)}`);
  }
  return (await res.json()) as T;
}
