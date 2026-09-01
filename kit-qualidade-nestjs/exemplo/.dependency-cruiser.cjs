/**
 * Direcao de dependencia da Clean Architecture simplificada com CQRS.
 *
 * A regra existe porque steering nao segura arquitetura: um import errado
 * compila, passa no lint e so aparece meses depois, quando trocar o banco
 * exige mexer no dominio. Aqui ele reprova o build no minuto em que nasce.
 *
 *   interface  -> application, domain          (controller, consumer de fila)
 *   application-> domain                       (handlers de command/query, portas)
 *   infrastructure -> application, domain      (implementa as portas)
 *   domain     -> nada                         (nao conhece Nest, banco nem HTTP)
 */
module.exports = {
  forbidden: [
    {
      name: 'dominio-isolado',
      severity: 'error',
      comment:
        'domain nao pode importar nenhuma outra camada. Se precisa de algo de fora, ' +
        'declare uma porta em application e receba o dado ja pronto.',
      from: { path: '^src/[^/]+/domain/' },
      to: { path: '^src/[^/]+/(application|infrastructure|interface)/' },
    },
    {
      name: 'aplicacao-nao-conhece-detalhe',
      severity: 'error',
      comment:
        'application nao pode importar infrastructure nem interface. Dependa da porta ' +
        'abstrata; quem escolhe a implementacao e o modulo.',
      from: { path: '^src/[^/]+/application/' },
      to: { path: '^src/[^/]+/(infrastructure|interface)/' },
    },
    {
      name: 'ninguem-importa-interface',
      severity: 'error',
      comment: 'interface e a borda de entrada. Nada de dentro depende dela.',
      from: { path: '^src/[^/]+/(domain|application|infrastructure)/' },
      to: { path: '^src/[^/]+/interface/' },
    },
    {
      name: 'dominio-sem-framework',
      severity: 'error',
      comment:
        'domain nao importa Nest, ORM nem client de fila. Entidade que depende de ' +
        'framework nao da para testar sem subir o framework.',
      from: { path: '^src/[^/]+/domain/' },
      to: { path: 'node_modules/(@nestjs|typeorm|mongoose|@prisma|amqplib|kafkajs|ioredis)' },
    },
    {
      name: 'sem-ciclo',
      severity: 'error',
      comment: 'Ciclo de import: alguem cruzou a fronteira nos dois sentidos.',
      from: {},
      to: { circular: true },
    },
    {
      name: 'sem-orfao',
      severity: 'error',
      comment: 'Modulo que ninguem importa e que nao importa ninguem: codigo morto.',
      from: { orphan: true, pathNot: ['\\.d\\.ts$', '(^|/)main\\.ts$'] },
      to: {},
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    tsConfig: { fileName: 'tsconfig.json' },
    tsPreCompilationDeps: true,
    exclude: { path: '\\.spec\\.ts$' },
  },
};
