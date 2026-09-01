# Kit de qualidade para serviços NestJS

Regras de steering para agentes de IA e gates determinísticos de qualidade,
prontos para copiar para dentro de um serviço NestJS.

```bash
bash instalar.sh /caminho/do/servico                  # serviço novo
MODO=catraca bash instalar.sh /caminho/do/servico     # serviço que já existe
```

O `exemplo/` é um serviço NestJS completo com tudo ligado e **verificado**:
`npm ci && npm run gates` sai com zero. Cada gate foi testado contra uma violação
deliberada, para provar que dispara, e contra código limpo, para provar que passa.

## O que o kit assume

Só duas coisas, e as duas são ajustáveis:

- **NestJS com TypeScript e Jest.** As configs de lint, cobertura e mutação
  partem daí.
- **Clean Architecture com quatro camadas por módulo** (`domain`, `application`,
  `infrastructure`, `interface`), com ou sem CQRS. Se a sua arquitetura for
  outra, ajuste `.kiro/steering/estrutura.md` e `.dependency-cruiser.cjs`
  **juntos** — um descreve a regra para o agente, o outro a faz falhar o build.

O resto é agnóstico. O contexto do seu domínio entra em um arquivo só,
`.kiro/steering/produto.md`, que vem como template para você preencher.

## O que tem dentro

```
.kiro/steering/     as regras que o Kiro carrega
  produto.md        contexto do domínio — TEMPLATE para preencher (sempre)
  gates.md          definição de pronto e os limites             (sempre)
  estrutura.md      camadas, CQRS, direção de dependência        (arquivos .ts)
  qualidade.md      como escrever para caber na leitura de quem lê (arquivos .ts)
  grill.md          escopo negativo e non-goals                  (manual, /grill)
.kiro/hooks/
  gates.json        formata ao salvar, roda os gates ao encerrar,
                    varre segredo antes do commit
templates/
  AGENTS.md         mesmas regras para agentes que não são o Kiro
  bin/setup         do zero até rodando, idempotente
config/             configs das onze ferramentas
tools/              halstead.mjs e sem-atalho.mjs
ci/                 template de pipeline do Azure DevOps, dois estágios
docs/
  COMO-TRABALHAR-COM-O-AGENTE.md   o laço de trabalho, e o que ficou de fora
exemplo/            serviço NestJS com tudo ligado, verde de ponta a ponta
```

Os hooks tornam a definição de pronto automática: o `Stop` dispara
`npm run gates:rapidos` quando o agente acha que terminou, então "esqueci de
rodar" deixa de ser uma possibilidade. **Não consegui testar os hooks aqui** — não
tenho Kiro neste ambiente. O formato segue a
[documentação oficial](https://kiro.dev/docs/hooks/); confira contra a sua versão
antes de confiar. Os comandos que eles chamam, esses sim, estão verificados.

Dois arquivos são carregados em **toda** interação (`inclusion: always`), e os
outros dois só quando um `.ts` está em jogo. Isso é deliberado: steering sempre
ligado entra em todo prompt e vira custo de crédito recorrente. Se `produto.md` e
`gates.md` crescerem, o time paga em toda tarefa.

## Regra → ferramenta

### Limites de complexidade e teste

| Regra | Ferramenta | Config |
|---|---|---|
| Ciclomática < 22 | ESLint `complexity` | `eslint.config.mjs` |
| Cognitiva < 22 | `eslint-plugin-sonarjs` | `eslint.config.mjs` |
| Função de 4 a 20 linhas, até 2 níveis | `max-lines-per-function`, `max-depth` | `eslint.config.mjs` |
| Linhas por arquivo < 500 | ESLint `max-lines` | `eslint.config.mjs` |
| Halstead < 80 | script próprio | `tools/halstead.mjs` |
| Cobertura 100% | Jest `coverageThreshold` | `jest.config.mjs` |
| CRAP < 25 | nenhuma — é implicado | ver abaixo |
| Mutantes sobreviventes: 0 | Stryker `thresholds.break: 100` | `stryker.config.mjs` |
| Suíte sem teste desligado nem sem asserção | `eslint-plugin-jest` | `eslint.config.mjs` |

### Tipos

| Regra | Ferramenta | Config |
|---|---|---|
| Zero `any` | `typescript-eslint`, 6 regras | `eslint.config.mjs` |
| Zero `unknown` e zero `as` | `no-restricted-syntax` + `consistent-type-assertions` | `eslint.config.mjs` |
| Tipos explícitos na fronteira | `explicit-module-boundary-types` | `eslint.config.mjs` |
| Cobertura de tipos 100% | type-coverage | script `typecoverage` |

### Forma do código para quem lê por busca

| Regra | Ferramenta | Config |
|---|---|---|
| Formatação canônica | Prettier | `.prettierrc.json` |
| Nomes greppáveis | ESLint `id-denylist` | `eslint.config.mjs` |
| Arquivo e pasta com nome previsível | ls-lint | `.ls-lint.yml` |
| Erro sempre com mensagem | `no-restricted-syntax` | `eslint.config.mjs` |
| Direção de dependência | dependency-cruiser | `.dependency-cruiser.cjs` |
| Código morto: 0 | knip | `knip.json` |
| Código redundante: 0 | jscpd + `sonarjs/no-identical-functions` | `.jscpd.json` |

### Segurança e integridade dos gates

| Regra | Ferramenta | Config |
|---|---|---|
| Nenhum segredo no repositório | secretlint | `.secretlintrc.json` |
| Dependência com vulnerabilidade conhecida | `npm audit` | script `vulns`, só no CI |
| Nenhum gate desligado | script próprio | `tools/sem-atalho.mjs` |

A direção de dependência **não estava na lista original**. Entrou porque o
contexto pede Clean Architecture, e arquitetura é exatamente o tipo de regra que
steering não segura: um import errado compila, passa no lint e só aparece meses
depois, quando trocar o banco exige mexer no domínio.

## Por que o código tem esta forma

Metade dos limites acima não é sobre humano. Quem lê este código a maior parte do
tempo é um agente, e ele lê sob restrições concretas: puxa o arquivo em pedaços,
navega por `grep` em vez de abrir tudo, perde precisão bem antes do limite
anunciado da janela, e paga token em cada chamada. Isso re-ordena as prioridades
de código limpo, sem inventar nenhuma nova:

| Restrição de quem lê | O que vira gate |
|---|---|
| Lê em pedaços, não de cima a baixo | função de 4 a 20 linhas, arquivo < 500 |
| Aninhamento multiplica custo de atenção | no máximo 2 níveis de indentação |
| Navega por busca | nomes greppáveis, arquivo com nome previsível |
| Assinatura é o gabarito | tipos explícitos, cobertura de tipos 100% |
| Atualiza uma cópia e esquece a outra | zero duplicação |
| Precisa validar o que escreveu | comando de teste headless, `bin/setup` idempotente |
| Formatação inconsistente custa token | formatador decide, ninguém discute |

Duas consequências vão contra o que se ensinava:

**Comentário virou contexto de primeira classe.** O agente lê e usa comentário
para entender o porquê. Isso inverte o conselho de apagar comentário em
refatoração: o steering manda explicitamente **não apagar comentário existente**,
inclusive os que o próprio agente escreveu — ele os deixou porque vai precisar
daquilo depois. O que continua proibido é comentário que narra o óbvio.

**Mensagem de erro é ferramenta de depuração, não texto de UI.** Stack trace vago
custa uma rodada inteira de investigação toda vez que o erro estoura, e essa
rodada é paga em token. Por isso `new Error()` sem mensagem reprova no lint.

## Nove coisas que só apareceram testando

**1. O limiar do ESLint é exclusivo.** A regra dispara quando **passa** do máximo,
então para "< 22" a config diz `21`. Verificado na fronteira: 21 ramos passa, 22
reprova.

**2. CRAP não precisa de ferramenta.**
`CRAP = complexidade² × (1 − cobertura)³ + complexidade`. Com cobertura em 100% o
termo cúbico zera e CRAP vira exatamente a complexidade ciclomática. Com os outros
dois gates verdes, CRAP ≤ 21 < 25 por aritmética. Construir um medidor seria manter
código para recalcular um número já garantido. *(Vale para os arquivos medidos —
por isso a lista de exclusão de cobertura é curta e vigiada.)*

**3. Halstead < 80 quase nunca vai disparar.** Calibração medida no `exemplo/`:
método NestJS normal fica em 11–15, e uma função deliberadamente horrível — quatro
níveis de aninhamento, laços encadeados — chega a 46. O limite de 80 é um teto que
ciclomática e cognitiva alcançam muito antes. Meça o seu próprio código com
`node tools/halstead.mjs --max 0 --json` e escolha o limiar pela distribuição real,
em vez de herdar um número de outro contexto.

Nenhuma ferramenta viva de Node mede Halstead: escomplex, complexity-report e
typhonjs-escomplex estão parados desde 2022, e `ts-complex` devolve `{}` para
arquivo válido e ciclomática 6 numa função com vinte ramos. Por isso o script é
próprio, com a convenção de contagem documentada no cabeçalho — um limiar de
Halstead só significa algo se a contagem for estável.

**4. Cobertura 100% sem `collectCoverageFrom` é mentira.** Arquivo que nenhum teste
importa simplesmente não entra no relatório, e a métrica marca 100% com o arquivo
inteiro descoberto. Medido: com a lista, o mesmo arquivo derruba a cobertura de
100% para 27%. É a linha mais importante do `jest.config.mjs`.

**5. Cobertura 100% e mutação 100% são coisas diferentes, e a distância é grande.**
O `exemplo/` começou com 100% de cobertura e **três mutantes sobreviventes** (score
81,25%): faltavam casos exatamente nas fronteiras `0` e `100` de uma validação de
intervalo, e a mensagem de erro nunca era asseverada. Três falhas reais de teste que
a cobertura não viu. Se vocês forem adotar uma regra só desta lista, adotem esta.

**6. Proibir `unknown` sem proibir `as` piora a segurança.** Medido: a versão segura —
`const cru: unknown = JSON.parse(t)` seguida de estreitamento — é **reprovada** pela
regra. A versão insegura — `JSON.parse(t) as Dto`, sem validação nenhuma — passa no
lint e no `tsc`, e devolve `undefined` em runtime para payload malformado. A
proibição sozinha empurra o código do caminho honesto para o que mente. Por isso ela
vem sempre acompanhada de `consistent-type-assertions: { assertionStyle: 'never' }`:
sem `unknown` e sem `as`, dado de fora só entra validado em runtime, que era a
intenção.

Detalhe que torna a regra viável: `catch (e)` sem anotação **não** dispara nada. Com
`strict`, o TypeScript já dá `unknown` ao erro sem ninguém escrever a palavra.

**7. `ts-jest` e Stryker 10 não convivem, e `overrides` não resolve.** Ver a
armadilha correspondente abaixo — o sintoma só aparece numa instalação do zero,
não numa que foi crescendo aos poucos, então é o tipo de coisa que quebra no CI
depois de passar na máquina de quem escreveu.

**8. Cobertura de tipos é uma segunda linha que supressão de lint não silencia.**
Plantei um `JSON.parse` sem tipagem com `/* eslint-disable */` em cima: o lint
calou, o `tsc` passou, e o `type-coverage` reprovou assim mesmo, apontando os três
identificadores contaminados. Ele também achou um vazamento real que o lint
deixava passar — `NestFactory.create` devolve `INestApplication<any>`, e esse
`any` do framework entrava no nosso código. O conserto foi nomear o servidor de
verdade (`INestApplication<Server>`), não silenciar nada.

**9. Dublê de teste é a única exceção, e ela é deliberada.** `QueryBus.execute` do
NestJS tem quatro sobrecargas; casar a assinatura à mão para evitar o cast exigiria
criar uma porta de domínio cujo único propósito é agradar o linter — o linter
mandando na arquitetura. Por isso as regras de `unknown` e `as` estão desligadas em
`*.spec.ts`, e **só** ali. Produção fica em zero. A exceção são três linhas visíveis
no `eslint.config.mjs`, e o gate `sem-atalho` conta cada uma: qualquer quarta linha
entra como violação.

## Armadilhas de NestJS

- **`@Module` é classe vazia de propósito** e o preset `strictTypeChecked` reprova
  com `no-extraneous-class`. A correção é `allowWithDecorator: true`, não desligar
  a regra.
- **Porta é classe abstrata, não interface.** O Nest precisa de um token de DI que
  sobreviva ao apagamento de tipos; `interface` some na compilação.
- **`main.ts` e `*.module.ts` não têm ramo de decisão** e são as duas únicas
  exclusões de cobertura aqui. Controller entra na conta — o teste dele é curto.
- **knip entende o grafo de DI do Nest sem ajuda**, com
  `entry: ['src/main.ts', 'src/**/*.spec.ts']`. Zero falso positivo no `exemplo/`.
- **jscpd com `threshold: 0` reclama de boilerplate.** `minTokens: 50` e ignorar
  `*.module.ts` e `*.spec.ts` foi o que separou duplicação real de estrutura
  repetida.
- **Não use `ts-jest` junto com Stryker 10.** Eles não conseguem compartilhar um
  babel içado: `ts-jest@29` declara peer `@babel/core >=7 <8` e o
  `@stryker-mutator/instrumenter@10` exige `~8.0.0`. O `npm install` falha com
  ERESOLVE, e `overrides` piora — forçar tudo em 7 quebra o Stryker com
  `traverse is not a function`, e core em 7 com generator em 8 quebra com
  `unknown node of type "TSExpressionWithTypeArguments"` em qualquer classe que
  use `implements Algo<T>`, o que inclui todo handler de CQRS.

  A saída é `@swc/jest`: tira o babel do lado do Jest, o conflito deixa de
  existir sem nenhum `override`, e é o transform que a própria Nest recomenda.
  `decoratorMetadata` fica ligado no `.swcrc`, senão a DI do Nest para de
  funcionar.

## O gate que fecha as portas dos fundos

Cada um dos outros gates tem um atalho: `eslint-disable`, `istanbul ignore`,
`Stryker disable`, `as any`, `it.skip`, ou simplesmente crescer uma lista de
exclusão na config. Quem está com pressa acha a porta antes de achar a solução — e
um agente sob pressão também. Sem este gate, nada acima se sustenta.

`tools/sem-atalho.mjs` conta as portas e reprova qualquer aumento sobre a linha de
base versionada em `.gates-baseline.json`.

```bash
node tools/sem-atalho.mjs --strict    # serviço novo: zero tolerância
node tools/sem-atalho.mjs --gravar    # serviço existente: fixa a linha de base
node tools/sem-atalho.mjs             # CI: reprova aumento
```

## Adotando em código que já existe

Ligar os onze de uma vez num serviço existente gera milhares de erros e o time
desliga tudo na primeira semana. A ordem que sobrevive:

1. `typecheck` e `lint` **sem** os limites numéricos — só `any` e código morto óbvio.
2. `sem-atalho --gravar` no dia 1. A partir daí a dívida só encolhe.
3. Limites de complexidade com o valor **atual** do pior arquivo, não com 22.
   Baixe o número a cada sprint. É catraca, não interruptor.
4. `arch` com as regras em `severity: 'warn'` até zerar; depois vire para `error`.
5. Cobertura: `coverageThreshold` por módulo novo, não global.
6. Mutação por último, e só depois de a cobertura estar honesta em 100%. Mutação em
   suíte fraca produz centenas de sobreviventes e nenhuma ação clara.

## Como trabalhar com o agente, e o que ficou de fora

O kit não traz framework de desenvolvimento com IA, e isso é escolha. Orquestração
multi-agente, grafo de workflow para tarefa linear e especificação como fonte da
verdade ficaram de fora por motivos que estão explicados em
[`docs/COMO-TRABALHAR-COM-O-AGENTE.md`](docs/COMO-TRABALHAR-COM-O-AGENTE.md),
junto com o laço que o kit assume no lugar deles e a posição sobre o modo spec do
Kiro.

Resumo: a fonte da verdade aqui é o teste, porque ele é executável e o gate de
mutação garante que ele afirma alguma coisa. Documento não tem como não apodrecer.

## Custo de execução

`gates:rapidos` reúne doze verificações e roda em segundos — serve para cada save,
e é o que o hook `Stop` dispara. `mutation` é minutos e cresce com a suíte: rode no
PR, com `incremental: true` (já configurado), nunca no laço de edição. Por isso são
dois scripts, e por isso o pipeline tem dois estágios.

`vulns` (`npm audit`) fica fora das duas composições de propósito: depende de rede
e do estado do aviso público, então pode ficar vermelho sem ninguém ter mexido em
nada. No pipeline ele roda com `continueOnError` — é informação para agir, não
portão para travar o PR.
