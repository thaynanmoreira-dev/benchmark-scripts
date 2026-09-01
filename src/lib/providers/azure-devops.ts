import type { PullRequestRef } from "../types.ts";
import type { PrProvider } from "./base.ts";
import { fetchJson, fullRef } from "./base.ts";

interface RawPr {
  pullRequestId: number;
  title: string;
  description?: string;
  sourceRefName: string;
  targetRefName: string;
  closedDate?: string;
  isDraft?: boolean;
  status?: string;
  lastMergeSourceCommit?: { commitId: string };
  lastMergeTargetCommit?: { commitId: string };
  lastMergeCommit?: { commitId: string };
}

function authHeader(): Record<string, string> {
  const pat = process.env.AZDO_PAT ?? process.env.AZURE_DEVOPS_PAT;
  if (!pat) throw new Error("AZDO_PAT is not set.");
  return { Authorization: `Basic ${Buffer.from(`:${pat}`).toString("base64")}` };
}

export const azureDevOps: PrProvider = {
  name: "azure-devops",

  remoteUrl(ctx) {
    if (!ctx.org || !ctx.project) return null;
    return `https://dev.azure.com/${encodeURIComponent(ctx.org)}/${encodeURIComponent(
      ctx.project,
    )}/_git/${encodeURIComponent(ctx.repoName)}`;
  },

  missingRequirements(ctx) {
    const missing: string[] = [];
    if (!process.env.AZDO_PAT && !process.env.AZURE_DEVOPS_PAT) {
      missing.push("AZDO_PAT variable (personal access token with Code: Read scope)");
    }
    if (!ctx.org) missing.push('"org" field in the config');
    if (!ctx.project) missing.push('"project" field in the config');
    return missing;
  },

  async listMergedPrs(ctx, opts): Promise<PullRequestRef[]> {
    const headers = authHeader();
    const out: PullRequestRef[] = [];
    const pageSize = 100;

    for (let skip = 0; skip < opts.max; skip += pageSize) {
      const top = Math.min(pageSize, opts.max - skip);
      const url =
        `https://dev.azure.com/${encodeURIComponent(ctx.org ?? "")}/` +
        `${encodeURIComponent(ctx.project ?? "")}` +
        `/_apis/git/repositories/${encodeURIComponent(ctx.repoName)}/pullrequests` +
        `?searchCriteria.status=completed` +
        `&searchCriteria.targetRefName=${encodeURIComponent(fullRef(opts.targetBranch))}` +
        `&$top=${top}&$skip=${skip}&api-version=7.1`;

      const body = await fetchJson<{ value: RawPr[] }>(url, headers);
      for (const pr of body.value) {
        const head = pr.lastMergeSourceCommit?.commitId;
        const target = pr.lastMergeTargetCommit?.commitId;
        if (!head || !target) continue;
        out.push({
          id: pr.pullRequestId,
          title: pr.title,
          description: (pr.description ?? "").trim(),
          targetBranch: pr.targetRefName,
          headCommit: head,
          targetCommit: target,
          mergeCommit: pr.lastMergeCommit?.commitId ?? null,
          closedDate: pr.closedDate ?? null,
          isDraft: pr.isDraft === true,
          url:
            `https://dev.azure.com/${ctx.org}/${encodeURIComponent(ctx.project ?? "")}` +
            `/_git/${ctx.repoName}/pullrequest/${pr.pullRequestId}`,
          fetchRefs: [`refs/pull/${pr.pullRequestId}/merge`],
        });
      }
      if (body.value.length < top) break;
    }
    return out;
  },
};
