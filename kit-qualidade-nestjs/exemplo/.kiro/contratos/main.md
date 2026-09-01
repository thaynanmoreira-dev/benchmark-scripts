# Contrato: main

Contrato do próprio exemplo. Serve para o gate rodar verde aqui e como modelo
preenchido de verdade, ao lado do modelo em branco que o `--novo` gera.

## Tarefa

Serviço NestJS mínimo que demonstra os treze gates do kit sobre um caso de uso
real: calcular o total de um pedido com desconto, em quatro camadas.

Origem: README do kit, seção "O que tem dentro"

## Fatos

- [F1] O total do pedido é somado em centavos inteiros. — fonte: src/pedido/domain/pedido.ts:23
- [F2] O desconto recusa percentual fora do intervalo de 0 a 100. — fonte: src/pedido/domain/pedido.spec.ts
- [F3] A consulta do total passa por um handler de query do CQRS. — fonte: src/pedido/application/calcular-total.handler.ts

## Suposições

- [S1] (segura) Repositório em memória basta para o exemplo; um serviço de verdade usaria banco.
- [S2] (segura) Nenhuma autenticação, porque o objeto do exemplo são os gates.

## Perguntas em aberto

- (nenhuma)

## Fora de escopo

- Não expõe persistência real, autenticação nem observabilidade.
- Não cobre o domínio de pagamento além do necessário para exercitar os gates.

## Como vou provar que funcionou

- `npm ci && npm run gates` sai com zero em sala limpa, incluindo mutação em 100%.
