---
inclusion: manual
name: contrato
description: Separa o que a tarefa diz do que você achou, antes de escrever código.
---
# Contrato de tarefa

Antes de qualquer código, vamos separar **o que a tarefa diz** do **que eu achei**.
Você me entrevista; eu respondo. Uma pergunta por vez.

Rode `npm run contrato -- --novo` e preencha `.kiro/contratos/<branch>.md` comigo.

## Como conduzir

**1. Colete fatos, com fonte.**
Um fato é o que a tarefa ou o código **afirmam**, e vem com endereço:
`arquivo:linha`, nome de teste, ou trecho citado do card. Leia o código antes de
afirmar qualquer coisa sobre ele — não deduza pelo nome do arquivo.

Se você não achou a fonte, **não é fato**. Desce para suposição.

**2. Liste o que você ia preencher sozinho.**
Aqui está o ponto do exercício. Todo lugar onde a tarefa é omissa e você ia
escolher por conta própria vira uma suposição escrita. Classifique cada uma:

- **segura** — errou, o conserto é barato e nada quebra em produção.
- **bloqueante** — errou, o que a gente entregar está errado.

Casos que quase sempre são bloqueantes e quase nunca estão no card: arredondamento,
fuso horário, o que fazer com lista vazia, se a operação é idempotente, qual o
comportamento no limite exato, e se o erro é de negócio ou de infraestrutura.

**3. Pergunte o que trava.**
Cada suposição bloqueante vira uma pergunta objetiva para mim, com a sua
recomendação primeiro: *"assumo X porque Y; confirma?"*. É mais fácil eu
confirmar uma proposta do que responder uma pergunta aberta.

**Enquanto houver pergunta em aberto, não escreva código de produção.** Não
preencha a lacuna com o palpite mais provável — o palpite fica indistinguível de
requisito no diff, e o teste que você escrever vai confirmar o seu palpite em vez
de verificar o requisito. É assim que se entrega verde e errado.

**4. Feche o escopo pelo negativo.**
O que seria razoável fazer junto e não vai ser feito agora. Se algo virou card
novo, registre o número.

**5. Diga como vai provar.**
Qual teste falha hoje e passa no fim. "Vou testar" não serve; qual caso.

## Depois de preencher

`npm run contrato` valida. Ele reprova enquanto houver fato sem fonte, suposição
bloqueante sem resposta, ou pergunta em aberto. Verde, pode implementar.

O contrato é do tamanho da tarefa: tarefa de uma linha tem contrato de dez. O que
não pode é começar sem ele.
