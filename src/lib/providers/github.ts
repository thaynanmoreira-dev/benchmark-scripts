import type { PullRequestRef } from "../types.ts";
import type { PrProvider } from "./base.ts";
import { fetchJson, shortBranch } from "./base.ts";

interface RawPr {
  number: number;
  title: string;
  body: string | null;
  draft?: boolean;
  merged_at: string | null;
  closed_at: string | null;
  merge_commit_sha: string | null;
  html_url: string;
  base: { ref: string; sha: string };
  head: { ref: string; sha: string };
}

function apiBase(): string {
  return process.env.GITHUB_API_URL ?? "https://api.github.com";
}

function headers(): Record<string, string> {
  const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  return {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "kiro-config-benchmark",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

export const github: PrProvider = {
  name: "github",

  remoteUrl(ctx) {
    if (!ctx.org) return null;
    return `https://github.com/${ctx.org}/${ctx.repoName}.git`;
  },

  missingRequirements(ctx) {
    return ctx.org ? [] : ['campo "org" na config (o owner do repo no GitHub)'];
  },

  async listMergedPrs(ctx, opts): Promise<PullRequestRef[]> {
    const out: PullRequestRef[] = [];
    const perPage = 100;
    const base = shortBranch(opts.targetBranch);

    for (let page = 1; out.length < opts.max; page++) {
      const url =
        `${apiBase()}/repos/${ctx.org}/${ctx.repoName}/pulls` +
        `?state=closed&base=${encodeURIComponent(base)}&sort=updated&direction=desc` +
        `&per_page=${perPage}&page=${page}`;

      const batch = await fetchJson<RawPr[]>(url, headers());
      if (batch.length === 0) break;

      for (const pr of batch) {
        if (!pr.merged_at) continue;
        if (opts.since && pr.merged_at < opts.since) continue;
        out.push({
          id: pr.number,
          title: pr.title,
          description: (pr.body ?? "").trim(),
          targetBranch: pr.base.ref,
          headCommit: pr.head.sha,
          targetCommit: pr.base.sha,
          mergeCommit: pr.merge_commit_sha,
          closedDate: pr.merged_at,
          isDraft: pr.draft === true,
          url: pr.html_url,
          // fork PR: the head sha is only reachable through this ref
          fetchRefs: [`refs/pull/${pr.number}/head`],
        });
        if (out.length >= opts.max) break;
      }
      if (batch.length < perPage) break;
    }
    return out;
  },
};
