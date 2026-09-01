import type { GitRepo } from "../git.ts";
import type { ListPrsOptions, ProviderName, PullRequestRef } from "../types.ts";

export interface ProviderContext {
  repoName: string;
  /** The repo's bare mirror. Local providers read from here. */
  git: GitRepo;
  /** Azure DevOps: the organisation. GitHub: the owner. */
  org?: string;
  /** Azure DevOps: the project. */
  project?: string;
  /** Clone URL declared in the config, when there is one. */
  remoteUrl?: string;
}

export interface PrProvider {
  name: ProviderName;
  /** Derives the clone URL when the config did not provide one. */
  remoteUrl(ctx: ProviderContext): string | null;
  /** Missing environment requirements. Empty means ready to run. */
  missingRequirements(ctx: ProviderContext): string[];
  listMergedPrs(ctx: ProviderContext, opts: ListPrsOptions): Promise<PullRequestRef[]>;
}

/** Accepts `main` or `refs/heads/main` and returns the short name. */
export function shortBranch(ref: string): string {
  return ref.replace(/^refs\/heads\//, "");
}

/** Accepts `main` or `refs/heads/main` and returns the full ref. */
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
