---
inclusion: always
---
# Definição de pronto

A tarefa está pronta quando **este comando sai com zero**, e não antes:

```bash
npm run gates:rapidos   # segundos — rode a cada mudança
npm run gates           # inclui mutação (minutos) — rode antes de me devolver
```

Rode você mesmo. Não me devolva para eu descobrir que está vermelho: cada ida e
volta custa crédito do time.

## Os limites

Nenhum destes números é para você calcular de cabeça — cada um tem um comando que
dá o veredito.

| Limite | Comando |
|---|---|
| Complexidade ciclomática < 22 | `npm run lint` |
| Complexidade cognitiva < 22 | `npm run lint` |
| Linhas de código por arquivo < 500 | `npm run lint` |
| Zero `any`, zero `unknown`, zero `as` | `npm run lint` |
| Direção de dependência entre camadas | `npm run arch` |
| Dificuldade de Halstead < 80 | `npm run halstead` |
| Cobertura de testes 100% | `npm test` |
| CRAP < 25 | consequência dos dois acima¹ |
| Mutantes sobreviventes: 0 | `npm run mutation` |
| Código morto: 0 | `npm run deadcode` |
| Código redundante: 0 | `npm run duplication` |
| Nenhum gate desligado | `npm run sem-atalho` |

¹ `CRAP = complexidade² × (1 − cobertura)³ + complexidade`. Com cobertura em 100%
o termo cúbico zera e CRAP vira a própria ciclomática, já limitada em 22.

## Proibido desligar o gate em vez de resolver o problema

Nunca introduza, em código de produção nem em teste:

`eslint-disable` · `@ts-ignore` · `@ts-expect-error` · `@ts-nocheck` ·
`istanbul ignore` · `c8 ignore` · `Stryker disable` · `jscpd:ignore` ·
`as any` · `as unknown` · qualquer asserção `as` · `it.skip` · `test.todo` ·
`xit` · `xdescribe`

Nem altere `jest.config.mjs`, `eslint.config.mjs`, `stryker.config.mjs`,
`knip.json`, `.jscpd.json`, `.dependency-cruiser.cjs` ou `.gates-baseline.json`.

`npm run sem-atalho` conta essas ocorrências e reprova qualquer aumento. Contornar
não deixa o build verde — só troca qual gate fica vermelho.

**Se um limite não der para cumprir, pare e me pergunte.** Limite que não fecha é
informação de projeto, não obstáculo a contornar. Diga o que trava e proponha a
alternativa.
