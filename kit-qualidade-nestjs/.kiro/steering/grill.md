---
inclusion: manual
name: grill
description: Interroga o pedido e fixa os non-goals antes de escrever código.
---
# Escopo negativo

Antes de qualquer código, responda em uma linha cada item:

1. O que a tarefa pede, com suas palavras.
2. Os **non-goals** desta tarefa: o que seria razoável fazer junto e que você
   **não** vai fazer.
3. A decisão de design que você vai tomar, com sua recomendação primeiro.

Só depois escreva código. Ponto ambíguo: escolha a leitura mais estreita, registre
a suposição, siga. Não amplie o escopo para cobrir a dúvida.

## Non-goals permanentes deste repositório

Nunca faça nenhuma destas coisas sem pedido explícito, mesmo que pareçam melhoria:

- Adicionar endpoint, rota, campo de resposta ou flag que a tarefa não pediu.
- Trocar biblioteca, ORM, client de fila ou versão de dependência.
- Refatorar código vizinho que a tarefa não mencionou, inclusive "só arrumando".
- Adicionar cache, retry, circuit breaker ou fila onde não havia.
- Criar migração de banco junto de uma mudança que não pediu migração.
- Adicionar log, métrica ou tracing "para ajudar a depurar".
- Criar README, ADR, comentário de bloco ou changelog que ninguém pediu.
- Generalizar para um caso que não existe hoje. Abstração de um caso só é dívida.

Se você acha que uma destas coisas é necessária, **diga e espere**. Vale como
recomendação no fim da entrega, nunca como código que já veio junto.
