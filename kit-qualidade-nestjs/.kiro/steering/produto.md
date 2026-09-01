---
inclusion: always
---
# Contexto deste serviço

<!--
  TEMPLATE — preencha as três seções abaixo e apague estes comentários.

  Este é o único arquivo do kit que descreve o SEU domínio. Ele é carregado em
  toda interação com o agente, então vale a pena escrevê-lo bem e mantê-lo curto:
  cada linha aqui entra em todo prompt e custa em toda tarefa.

  O que faz diferença aqui não é descrever o produto para um humano, e sim dizer
  ao agente as coisas que ele erraria por não ter como adivinhar. Duas perguntas
  ajudam a encontrar o que escrever:

    1. O que um dev novo quebraria na primeira semana por não saber?
    2. O que já causou incidente aqui mais de uma vez?
-->

## O que este serviço faz

<!--
  Duas ou três frases, em linguagem de negócio. Quem consome, o que entra, o que
  sai, e o que acontece se estiver errado. Exemplo:

  "Calcula o parcelamento oferecido no checkout e concilia o que foi liquidado
  contra o extrato do adquirente. Consumido pelo app e pelo backoffice. Erro aqui
  não é bug de tela: é cobrança duplicada ou conciliação que não fecha."
-->

TODO: descreva o serviço.

## Restrições que não mudam

<!--
  As invariantes que valem para TODO código deste repositório, com a
  consequência prática. Três a cinco itens; mais que isso ninguém lembra.

  Escreva a regra E o que ela proíbe, porque a proibição é a parte acionável.
  Exemplos do formato:

  1. **Valor monetário é inteiro em centavos.** Nunca `float` para dinheiro,
     nunca `toFixed` para arredondar. Em rateio, a sobra do arredondamento tem
     destino explícito e a soma das partes fecha com o todo.
  2. **Erro de entrada é resultado tipado, não exceção de fluxo.** Validação
     devolve falha; exceção fica para o que é de fato excepcional.
  3. **Handler de mensageria é idempotente.** A entrega acontece mais de uma vez.
     Se um handler não tolera reentrega, isso é dito no PR, não deixado implícito.
-->

TODO: liste as invariantes do domínio.

## Fora de escopo permanente

<!--
  O que este serviço deliberadamente NÃO faz, para o agente não "completar" o
  desenho por conta própria. Exemplo: "não expõe endpoint público — só o BFF
  chama"; "não guarda dado de cartão".
-->

TODO: liste o que este serviço não faz.

## Como trabalhar comigo

<!-- Esta seção é genérica e serve para qualquer projeto. Pode manter como está. -->

- Termine a tarefa inteira. "Implementei a parte principal, falta o teste" não é
  entrega — os gates de `gates.md` é que decidem se acabou.
- Não invente escopo. Se o pedido está ambíguo, escolha a leitura mais estreita,
  registre a suposição e siga; não amplie para cobrir a dúvida.
- Pergunte cedo e uma vez só. Ida e volta custa tempo e orçamento de uso.
