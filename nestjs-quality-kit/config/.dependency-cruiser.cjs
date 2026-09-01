/**
 * Dependency direction for a simplified Clean Architecture with CQRS.
 *
 * The rule exists because steering does not hold architecture in place: a wrong
 * import compiles, passes the linter, and only surfaces months later, when
 * swapping the database means touching the domain. Here it fails the build the
 * minute it is born.
 *
 *   interface      -> application, domain     (controllers, queue consumers)
 *   application    -> domain                  (command/query handlers, ports)
 *   infrastructure -> application, domain     (implements the ports)
 *   domain         -> nothing                 (knows no Nest, no DB, no HTTP)
 */
module.exports = {
  forbidden: [
    {
      name: 'domain-is-isolated',
      severity: 'error',
      comment:
        'domain may not import any other layer. If it needs something from outside, ' +
        'declare a port in application and receive the data ready to use.',
      from: { path: '^src/[^/]+/domain/' },
      to: { path: '^src/[^/]+/(application|infrastructure|interface)/' },
    },
    {
      name: 'application-knows-no-detail',
      severity: 'error',
      comment:
        'application may not import infrastructure or interface. Depend on the abstract ' +
        'port; the module is what picks the implementation.',
      from: { path: '^src/[^/]+/application/' },
      to: { path: '^src/[^/]+/(infrastructure|interface)/' },
    },
    {
      name: 'nobody-imports-interface',
      severity: 'error',
      comment: 'interface is the inbound edge. Nothing on the inside depends on it.',
      from: { path: '^src/[^/]+/(domain|application|infrastructure)/' },
      to: { path: '^src/[^/]+/interface/' },
    },
    {
      name: 'domain-without-framework',
      severity: 'error',
      comment:
        'domain does not import Nest, an ORM or a queue client. An entity that depends on ' +
        'a framework cannot be tested without booting the framework.',
      from: { path: '^src/[^/]+/domain/' },
      to: { path: 'node_modules/(@nestjs|typeorm|mongoose|@prisma|amqplib|kafkajs|ioredis)' },
    },
    {
      name: 'no-cycles',
      severity: 'error',
      comment: 'Import cycle: somebody crossed the boundary in both directions.',
      from: {},
      to: { circular: true },
    },
    {
      name: 'no-orphans',
      severity: 'error',
      comment: 'A module nobody imports and that imports nobody: dead code.',
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
