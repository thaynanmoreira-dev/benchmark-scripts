# Benchmark de configurações do Kiro

Harness para descobrir, **com evidência**, qual combinação de steering / tools / modo
entrega mais qualidade por crédito gasto do que o agente puro.

Métrica primária: **créditos por tarefa aprovada**. Não pass rate cru — um arm barato
que falha metade das vezes custa mais no total do que um arm caro que acerta.

O raciocínio por trás do desenho está em [`docs/DESENHO-EXPERIMENTAL.md`](docs/DESENHO-EXPERIMENTAL.md).

---

## Como funciona

O golden dataset sai de PRs que já foram mergeadas nos seus próprios repositórios.
Para cada PR o harness monta um worktree no **merge-base** — o commit anterior real —,
entrega ao agente a descrição do work item, e depois usa **os testes daquela PR como
grader held-out**: eles só são plantados no disco depois que o agente terminou, então
ele nunca os viu.

```
select-prs  →  manifest.json     PRs estratificadas por tamanho + grader held-out
bench-init  →  .bench/plan.json  perfil do repo, arms, observabilidade, ordem randomizada
bench-run   →  obs/runs.jsonl    executa cada célula (arm × tarefa × repetição)
bench-report → obs/report.json   custo por tarefa aprovada + checagem de validade
```

Princípio que orienta o desenho todo:

> Chame o LLM apenas para o que ferramenta determinística não consegue verificar.

Lint, tsc, dependency-cruiser e testes são a primeira linha, tanto no produto quanto
no próprio harness. A sondagem do repositório lê `package.json`, lockfile e árvore de
diretórios de graça; o agente só é acionado para o julgamento que sobra.

### Os arms

Ablação incremental, não fatorial: cada arm adiciona exatamente uma coisa ao anterior,
então cada diferença é atribuível a uma única mudança.

| Arm | Configuração | Hipótese |
|---|---|---|
| A0 | agente puro, vibe | baseline — reproduz a dor atual |
| A1 | agente puro, spec | spec mode sozinho reduz task incompleta |
| A2 | A1 + steering mínimo (`tech.md` + `structure.md`) | regras persistentes cortam retrabalho |
| A3 | A2 + gates determinísticos no loop | maior fatia de economia de crédito |
| A4 | A3 + qmd MCP | retrieval local substitui leitura de arquivo inteiro |
| A5 | A4 + escopo negativo (`/grill`) | non-goals explícitos eliminam feature não pedida |

Se A4 não bater A3, o qmd não pagou. Corta.

---

## Requisitos

Node >= 22.6 e git. Mais nada — os quatro CLIs rodam sem instalar dependência nenhuma,
com o TypeScript executado nativamente pelo Node.

`npm install` só é necessário para rodar `npm run typecheck`. Os quatro comandos também
estão como atalho: `npm run select`, `npm run init`, `npm run -- run`, `npm run report`.
Todos aceitam `--help`.

---

## Uso

### 1. Calibre o adapter do CLI antes de qualquer coisa

```bash
node src/bench-init.ts --probe-agent --config bench.config.json
```

Isso invoca o CLI do agente uma vez e mostra a saída bruta, o texto extraído e —
o mais importante — **se o stream expõe contabilidade de uso**. Se expuser, o custo é
capturado automaticamente. Se não, você vai precisar rodar os arms em série e
registrar o saldo do dashboard em `.bench/obs/credits.json`.

Ajuste o bloco `agent` da config até a saída sair limpa:

```json
"agent": {
  "cmd": "kiro-cli",
  "args": ["chat", "--no-interactive"],
  "promptMode": "stdin",
  "promptFlag": null,
  "modeArgs": { "vibe": [], "spec": ["--spec"] },
  "modelFlag": "--model",
  "timeoutMs": 900000
}
```

`promptMode: "arg"` + `promptFlag` para CLIs que não aceitam prompt por stdin.

### 2. Monte o golden dataset

```bash
node src/select-prs.ts --config bench.config.json \
  --targets 0,25,50,75,100 --per-bucket 2 \
  --require-tests --scale log --clamp 5:95
```

Sem config nenhuma, contra um clone que você já tem no disco:

```bash
node src/select-prs.ts --repo-dir ../meu-servico --name meu-servico --require-tests
```

### 3. Bootstrap

```bash
node src/bench-init.ts --config bench.config.json
```

Materializa os mirrors, perfila cada repositório, gera os arms **por repositório**,
monta a observabilidade e emite o plano em ordem randomizada com seed.

**Pare aqui e preencha `.bench/obs/PRE-REGISTRO.md`.** O critério de adoção escrito
antes de ver qualquer número é o que impede você de escolher, depois, o resultado que
já queria.

### 4. Rode

```bash
node src/bench-run.ts --config bench.config.json
```

Interrompeu no meio? Rode de novo: runs já gravados são pulados. Para fatiar:

```bash
node src/bench-run.ts --only-arms A0,A3 --limit 20
node src/bench-run.ts --dry-run            # mostra o que rodaria, sem chamar o agente
```

### 5. Leia

```bash
node src/bench-report.ts --by-task --markdown resultado.md
```

---

## Funciona a partir de qualquer repositório

O provider é escolhido sozinho pela config, e pode ser forçado com `--provider`.

| Provider | Precisa de | Como monta o corpus |
|---|---|---|
| `local-git` | nada | lê merge commits (ou commits de primeira linhagem) do próprio histórico |
| `github` | `GITHUB_TOKEN` (opcional em repo público) | REST `/pulls?state=closed`, filtrando os merged |
| `azure-devops` | `AZDO_PAT` | REST `pullrequests?status=completed` |

`local-git` é o que torna o harness aplicável a qualquer repositório, inclusive um
clone offline sem token. Ele detecta sozinho se o repo usa merge commit ou squash
merge; force com `PR_MODE=merges` ou `PR_MODE=commits`.

A sondagem do projeto entende Node/TypeScript a fundo (gerenciador de pacotes, test
runner, scripts, dependency-cruiser, monorepo) e degrada com dignidade para Python e
Go. Ecossistema desconhecido não quebra o bootstrap: os gates que não existem viram
`null` e ficam fora do veredito.

---

## O que cada métrica quer dizer

| Campo em `runs.jsonl` | Sintoma que ele mede |
|---|---|
| `heldOutTests` | "faz tarefas pela metade" — os testes do PR original passam? |
| `goldenFilesMissed` | idem, pelo outro lado: arquivos do PR que o agente nem tocou |
| `filesOutsideGoldenDiff` | "cria features que ninguém pediu" |
| `usageFromStream` / `creditsDelta` | "consumo alto de crédito" |
| `agentTurns` | quantas idas e voltas o arm precisou para fechar os gates |

Um run só conta como **aprovado** quando todo teste held-out passa **e** nenhum gate
determinístico ficou vermelho.

### Como o custo é lido do stream

Um CLI real repete o mesmo consumo em vários lugares do mesmo evento. O evento final
do Claude Code, por exemplo, publica os mesmos tokens em `usage`, de novo em
`usage.iterations[]` e mais uma vez em `modelUsage[modelo]` com as chaves em camelCase
— somar tudo multiplicava o consumo por oito. O extrator resolve isso em duas regras:

- **prefere o evento de resumo.** Se o CLI fecha a invocação com um evento que traz
  custo, esse evento já é o acumulado da invocação inteira, e os eventos parciais que
  o precedem são descartados em vez de somados;
- **para de descer ao achar contabilidade.** O que estiver aninhado abaixo de um nó
  que já declarou tokens é detalhamento do mesmo consumo, não consumo adicional.

Cada run registra `usageFromStream.basis` (`terminal` ou `somado`) e `samples`, para
que o número possa ser conferido a mão contra o dashboard. Turnos de reparo são
invocações separadas do CLI, então esses sim são somados entre si.

### Custo quando o CLI não expõe uso

Rode os arms em série e registre o saldo do dashboard em `.bench/obs/credits.json`:

```json
{
  "snapshots": [
    { "at": "2026-03-10T09:00:00Z", "balance": 5000, "label": "antes do bloco A0" },
    { "at": "2026-03-10T11:20:00Z", "balance": 4830, "label": "depois do bloco A0" }
  ]
}
```

O `bench-report` rateia o consumo de cada janela entre os runs que começaram dentro
dela. Isso só faz sentido com execução em série — em paralelo o número vira ficção.

---

## Validade

O `bench-report` roda as checagens que decidem se o benchmark concluiu alguma coisa:

- **inválido** se o modelo trocou no meio, ou se o desvio dentro da mesma célula
  (arm × tarefa) for maior que a diferença entre arms — nesse caso o que você está
  vendo é sorteio, não efeito da configuração;
- **atenção** para célula com menos de 3 repetições, plano incompleto, run que
  quebrou antes da avaliação, tarefa sem grader.

### Isca de escopo

Uma tarefa com requisito propositalmente vago, sem golden diff e sem teste held-out.
Ela nunca é aprovada — o que ela mede é `filesOutsideGoldenDiff`, ou seja, quanto o
agente inventa quando o pedido deixa espaço. Veja `examples/tasks.isca-de-escopo.json`
e anexe com `--extra-tasks`.

---

## Limitações conhecidas

- **Teste como grader é exigente por natureza.** O teste do PR original espera os
  nomes que o autor original escolheu. Uma implementação correta com outra nomenclatura
  é reprovada. Isso penaliza todos os arms por igual, então a *comparação* continua
  válida; o pass@1 absoluto, não.
- **O turno de reparo é um processo novo.** Cada invocação do CLI é uma sessão nova, e
  o agente perde o contexto do turno anterior. Se o seu CLI sabe continuar uma sessão,
  coloque a flag em `agent.args` do arm correspondente.
- **`.kiro/` já versionado contamina o baseline.** Por padrão os arms apagam a
  configuração existente no worktree para que A0 seja baseline limpo. Se você quer
  medir contra a configuração atual em vez do zero, use
  `"baselineStripsExistingConfig": false` e renomeie A0 mentalmente para "config atual".
- **Perfil semântico com `confidence: low` contamina A2 em diante por igual.** Revise
  `.bench/projects/*.json` antes de gastar cota: se o steering descreve a arquitetura
  errada, o benchmark mede a sua descrição errada, não a configuração.
- **O overhead do CLI hospedeiro entra na conta.** Se o CLI do agente carrega um
  system prompt grande, cada invocação paga isso em cache write/read antes de ler uma
  linha do repositório. O custo é constante entre os arms, então a *comparação*
  continua válida, mas o número absoluto por run não é o custo da tarefa — é o custo
  da tarefa mais o do hospedeiro. Confira com `--probe-agent`, que mostra o consumo de
  uma invocação que não faz nada.
- **Benchmark offline mede tarefa isolada.** Não mede fricção no dia a dia, hook que o
  dev burla com `--no-verify`, nem contexto acumulado de uma feature de três dias.
  Valide o vencedor com duas semanas de uso real: créditos/dev/dia, % de PR aprovada
  na primeira, retrabalho.

---

## Verificar o harness sem gastar crédito

```bash
npm test          # unidade + smoke ponta a ponta
npm run typecheck
```

O smoke test cria um repositório git de mentira com três PRs mergeadas, roda os quatro
CLIs contra um agente falso e verifica que as métricas saem como deveriam — inclusive
que steering reduz escopo inventado e que a retomada não repete run já gravado. É o que
rodar depois de mexer no harness, antes de apontá-lo para os repositórios de verdade.

```bash
node test/smoke.ts --keep   # preserva os artefatos para inspeção
```

## Teste real reduzido, com um agente de verdade

O smoke test não gasta crédito porque o agente é falso. Para exercitar o caminho
inteiro contra um CLI de verdade — inclusive a passada semântica, o adapter e a
contabilidade de uso, que é onde os problemas de integração aparecem:

```bash
bash test/exemplo-real/rodar.sh
ARMS=A0,A2,A5 REPS=2 AGENT_CMD=kiro-cli bash test/exemplo-real/rodar.sh
```

Ele monta um serviço de pagamentos em Node/TypeScript com três PRs mergeadas de
tamanhos diferentes — CPF, parcelamento pela Tabela Price, conciliação de extrato —
com código que compila, lint e typecheck reais, e os testes de cada PR como grader
held-out. Depois roda os cinco passos na ordem: calibra o adapter, monta o golden
dataset, faz o bootstrap, executa e relata.

O default é reduzido de propósito (2 arms, 3 tarefas, 1 repetição): é um teste do
harness, não uma medição para decidir adoção. O relatório vai apontar isso na seção
de validade, e ele está certo.

Variáveis: `AGENT_CMD`, `AGENT_ARGS`, `MODEL`, `ARMS`, `REPS`, `DESTINO`.

---

## Estrutura

```
src/
  select-prs.ts        golden dataset a partir de PRs mergeadas
  bench-init.ts        mirrors, perfil, arms, observabilidade, plano
  bench-run.ts         o runner
  bench-report.ts      agregação e checagem de validade
  lib/
    providers/         local-git, github, azure-devops
    git.ts             mirrors, worktrees, numstat, arquivos tocados
    agent.ts           adapter do CLI + extração de texto e de uso
    probe.ts           sondagem determinística da stack
    arms.ts            geração dos arms e do steering
    obs.ts             runs.jsonl, schema, pré-registro
    deps.ts            instalação com cache por hash de lockfile
    shell.ts           execução de gates
    stats.ts           percentil, Wilson, PRNG com seed
examples/
  bench.config.*.json    configs por provider
  tasks.isca-*.json      isca de escopo
kit-qualidade-nestjs/  pacote autônomo, independente do harness: steering
                       para agentes e gates de qualidade para serviços NestJS.
                       Ver o README de lá.
test/
  unit.ts              testes de unidade do parsing e da estatistica
  smoke.ts             harness ponta a ponta com agente falso, sem crédito
  exemplo-real/        repositório realista + execução com agente de verdade
```

Saída de trabalho, toda em `.bench/` e fora do git:

```
.bench/
  mirrors/<repo>.git       clone bare; os worktrees saem daqui
  projects/<repo>.json     perfil determinístico + semântico
  arms/<repo>/<arm>.json   overlay de cada arm, por repositório
  work/<runId>/            worktree efêmero do run
  cache/deps/<hash>/       node_modules compartilhado por lockfile
  logs/<runId>.log         saída bruta do agente
  obs/runs.jsonl           resultados, append-only
  obs/report.json          agregação
  plan.json                ordem randomizada com seed
```
