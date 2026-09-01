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

## O laço que este kit assume

```
    pedido pequeno  →  agente implementa  →  gates rápidos  →  commit
         ↑                                        │
         └────────────  vermelho  ←───────────────┘
```

1. **Recorte pequeno.** Uma mudança que caiba numa rodada de revisão sua. Tarefa
   grande vira várias, não vira prompt maior.
2. **O agente implementa com o teste junto.** Não depois. Ramo novo sem caso novo
   já nasce reprovando dois gates.
3. **Gates rápidos rodam sozinhos.** O hook `Stop` em `.kiro/hooks/gates.json`
   dispara `npm run gates:rapidos` quando o agente acha que terminou. A definição
   de pronto deixa de depender de ele lembrar.
4. **Você revisa o diff, não a conversa.** `git diff --cached` antes de todo push
   — inclusive porque vazamento de credencial é o risco mais concreto de dar
   shell a um agente, e é por isso que `npm run segredos` existe.
5. **Vermelho volta para o agente com a saída do gate**, não com "não funcionou".

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
