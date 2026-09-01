import type { Arm, ArmOverlay, ProjectProfile } from "./types.ts";

/**
 * Incremental ablation, not factorial: each arm adds exactly one thing on top
 * of the previous one. Six arms instead of the sixteen combinations of a full
 * factorial, and every delta is attributable to a single change.
 *
 * Arms are generated per repository, from that repository's profile. Steering
 * written for the wrong architecture is worse than no steering at all.
 */

function fence(cmd: string | null, fallback: string): string {
  return `\`${cmd ?? fallback}\``;
}

export function steeringTech(p: ProjectProfile): string {
  const c = p.probe.commands;
  const stack = p.probe.framework.join(", ") || (p.probe.ecosystem === "node" ? "Node" : p.probe.ecosystem);
  return `---
inclusion: always
---
# Stack and non-negotiable rules

- ${stack}${p.probe.runtime.typescript ? " + TypeScript" : ""}.
- Test runner: ${p.probe.testRunner ?? "not detected"}. Test file convention: ${p.semantic.testFileConvention}.
- Package manager: ${p.probe.packageManager}. Do not switch managers or touch the lockfile without being asked.
- NEVER use \`any\`. NEVER leave a Promise unawaited.
- Before saying the task is done, run these and leave them green:
  ${fence(c.lint, "npx eslint .")} and ${fence(c.test, "npm test")}.
- Do not create a file, endpoint, dependency or abstraction outside the scope you
  were given. When in doubt about scope, ask instead of assuming.
`;
}

export function steeringStructure(p: ProjectProfile): string {
  const layers = p.semantic.layers ?? [];
  const body = layers.length
    ? layers
        .map(
          (l) =>
            `- **${l.name}** (\`${l.globs.join("`, `")}\`) may import: ${
              l.mayImport.length ? l.mayImport.join(", ") : "nada"
            }`,
        )
        .join("\n")
    : "- (layers not detected — review .bench/projects/*.json and fill them in by hand)";

  const invariants =
    (p.semantic.criticalInvariants ?? []).map((i) => `- ${i}`).join("\n") ||
    "- (none recorded)";

  return `---
inclusion: fileMatch
fileMatchPattern: 'src/**/*.ts'
---
# Architecture

${p.semantic.architectureStyle || "(not determined)"}

${p.semantic.domainSummary ? `${p.semantic.domainSummary}\n` : ""}
## Dependency direction between layers

${body}

## Critical invariants

${invariants}
`;
}

export function steeringGates(p: ProjectProfile): string {
  const c = p.probe.commands;
  const cmds = [
    c.lint ? `- lint: \`${c.lint}\`` : null,
    c.typecheck ? `- typecheck: \`${c.typecheck}\`` : null,
    c.arch ? `- arquitetura: \`${c.arch}\`` : null,
    c.test ? `- tests: \`${c.test}\`` : null,
  ]
    .filter(Boolean)
    .join("\n");

  return `---
inclusion: always
---
# Mandatory gates

Run these commands before declaring the task done. If one fails, fix it and run
again. Do not declare completion with a red gate, and do not switch a lint rule
off to get through.

${cmds}

If a gate fails for a reason unrelated to your change, say so explicitly instead
of working around it.
`;
}

export function steeringGrill(p: ProjectProfile): string {
  const nonGoals =
    (p.semantic.suggestedNonGoals ?? []).map((g) => `- ${g}`).join("\n") ||
    "- (fill in with what the agent tends to invent in this repository)";

  return `---
inclusion: always
---
# Negative scope

Before writing any code, state each of these in one line:
1. what the task asks for, in your own words;
2. the NON-GOALS of this task;
3. the design decision you are about to make, with your recommendation first.

Only then write code. If any point is ambiguous, pick the narrowest possible
reading and record the assumption — do not widen the scope to cover the doubt.

## Recurring non-goals in this repository

${nonGoals}
- Do not add a feature, flag, endpoint or setting the task did not ask for.
- Do not refactor neighbouring code the task did not mention.
- Do not add a new dependency unless the task requires it.
`;
}

export function mcpQmd(): string {
  return `${JSON.stringify(
    {
      mcpServers: {
        qmd: {
          command: "qmd",
          args: ["mcp"],
          disabled: false,
          autoApprove: ["query", "get", "multi_get", "status"],
        },
      },
    },
    null,
    2,
  )}\n`;
}

/**
 * Paths deleted from the worktree before any overlay.
 *
 * Without this, a repository that already commits `.kiro/` has no clean
 * baseline: A0 would inherit the current configuration and the experiment would
 * measure something else entirely.
 */
export function stripPaths(p: ProjectProfile, stripExisting: boolean): string[] {
  if (!stripExisting) return [];
  const k = p.probe.existingKiro;
  const paths: string[] = [];
  if (k.steering.length || k.hooks.length || k.mcp) paths.push(".kiro");
  if (k.agentsMd) paths.push("AGENTS.md");
  return paths;
}

export function buildArms(p: ProjectProfile, stripExisting = true): Arm[] {
  const remove = stripPaths(p, stripExisting);
  const tech = steeringTech(p);
  const structure = steeringStructure(p);
  const gates = steeringGates(p);
  const grill = steeringGrill(p);

  const overlay = (files: Record<string, string>, enforceGates = false): ArmOverlay => ({
    files,
    remove,
    extraArgs: [],
    enforceGates,
  });

  const steeringBase = {
    ".kiro/steering/tech.md": tech,
    ".kiro/steering/structure.md": structure,
  };

  return [
    {
      id: "A0",
      repo: p.repo,
      label: "bare agent, vibe",
      hypothesis: "Baseline. Reproduces the team's current pain.",
      mode: "vibe",
      overlay: overlay({}),
    },
    {
      id: "A1",
      repo: p.repo,
      label: "bare agent, spec",
      hypothesis: "Spec mode alone already reduces half-finished tasks.",
      mode: "spec",
      overlay: overlay({}),
    },
    {
      id: "A2",
      repo: p.repo,
      label: "spec + minimal steering",
      hypothesis: "Persistent rules cut rework.",
      mode: "spec",
      overlay: overlay({ ...steeringBase }),
    },
    {
      id: "A3",
      repo: p.repo,
      label: "A2 + deterministic gates",
      hypothesis: "Forcing lint/typecheck/arch into the loop cuts the largest slice of credit.",
      mode: "spec",
      overlay: overlay({ ...steeringBase, ".kiro/steering/gates.md": gates }, true),
    },
    {
      id: "A4",
      repo: p.repo,
      label: "A3 + qmd MCP",
      hypothesis: "Local retrieval replaces reading whole files.",
      mode: "spec",
      overlay: overlay(
        {
          ...steeringBase,
          ".kiro/steering/gates.md": gates,
          ".kiro/settings/mcp.json": mcpQmd(),
        },
        true,
      ),
    },
    {
      id: "A5",
      repo: p.repo,
      label: "A4 + negative scope (/grill)",
      hypothesis: "Explicit non-goals eliminate unrequested features.",
      mode: "spec",
      overlay: overlay(
        {
          ...steeringBase,
          ".kiro/steering/gates.md": gates,
          ".kiro/steering/grill.md": grill,
          ".kiro/settings/mcp.json": mcpQmd(),
        },
        true,
      ),
    },
  ];
}
