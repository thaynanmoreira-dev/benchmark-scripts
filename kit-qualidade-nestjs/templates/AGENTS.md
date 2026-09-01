# Instruções para agentes

Arquivo lido por Claude Code, Codex, Cursor e outros. O Kiro lê as mesmas regras
de forma mais granular em `.kiro/steering/`; este arquivo é o resumo executável
para todo o resto. Mantenha curto: ele entra em toda iteração.

## Comandos

```bash
bin/setup                # do zero até rodando, idempotente
npm run gates:rapidos    # segundos — rode a cada mudança
npm run gates            # inclui mutação, minutos — antes de entregar
npm run format           # o formatador decide o estilo
npm test                 # testes com cobertura
```

## Definição de pronto

A tarefa acaba quando `npm run gates` sai com zero. Não antes, e não "acabou mas
falta o teste". Rode você mesmo antes de me devolver.

## Regras que não se negociam

- **Nunca desligue um gate.** Sem `eslint-disable`, `@ts-ignore`, `istanbul
  ignore`, `Stryker disable`, `prettier-ignore`, `as any`, `it.skip`. Nem edite
  os arquivos de configuração dos gates. `npm run sem-atalho` reprova qualquer
  aumento, então contornar não deixa o build verde.
- **Zero `any`, `unknown` e asserção `as` em produção.** Dado externo entra
  validado em runtime: DTO com `class-validator` no HTTP, schema em fila e
  webhook.
- **Função entre 4 e 20 linhas, no máximo dois níveis de indentação.**
- **Nomes greppáveis.** Se buscar o nome traz resultado irrelevante, renomeie.
- **Nunca apague comentário existente ao refatorar.** Comentário é contexto, não
  enfeite. Documente o porquê, nunca o quê.
- **Erro sempre com mensagem** dizendo o que recebeu e o que esperava.
- **Não invente escopo.** Pedido ambíguo: escolha a leitura mais estreita,
  registre a suposição, siga. Não amplie para cobrir a dúvida.

## Testes

Teste é a fonte da verdade deste projeto, não documento de especificação.

- Escreva o teste junto com o código, não depois.
- Toda comparação de fronteira precisa de caso **na** fronteira e nos dois lados.
- Asseverar valor, não existência. Erro esperado: tipo **e** mensagem.
- Cobertura 100% e zero mutante sobrevivente são gates, não meta.

## Estrutura

Uma pasta por módulo de negócio, quatro camadas: `domain` não importa nada,
`application` importa `domain`, `infrastructure` implementa as portas de
`application`, `interface` é a borda de entrada e ninguém importa dela.
`npm run arch` reprova a violação.
