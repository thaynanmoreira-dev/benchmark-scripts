---
inclusion: fileMatch
fileMatchPattern: 'src/**/*.ts'
---
# Clean Architecture simplificada com CQRS

Uma pasta por módulo de negócio, quatro camadas dentro dela:

```
src/<modulo>/
  domain/           entidades, value objects, regras de negócio
  application/      handlers de command e query, portas (classes abstratas)
  infrastructure/   repositórios, clients HTTP, produtores e consumidores de fila
  interface/        controllers REST, consumidores de mensageria
  <modulo>.module.ts  a fiação: quem implementa cada porta
```

## Direção de dependência

`npm run arch` reprova a violação, então isto não é convenção — é gate:

- **domain** não importa nada. Nem outra camada, nem NestJS, nem ORM, nem client
  de fila. Entidade que depende de framework não dá para testar sem subir o
  framework, e é assim que a suíte fica lenta e frágil.
- **application** importa `domain`. Declara a **porta** (classe abstrata, não
  interface — o Nest precisa de um token que sobreviva ao apagamento de tipos) e
  depende dela, nunca da implementação.
- **infrastructure** importa `domain` e `application`, e implementa as portas.
- **interface** importa `application` e `domain`. Nada de dentro importa
  `interface`.
- Ciclo de import é erro. Se apareceu, alguém cruzou a fronteira nos dois sentidos.

## CQRS

- Command muda estado e devolve pouco. Query lê e não muda nada.
- Uma classe por caso de uso: `<verbo>-<substantivo>.command.ts` e o handler ao
  lado. Handler que faz duas coisas são dois handlers.
- Handler não conhece HTTP nem o formato da mensagem da fila — quem traduz é a
  camada `interface`.

## Onde as coisas moram

- Regra que vale independente de quem chamou → `domain`.
- Orquestração de passos, transação, publicação de evento → `application`.
- SQL, query do Mongo, chave do Redis, tópico da fila, retry → `infrastructure`.
- DTO com `class-validator`, rota, cabeçalho, código de status → `interface`.

Na dúvida entre `domain` e `application`: se a regra continua verdadeira num
sistema sem banco e sem fila, é `domain`.
