import { gitTry } from "../git.ts";
import type { ListPrsOptions, PullRequestRef } from "../types.ts";
import type { PrProvider, ProviderContext } from "./base.ts";
import { shortBranch } from "./base.ts";

/**
 * Provider sem API: reconstroi o corpus a partir do proprio historico git.
 * E o que torna o harness aplicavel a qualquer repositorio, inclusive um
 * clone offline sem token nenhum.
 *
 * Dois modos:
 *   merges  - cada merge commit e um PR. head = 2o pai, base = 1o pai.
 *   commits - cada commit de primeira linhagem e uma tarefa. Para repos
 *             que usam squash merge e portanto nao tem merge commit.
 *
 * O modo e escolhido sozinho por proporcao, nao por contagem absoluta: um
 * repositorio novo com 3 merges em 4 commits e claramente um repositorio de
 * merge commit, e um limiar fixo de "pelo menos 5 merges" o classificaria
 * errado. Da para forcar com PR_MODE=merges|commits.
 */

const UNIT = String.fromCharCode(31); // separador de campo
const RECORD = String.fromCharCode(30); // separador de registro
const FORMAT = ["%H", "%P", "%cI", "%s", "%b"].join(`%x1f`) + `%x1e`;

interface RawCommit {
  sha: string;
  parents: string[];
  date: string;
  subject: string;
  body: string;
}

function parseLog(out: string): RawCommit[] {
  const commits: RawCommit[] = [];
  for (const record of out.split(RECORD)) {
    const trimmed = record.replace(/^\n+/, "");
    if (!trimmed.trim()) continue;
    const [sha, parents, date, subject, body] = trimmed.split(UNIT);
    if (!sha) continue;
    commits.push({
      sha: sha.trim(),
      parents: (parents ?? "").trim().split(/\s+/).filter(Boolean),
      date: (date ?? "").trim(),
      subject: (subject ?? "").trim(),
      body: (body ?? "").trim(),
    });
  }
  return commits;
}

/** Extrai numero e titulo de subjects de merge conhecidos. */
export function parseMergeSubject(
  subject: string,
  body: string,
): { id: number | null; title: string; description: string } {
  // Azure DevOps: "Merged PR 1234: Titulo real"
  const azdo = subject.match(/^Merged PR (\d+):\s*(.*)$/i);
  if (azdo) {
    return { id: Number(azdo[1]), title: azdo[2].trim() || subject, description: body };
  }
  // GitHub: "Merge pull request #123 from org/branch" — titulo vai no body
  const gh = subject.match(/^Merge pull request #(\d+) from \S+/i);
  if (gh) {
    const lines = body.split("\n");
    const title = (lines[0] ?? "").trim() || subject;
    return { id: Number(gh[1]), title, description: lines.slice(1).join("\n").trim() };
  }
  // GitLab: "Merge branch 'x' into 'main'" / conventional squash "feat: x (#12)"
  const squash = subject.match(/\(#(\d+)\)\s*$/);
  if (squash) {
    return { id: Number(squash[1]), title: subject, description: body };
  }
  return { id: null, title: subject, description: body };
}

/** Id numerico estavel quando o provider nao tem numero de PR. */
function syntheticId(sha: string): number {
  return Number.parseInt(sha.slice(0, 6), 16);
}

async function logCommits(
  ctx: ProviderContext,
  branch: string,
  merges: boolean,
  max: number,
  since?: string,
): Promise<RawCommit[]> {
  const args = [
    "log",
    "--first-parent",
    merges ? "--merges" : "--no-merges",
    `--max-count=${max}`,
    `--format=${FORMAT}`,
  ];
  if (since) args.push(`--since=${since}`);
  args.push(branch);
  const out = await gitTry(ctx.git, args);
  return out ? parseLog(out) : [];
}

async function resolveBranch(ctx: ProviderContext, targetBranch: string): Promise<string> {
  const short = shortBranch(targetBranch);
  for (const candidate of [short, `origin/${short}`, "HEAD"]) {
    if ((await gitTry(ctx.git, ["rev-parse", "--verify", `${candidate}^{commit}`])) !== null) {
      return candidate;
    }
  }
  return short;
}

/**
 * Merge commit ou squash merge? Decide pela proporcao de merges na primeira
 * linhagem, com uma amostra pequena e barata.
 */
async function detectMode(
  ctx: ProviderContext,
  branch: string,
  since?: string,
): Promise<"merges" | "commits"> {
  const AMOSTRA = 60;
  const merges = await logCommits(ctx, branch, true, AMOSTRA, since);
  if (merges.length === 0) return "commits";

  const diretos = await logCommits(ctx, branch, false, AMOSTRA, since);
  const total = merges.length + diretos.length;
  if (total === 0) return "commits";

  // um quarto da primeira linhagem sendo merge ja caracteriza o fluxo de PR
  return merges.length / total >= 0.25 ? "merges" : "commits";
}

export const localGit: PrProvider = {
  name: "local-git",

  remoteUrl(ctx) {
    return ctx.remoteUrl ?? null;
  },

  missingRequirements() {
    return [];
  },

  async listMergedPrs(ctx, opts: ListPrsOptions): Promise<PullRequestRef[]> {
    const branch = await resolveBranch(ctx, opts.targetBranch);
    const forced = process.env.PR_MODE;

    let mode: "merges" | "commits";
    if (forced === "merges" || forced === "commits") {
      mode = forced;
    } else {
      mode = await detectMode(ctx, branch, opts.since);
    }

    const commits = await logCommits(ctx, branch, mode === "merges", opts.max, opts.since);
    const out: PullRequestRef[] = [];

    for (const c of commits) {
      // merges: base = primeiro pai (lado do alvo), head = segundo pai
      // commits: base = pai unico, head = o proprio commit
      const target = mode === "merges" ? c.parents[0] : c.parents[0];
      const head = mode === "merges" ? c.parents[1] : c.sha;
      if (!target || !head) continue;

      const parsed = parseMergeSubject(c.subject, c.body);
      out.push({
        id: parsed.id ?? syntheticId(c.sha),
        title: parsed.title,
        description: parsed.description,
        targetBranch: shortBranch(opts.targetBranch),
        headCommit: head,
        targetCommit: target,
        mergeCommit: mode === "merges" ? c.sha : null,
        closedDate: c.date || null,
        isDraft: false,
        url: `local:${c.sha.slice(0, 12)}`,
        fetchRefs: [],
      });
    }
    return out;
  },
};

export { parseLog as parseLogForTests };
