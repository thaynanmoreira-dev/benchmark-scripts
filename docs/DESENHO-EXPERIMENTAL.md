# Desenho experimental do benchmark

Por que o harness é como é. O [README](../README.md) diz como usar; este documento
diz o que foi decidido, com que fundamento, e o que invalida o resultado.

## Problema que o benchmark resolve

Um time adota um agente de IA e reclama de três coisas ao mesmo tempo:

1. o agente faz tarefas pela metade;
2. o agente cria coisas que ninguém pediu;
3. o consumo por tarefa simples é alto.

Existe configuração que melhore isso — steering, modo de operação, gates no laço,
retrieval — mas escolher entre elas por opinião produz discussão, não decisão. O
benchmark troca a opinião por medida.

## Objetivo

Descobrir, com evidência, **qual combinação de steering / tools / modo entrega mais
qualidade por crédito gasto** do que Kiro puro. Não é para escolher por opinião.

**Métrica primária: créditos por tarefa aprovada.** Não pass rate cru — um arm barato
que falha metade das vezes custa mais no total.

## O que o harness precisa do repositório alvo

Um histórico de PRs mergeadas com testes, e comandos de teste e lint que rodem sem
intervenção. A sondagem entende Node/TypeScript a fundo e degrada para Python e Go.
Os provedores de corpus cobrem GitHub, Azure DevOps e git local puro — este último
sem API nem token, lendo o próprio histórico.

## Princípio de design que orienta tudo

> Chame o LLM apenas para o que ferramenta determinística não consegue verificar.

Lint, tsc, dependency-cruiser e testes são a primeira linha. O agente só é acionado
para julgamento que essas ferramentas não alcançam. Isso vale tanto para o produto
final quanto para o próprio harness do benchmark.

---

## Desenho experimental

### Golden dataset
PRs já mergeadas dos próprios repos. Para cada PR:
- worktree no **merge-base** (commit pai real, não o tip do target)
- task = descrição do work item original
- **grader = os testes daquela PR, held-out** (aplicados só na avaliação, invisíveis ao agente)

Estratificado por tamanho de alteração: min do corpus = 0%, max = 100%, seleção nas
porcentagens-alvo. Inclui 1 tarefa "isca de escopo" (requisito propositalmente vago)
para medir invenção de feature.

### Arms (ablação incremental, não fatorial)

| Arm | Configuração | Hipótese |
|---|---|---|
| A0 | Kiro puro, vibe | baseline — reproduz a dor atual |
| A1 | Kiro puro, spec | spec mode sozinho reduz task incompleta |
| A2 | A1 + steering mínimo (tech.md + structure.md) | regras persistentes cortam retrabalho |
| A3 | A2 + gates determinísticos no loop | maior fatia de economia de crédito |
| A4 | A3 + qmd MCP | retrieval local substitui leitura de arquivo inteiro |
| A5 | A4 + `/grill` com non-goals | escopo negativo elimina feature não pedida |

Se A4 não bater A3, o qmd não pagou. Corta.

### Controles obrigatórios
- n ≥ 3 repetições por (arm × tarefa) — o agente é estocástico
- ordem randomizada com seed — senão drift do serviço vira efeito falso
- modelo travado (um só, para todo o benchmark)
- sessão nova por run, worktree limpo, índice qmd idêntico
- **pré-registro do critério de adoção antes de olhar qualquer dado**

Escala estimada: ~9 tarefas × 6 arms × 3 reps ≈ 160 runs.

---

## Os componentes

### `select-prs.ts`
CLI que monta o golden dataset.

- busca PRs mergeadas via GitHub, Azure DevOps ou o histórico git local
- calcula o diff real com `git diff --numstat` contra o merge-base
- descarta lockfile / dist / snapshot / binário do cálculo de tamanho
- normaliza min→0% / max→100%, seleciona o PR mais próximo de cada alvo, sem repetir
- separa `testFiles` de `prodFiles` na saída — o grader held-out
- cache em `.pr-cache.json`: reajustar targets/escala é instantâneo

Flags que importam: `--scale log` (churn é cauda pesada), `--clamp 5:95` (corta outlier),
`--metric prod-churn`, `--require-tests`.

Saída: `manifest.json`.

### `bench-init.ts`
Bootstrap. Adapta o benchmark a qualquer projeto.

1. mirrors bare em `.bench/mirrors/<repo>.git` — worktrees saem daqui
2. sonda determinística: package.json, lockfile, tsconfig, árvore, config de lint/CI,
   e detecção de `.kiro/` pré-existente
3. passada semântica via o CLI do agente, **uma vez por repo, cacheada por hash do lockfile**:
   camadas reais, invariantes críticas, resumo de domínio, non-goals prováveis
4. perfil → `.bench/projects/<repo>.json`
5. arms gerados a partir do perfil → `.bench/arms/*.json`
6. observabilidade → `.bench/obs/` (runs.jsonl, schema.json, credits.json, PRE-REGISTRO.md)
7. plano randomizado → `.bench/plan.json`

Rodar `--probe-agent` primeiro para calibrar o adapter do CLI antes de qualquer coisa.

---

## O runner (`src/bench-run.ts`)

Consome `plan.json`. Para cada entrada, em ordem:

1. `git worktree add --detach` do mirror no `baseCommit`
2. instalar deps (cache compartilhado por hash de lockfile)
3. aplicar o overlay do arm (steering, mcp.json, hooks) no worktree
4. **remover os arquivos de teste held-out do worktree** — o agente não pode vê-los
5. disparar o CLI do agente com a descrição da task
6. restaurar os testes held-out e rodá-los
7. rodar os gates: lint, typecheck, dependency-cruiser
8. diffar arquivos tocados contra o golden diff → métrica de escopo
9. append de uma linha em `obs/runs.jsonl`
10. destruir o worktree

Ponto crítico do passo 5: verificar se o `stream-json` expõe usage/tokens. Se expuser,
custo é capturado automático. Se não, rodar em série e usar snapshot manual do
dashboard em `obs/credits.json`.

---

## Decisões já tomadas (não reabrir sem motivo)

- **mirror bare + worktree**, não clone por run. 160 runs em clone completo é
  inviável em disco e tempo. Object store compartilhado não afeta o resultado
  porque cada worktree é detached no commit base.
- **merge-base**, não `lastMergeTargetCommit`, como baseline do diff.
- **Determinístico antes de LLM** na sondagem — package.json e árvore de diretórios
  são grátis e sempre confiáveis; o agente entra só para ler código de verdade.
- **Ablação incremental**, não fatorial completo — 6 arms em vez de 16 combinações.

## Armadilhas conhecidas

- Se um repo já tem `.kiro/` versionado, A0 não é baseline limpo. Ou remove no overlay,
  ou renomeia o baseline para "config atual".
- Perfil semântico com `confidence: low` contamina A2–A5 igualmente — revisar
  `.bench/projects/*.json` antes de gastar cota.
- Arms são gerados a partir do primeiro repo. Se as arquiteturas divergirem entre os
  10, gerar um plano por repo.
- Se a variância entre reps for maior que a diferença entre arms, o benchmark não
  conclui nada — precisa de mais reps ou tarefas menos ruidosas.

## Validação pós-benchmark

Benchmark offline mede tarefa isolada. Não mede fricção real, hook que o dev burla com
`--no-verify`, nem contexto acumulado de uma feature de 3 dias. Depois de escolher o
vencedor, validar com 2 semanas de uso real: créditos/dev/dia, % de PR aprovada na
primeira, retrabalho.
