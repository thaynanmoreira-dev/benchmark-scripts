# Como trabalhar com o agente

Este documento existe para responder uma pergunta que aparece sempre: *qual
framework de desenvolvimento com IA a gente adota?*

A resposta deste kit é **nenhum**, e isso é uma escolha, não uma omissão.

## Por que não tem framework aqui

O ganho real vem de engenharia de software comum — testes que rodam, código
pequeno e legível, integração contínua, feedback curto. A camada de orquestração
por cima disso é onde mora a maior parte do marketing e a menor parte do
resultado.

Três coisas ficaram de fora de propósito:

**Orquestração multi-agente.** Confiabilidade compõe por multiplicação: dez
agentes a 90% cada dão 35% no fim da linha. Um agente capaz com laço simples
supera um comitê de agentes medianos, e gasta uma fração dos tokens.

**Grafos de workflow para tarefa linear.** Desenhar nós e ramos para o que é uma
sequência não adiciona informação — adiciona artefato para manter.

**Especificação como fonte da verdade.** Uma spec precisa o bastante para gerar
código correto já *é* um programa, só que em prosa. E ela apodrece no primeiro
deploy, como aconteceu com UML e MDA. Aqui a fonte da verdade é **o teste**: ele
é executável, não pode divergir do código sem alguém ficar sabendo, e o gate de
mutação garante que ele realmente afirma alguma coisa.

Isso não quer dizer que essas técnicas nunca sirvam. Quer dizer que elas são
nichos, e tratá-las como padrão custa mais do que rende.

## O gate que falta em todo lugar

Todos os gates de qualidade olham o **código**. Nenhum deles pega o erro mais
caro: código correto pelo motivo errado.

O agente é ótimo em preencher lacuna. Esse é o problema. Quando a tarefa não diz
qual é o arredondamento, ele escolhe um, escreve o teste que confirma a escolha
dele, e entrega verde. Lint passa, cobertura em 100%, mutação em 100%, arquitetura
limpa. O comportamento está errado do mesmo jeito, e ninguém descobre até o
incidente — porque o teste virou cúmplice do palpite em vez de verificador do
requisito.

Dev experiente sente o cheiro e pergunta. Dev com menos estrada aceita a resposta
confiante e segue. É exatamente aí que o kit precisa segurar.

### Contrato de tarefa

Antes de escrever código, `.kiro/contratos/<branch>.md` separa três coisas:

| Seção | O que vai nela |
|---|---|
| **Fatos** | o que a tarefa ou o código afirmam, cada um com fonte: `arquivo:linha`, teste, ou trecho do card |
| **Suposições** | o que você está preenchendo sozinho, cada uma marcada `segura` ou `bloqueante` |
| **Perguntas em aberto** | o que você não consegue responder — enquanto houver item aqui, a tarefa não começa |

Mais o escopo negativo e o teste que vai provar que funcionou.

```bash
npm run contrato -- --novo    # cria a partir do modelo
npm run contrato              # valida
```

O validador reprova enquanto houver fato sem fonte, suposição bloqueante sem
resposta, ou pergunta em aberto. Não é conselho: é `exit 1`, e o hook
`contrato-antes-de-codigo` roda antes de qualquer escrita em `src/`.

A distinção que faz o trabalho é **segura contra bloqueante**. Suposição segura
segue: errou, o conserto é barato. Bloqueante tem de virar fato antes de uma
linha de código — porque se ela estiver errada, tudo que vier depois está errado
junto, e os outros doze gates vão dizer que está ótimo.

Casos que quase sempre são bloqueantes e quase nunca estão no card: arredondamento,
fuso horário, o que fazer com lista vazia, se a operação é idempotente, qual o
comportamento no limite exato, e se o erro é de negócio ou de infraestrutura.

Use `/contrato` no Kiro para o agente conduzir a entrevista. O contrato é do
tamanho da tarefa: tarefa de uma linha tem contrato de dez. O que não pode é
começar sem ele.

## O laço que este kit assume

```
   contrato  →  pedido pequeno  →  agente implementa  →  gates  →  commit
       ↑              ↑                                     │
       │              └──────────── vermelho ───────────────┘
       └── pergunta em aberto: para e pergunta, não implementa
```

1. **Contrato primeiro.** Dois minutos separando fato de suposição. É o único
   gate que pega requisito faltando.
2. **Recorte pequeno.** Uma mudança que caiba numa rodada de revisão sua. Tarefa
   grande vira várias, não vira prompt maior.
3. **O agente implementa com o teste junto.** Não depois. Ramo novo sem caso novo
   já nasce reprovando dois gates.
4. **Gates rápidos rodam sozinhos.** O hook `Stop` em `.kiro/hooks/gates.json`
   dispara `npm run gates:rapidos` quando o agente acha que terminou. A definição
   de pronto deixa de depender de ele lembrar.
5. **Você revisa o diff, não a conversa.** `git diff --cached` antes de todo push
   — inclusive porque vazamento de credencial é o risco mais concreto de dar
   shell a um agente, e é por isso que `npm run segredos` existe.
6. **Vermelho volta para o agente com a saída do gate**, não com "não funcionou".

Antes de entregar, `npm run gates` (com mutação). É o único momento em que vale
esperar minutos.

## Refatoração e auditoria como pedido explícito

Nenhum agente faz isso por conta própria. Duas vezes por feature grande:

> Reavalie o código com cuidado. Apague código morto. Refatore duplicação.
> Acrescente os testes que faltam.

E antes de liberar, com um modelo diferente do que escreveu:

> Audite este diff procurando vazamento de segredo, permissão perigosa, comando
> destrutivo, path traversal e tratamento de erro que engole exceção.

## Protótipo descartável em vez de opinião

Decisão de arquitetura ou escolha de biblioteca vira uma pasta `experiments/`
com duas implementações de mentira, não uma reunião. Código ficou barato; opinião
não ficou mais precisa.

## Onde cada coisa mora

| Informação | Lugar | Sobrevive a quê |
|---|---|---|
| Decisão de arquitetura, benchmark, runbook | `docs/` no repositório | tudo |
| Convenção e regra para o agente | `.kiro/steering/`, `AGENTS.md` | tudo |
| Contexto do domínio | `.kiro/steering/produto.md` | tudo |
| Contexto transitório de sessão | ferramenta de memória do agente | a sessão |

O que é decisão vai para `docs/` e entra no PR. O que é "descobri que aquele
container precisa de `--network host`" não é documentação canônica — é memória de
sessão, e existe ferramenta dedicada para isso.

## Sobre o modo spec do Kiro

O Kiro tem um fluxo de spec. Ele não está proibido: serve bem para explorar um
problema que você ainda não entende, como rascunho antes de escrever teste.

O que este kit recusa é promover a spec a **fonte da verdade**. Depois que o
código existe, quem manda é o teste, e a spec vira mais um documento para
apodrecer em silêncio. Use como rascunho, não como contrato — e não commite spec
que ninguém vai atualizar.

---

Referências que embasam as escolhas acima:
[Clean Code for AI Agents](https://akitaonrails.com/en/2026/04/20/clean-code-for-ai-agents/) ·
[Hot Take: Harness/Loop/Graph Engineering are bullshit](https://akitaonrails.com/en/2026/08/18/hot-take-harness-loop-engineering-graph-engineering-are-bullshit/) ·
[Akita's AI Tips and Toolkit](https://akitaonrails.com/en/2026/05/24/akita-ai-tips-toolkit-ai-jail-ai-memory-ai-usagebar/)

## O que existe por aí, e por que não adotamos

Avaliação do ecossistema de Kiro em setembro de 2026, contra o critério deste
kit: manter dev com menos estrada na linha, e fazer o agente **perguntar** quando
falta especificação em vez de preencher com palpite.

| Projeto | O que é | Veredito |
|---|---|---|
| [AI-DLC](https://github.com/awslabs/aidlc-workflows) | metodologia AWS: 5 fases, 33 estágios, 14 agentes, portões de aprovação | **não** — confiabilidade de múltiplos agentes compõe por multiplicação, e a superfície de manutenção é enorme. E não tem mecanismo de pergunta esclarecedora, que é justamente o que precisávamos |
| [ECC](https://github.com/affaan-m/ECC) | 68 agentes, 286 skills, 94 comandos, multi-harness | **não** — mesmo problema, em escala maior, e sem adaptador para Kiro. O `/ecc:plan` com confirmação é a ideia certa, enterrada num sistema que é um segundo emprego para manter |
| [everything-kiro](https://github.com/yuening8080/everything-kiro) | coleção de steering, hooks e MCP bem organizada | **parcialmente** — mesma forma do nosso kit. Adotamos a ideia de workflow manual nomeado (`/contrato` nasceu daí). Não tem nada sobre ambiguidade |
| [KiroGraph](https://github.com/davide-desio-eleva/kirograph) | índice semântico do código via tree-sitter, exposto por MCP | **opcional, meça antes** — é recuperação sobre código real, não grafo de workflow, então ataca de verdade o "assumir sem ler". Mas são 126 ferramentas e ~6.240 tokens de esquema sempre carregados, sem nenhum benchmark publicado. Rode como arm no benchmark antes de adotar |
| [Lift for Kiro](https://github.com/kirodotdev-labs/kiro-lift) | A/B de augmentations com estratificação e juízes | **sim, para outro problema** — mede se um MCP ou steering paga. Dele vieram duas melhorias reais para o nosso harness: comparação pareada por McNemar e triagem de tarefa que não discrimina |
| [kiro-steering-docs](https://github.com/mikeartee/kiro-steering-docs) | steering reutilizável por categoria | fonte de ideias, não dependência |

O padrão: o ecossistema resolve bem orquestração e coleções de regras, e **não
resolve** o momento em que a tarefa é omissa. Por isso o contrato de tarefa deste
kit não veio de lugar nenhum — foi construído para a lacuna.
