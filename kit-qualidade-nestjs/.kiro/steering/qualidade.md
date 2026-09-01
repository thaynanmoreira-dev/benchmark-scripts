---
inclusion: fileMatch
fileMatchPattern: 'src/**/*.ts'
---
# Como escrever código que passa nos gates

Os números estão nas ferramentas. O que segue é o comportamento que mantém o
código abaixo deles — porque "deixe a ciclomática < 22" não é calculável enquanto
se escreve, mas "extraia a condição para uma função com nome" é.

## Unidades pequenas

Você lê arquivo em pedaços e navega por busca, não de cima a baixo. Unidade que
não cabe numa leitura vira modelo mental fragmentado, e aninhamento profundo
multiplica o custo de atenção. Daí os limites:

- Função entre 4 e 20 linhas. Passou disso, extraia — não comprima.
- No máximo dois níveis de indentação. Valide na entrada e retorne cedo.
- `switch` ou `else if` com mais de quatro ramos vira `Record<Chave, Handler>` e
  uma busca: soma um ponto de complexidade em vez de um por ramo.
- Condição booleana com três ou mais operandos vira função com nome
  (`ehElegivelParaDesconto(pedido)`).
- Um método faz uma coisa. Se precisa de comentário para separar as fases, são
  dois métodos.

## Nomes que sobrevivem ao grep

Busca é como você navega. Nome genérico devolve resultado irrelevante e custa uma
leitura a mais em cada volta.

- Regra prática: se você procura o nome e vem coisa que não interessa, o nome
  está errado. `total` não; `totalLiquidoCentavos` sim.
- Proibidos como identificador: `data`, `info`, `obj`, `res`, `val`, `tmp`,
  `temp`, `foo`, `bar`, `stuff`, `thing`, `util`, `utils`, `helper`, `manager`.
- Nome de arquivo em minúsculas com segmentos separados por ponto ou hífen
  (`calcular-total.handler.ts`). Estrutura previsível dispensa `find`.

## Comentários

Isto é o oposto do que se ensinava: comentário é contexto de primeira classe
para quem lê o código depois, inclusive você numa sessão futura.

- **Nunca apague comentário existente ao refatorar**, seu ou de outro. Ele está
  lá porque alguém precisou daquela informação.
- Documente o **porquê**, nunca o quê. `// incrementa i` é ruído que custa token.
- O que vale registrar: bug de produção que motivou a lógica estranha, restrição
  de negócio, contorno de biblioteca, número do card, referência de commit.
- Assinatura pública ganha docstring com intenção e um exemplo de uso.

## Erros com contexto

Stack trace é o seu sinal de depuração. Mensagem vaga custa uma rodada inteira de
investigação a cada vez que o erro estoura.

- Nunca `new Error()` sem mensagem — o lint reprova.
- Diga o que recebeu e o que esperava: `throw new RangeError(\`percentual fora do
  intervalo: recebi ${percentual}, esperava 0 a 100\`)`.
- Log estruturado em JSON com campos nomeados, nunca prosa concatenada.

## Cobertura 100% e mutação zero

Cobertura diz se a linha executou. Mutação diz se **algum teste reclamaria** caso a
linha mudasse. Passar na primeira e falhar na segunda é o caso normal, e é o que os
testes deste repositório precisam evitar:

- Toda comparação de fronteira precisa de caso **na** fronteira e nos dois lados.
  `if (x < 0)` exige teste com `x` em -1, 0 e 1. Sem o caso em 0, a mutação de `<`
  para `<=` sobrevive.
- Asseverar o valor, não a existência. `expect(r).toBeDefined()` não mata mutante.
- Erro esperado: asseverar tipo **e** mensagem. Só `toThrow()` deixa sobreviver o
  mutante que apaga a mensagem.
- Escreva o teste junto com o código. Ramo novo sem caso novo já nasce reprovando
  dois gates.

## Zero `any`, `unknown` e `as`

Sem esses três, dado de fora só entra **validado em runtime**. É essa a intenção da
regra, não estilo:

- Fronteira HTTP: DTO com `class-validator` e `ValidationPipe` global. O tipo do
  parâmetro passa a ser verdade em runtime, não promessa.
- Fila, webhook, resposta de API externa, `JSON.parse`: passe por um schema (`zod`
  ou equivalente) e use o tipo que ele infere. Nunca consuma o resultado cru.
- `catch (e)`: deixe sem anotação. Com `strict`, o TypeScript já dá o tipo certo
  sem que você escreva a palavra proibida. Estreite com `e instanceof Error`.
- Genérico que não resolve é sinal de que falta um parâmetro de tipo, não licença
  para afrouxar.
- Em `*.spec.ts` as regras de `unknown` e `as` estão desligadas, só para dublê de
  classe de framework. Em produção, zero.

## Código morto e redundante

- Só use `export` no que outro arquivo realmente importa. `export` por reflexo é a
  maior fonte de código morto.
- Segunda ocorrência de um trecho pode conviver. Terceira: extraia. Antes disso
  você costuma extrair a abstração errada.
- Apagou o último uso de algo? Apague a coisa também, no mesmo commit.
