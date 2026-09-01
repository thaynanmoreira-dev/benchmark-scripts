import type { Arm, ArmOverlay, ProjectProfile } from "./types.ts";

/**
 * Ablacao incremental, nao fatorial: cada arm adiciona exatamente uma coisa
 * ao anterior. Seis arms em vez das dezesseis combinacoes de um fatorial
 * completo, e cada delta e atribuivel a uma unica mudanca.
 *
 * Os arms sao gerados por repo, a partir do perfil daquele repo. Steering
 * escrito para a arquitetura errada e pior que steering nenhum.
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
# Stack e regras inegociaveis

- ${stack}${p.probe.runtime.typescript ? " + TypeScript" : ""}.
- Test runner: ${p.probe.testRunner ?? "nao detectado"}. Convencao de arquivo de teste: ${p.semantic.testFileConvention}.
- Gerenciador de pacotes: ${p.probe.packageManager}. Nao troque de gerenciador nem mexa no lockfile sem pedido explicito.
- NUNCA use \`any\`. NUNCA deixe Promise sem await.
- Antes de dizer que a task terminou, rode e deixe verde:
  ${fence(c.lint, "npx eslint .")} e ${fence(c.test, "npm test")}.
- Nao crie arquivo, endpoint, dependencia ou abstracao fora do escopo pedido.
  Em duvida sobre escopo, pergunte em vez de assumir.
`;
}

export function steeringStructure(p: ProjectProfile): string {
  const layers = p.semantic.layers ?? [];
  const body = layers.length
    ? layers
        .map(
          (l) =>
            `- **${l.name}** (\`${l.globs.join("`, `")}\`) pode importar: ${
              l.mayImport.length ? l.mayImport.join(", ") : "nada"
            }`,
        )
        .join("\n")
    : "- (camadas nao detectadas — revise .bench/projects/*.json e preencha a mao)";

  const invariants =
    (p.semantic.criticalInvariants ?? []).map((i) => `- ${i}`).join("\n") ||
    "- (nenhuma registrada)";

  return `---
inclusion: fileMatch
fileMatchPattern: 'src/**/*.ts'
---
# Arquitetura

${p.semantic.architectureStyle || "(nao determinada)"}

${p.semantic.domainSummary ? `${p.semantic.domainSummary}\n` : ""}
## Direcao de dependencia entre camadas

${body}

## Invariantes criticas

${invariants}
`;
}

export function steeringGates(p: ProjectProfile): string {
  const c = p.probe.commands;
  const cmds = [
    c.lint ? `- lint: \`${c.lint}\`` : null,
    c.typecheck ? `- typecheck: \`${c.typecheck}\`` : null,
    c.arch ? `- arquitetura: \`${c.arch}\`` : null,
    c.test ? `- testes: \`${c.test}\`` : null,
  ]
    .filter(Boolean)
    .join("\n");

  return `---
inclusion: always
---
# Gates obrigatorios

Rode estes comandos antes de declarar a task pronta. Falhou, conserte e rode de novo.
Nao declare conclusao com gate vermelho, e nao desative regra de lint para passar.

${cmds}

Se um gate falhar por motivo alheio a sua alteracao, diga isso explicitamente
em vez de contornar.
`;
}

export function steeringGrill(p: ProjectProfile): string {
  const nonGoals =
    (p.semantic.suggestedNonGoals ?? []).map((g) => `- ${g}`).join("\n") ||
    "- (preencher com o que o agente costuma inventar neste repo)";

  return `---
inclusion: always
---
# Escopo negativo

Antes de escrever codigo, liste em uma linha cada uma destas coisas:
1. o que a task pede, com suas palavras;
2. os NON-GOALS desta task;
3. a decisao de design que voce vai tomar, com sua recomendacao primeiro.

So depois escreva codigo. Se algum ponto ficou ambiguo, escolha a leitura mais
estreita possivel e registre a suposicao — nao amplie o escopo para cobrir a duvida.

## Non-goals recorrentes neste repositorio

${nonGoals}
- Nao adicione feature, flag, endpoint ou configuracao que a task nao pediu.
- Nao refatore codigo vizinho que a task nao mencionou.
- Nao adicione dependencia nova sem que a task exija.
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
 * Caminhos apagados do worktree antes de qualquer overlay.
 *
 * Sem isso, um repo que ja versiona `.kiro/` nao tem baseline limpo: A0
 * herdaria a configuracao atual e o experimento mediria outra coisa.
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
      label: "agente puro, vibe",
      hypothesis: "Baseline. Reproduz a dor atual do time.",
      mode: "vibe",
      overlay: overlay({}),
    },
    {
      id: "A1",
      repo: p.repo,
      label: "agente puro, spec",
      hypothesis: "Spec mode sozinho ja reduz task incompleta.",
      mode: "spec",
      overlay: overlay({}),
    },
    {
      id: "A2",
      repo: p.repo,
      label: "spec + steering minimo",
      hypothesis: "Regras persistentes cortam retrabalho.",
      mode: "spec",
      overlay: overlay({ ...steeringBase }),
    },
    {
      id: "A3",
      repo: p.repo,
      label: "A2 + gates deterministicos",
      hypothesis: "Obrigar lint/typecheck/arch no loop corta a maior fatia de credito.",
      mode: "spec",
      overlay: overlay({ ...steeringBase, ".kiro/steering/gates.md": gates }, true),
    },
    {
      id: "A4",
      repo: p.repo,
      label: "A3 + qmd MCP",
      hypothesis: "Retrieval local substitui leitura de arquivo inteiro.",
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
      label: "A4 + escopo negativo (/grill)",
      hypothesis: "Non-goals explicitos eliminam feature nao pedida.",
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
