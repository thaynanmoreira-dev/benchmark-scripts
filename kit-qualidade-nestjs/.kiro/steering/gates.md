---
inclusion: always
---
# Definição de pronto

A tarefa **começa** quando `npm run contrato` sai com zero, e não antes: enquanto
houver fato sem fonte, suposição bloqueante sem resposta ou pergunta em aberto,
não escreva código de produção. Use `/contrato` para preencher comigo.

A tarefa está **pronta** quando este comando sai com zero, e não antes:

```bash
npm run gates:rapidos   # segundos — rode a cada mudança
npm run gates           # inclui mutação (minutos) — rode antes de me devolver
```

Rode você mesmo. Não me devolva para eu descobrir que está vermelho: cada ida e
volta custa crédito do time.

Os gates rodam em paralelo e o relatório traz **todos** os vermelhos de uma vez,
com a saída de cada um. Conserte tudo antes de rodar de novo — não vá corrigindo
um por rodada.

## Os limites

Nenhum destes números é para você calcular de cabeça — cada um tem um comando que
dá o veredito.

| Limite | Comando |
|---|---|
| Contrato da tarefa completo | `npm run contrato` |
| Formatação canônica | `npm run format:check` (`npm run format` corrige) |
| Complexidade ciclomática < 22 | `npm run lint` |
| Complexidade cognitiva < 22 | `npm run lint` |
| Função entre 4 e 20 linhas, no máximo 2 níveis | `npm run lint` |
| Linhas de código por arquivo < 500 | `npm run lint` |
| Zero `any`, zero `unknown`, zero `as` | `npm run lint` |
| Tipos explícitos na fronteira | `npm run lint` |
| Nomes greppáveis, sem termo genérico | `npm run lint` |
| Erro sempre com mensagem | `npm run lint` |
| Suíte sem teste desligado nem sem asserção | `npm run lint` |
| Cobertura de tipos 100% | `npm run typecoverage` |
| Direção de dependência entre camadas | `npm run arch` |
| Nome de arquivo e pasta previsível | `npm run estrutura` |
| Dificuldade de Halstead < 80 | `npm run halstead` |
| Nenhum segredo no repositório | `npm run segredos` |
| Cobertura de testes 100% | `npm test` |
| CRAP < 25 | consequência dos dois acima¹ |
| Mutantes sobreviventes: 0 | `npm run mutation` |
| Código morto: 0 | `npm run deadcode` |
| Código redundante: 0 | `npm run duplication` |
| Nenhuma supressão nova | `npm run sem-atalho` |
| Nenhum gate afrouxado ou apagado | `npm run gates-intactos` |

¹ `CRAP = complexidade² × (1 − cobertura)³ + complexidade`. Com cobertura em 100%
o termo cúbico zera e CRAP vira a própria ciclomática, já limitada em 22.

## Proibido desligar o gate em vez de resolver o problema

Nunca introduza, em código de produção nem em teste:

`eslint-disable` · `@ts-ignore` · `@ts-expect-error` · `@ts-nocheck` ·
`istanbul ignore` · `c8 ignore` · `Stryker disable` · `jscpd:ignore` ·
`prettier-ignore` · `type-coverage:ignore` · `secretlint-disable` ·
`as any` · `as unknown` · qualquer asserção `as` · `it.skip` · `test.todo` ·
`xit` · `xdescribe`

Nem altere `jest.config.mjs`, `eslint.config.mjs`, `stryker.config.mjs`,
`knip.json`, `.jscpd.json`, `.dependency-cruiser.cjs`, `.ls-lint.yml`,
`.prettierignore`, `.gates-baseline.json`, `tools/gates.mjs` ou
`tools/gates-intactos.mjs`.

**Apagar a regra não é saída.** `npm run gates-intactos` pergunta ao ESLint qual
configuração está valendo de verdade e reprova se um limite sumiu ou foi
afrouxado — desligar com `'off'`, apagar a linha e tirar o gate da lista do
executor dão todos vermelho. Apertar um limite passa; afrouxar precisa de
decisão registrada no PR.

`npm run sem-atalho` conta essas ocorrências e reprova qualquer aumento. Contornar
não deixa o build verde — só troca qual gate fica vermelho.

**Se um limite não der para cumprir, pare e me pergunte.** Limite que não fecha é
informação de projeto, não obstáculo a contornar. Diga o que trava e proponha a
alternativa.
