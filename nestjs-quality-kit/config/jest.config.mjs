export default {
  // swc instead of ts-jest. Not just for speed: ts-jest 29 requires @babel/core 7
  // and Stryker 10 requires 8, and npm cannot hoist both. With swc, babel leaves
  // the Jest side and the conflict disappears. decoratorMetadata stays on in
  // .swcrc because Nest dependency injection depends on it.
  transform: { '^.+\\.ts$': ['@swc/jest', {}] },
  testEnvironment: 'node',
  rootDir: 'src',
  testRegex: '.*\\.spec\\.ts$',

  collectCoverage: true,
  // Include ALL production code, not just what some test imported. Without this,
  // a file with no test simply does not appear in the report, and coverage reads
  // 100% with the whole file uncovered.
  // The exclusion list is where "100% coverage" quietly becomes a lie. It exists
  // only for wiring with no decision branches: the bootstrap and the @Module
  // classes, which merely declare providers. Any new line here is an engineering
  // decision that needs review — the tools/no-bypass.mjs gate fails anyone who
  // touches it without justification.
  collectCoverageFrom: [
    '**/*.ts',
    '!**/*.spec.ts',
    '!**/*.d.ts',
    '!main.ts',
    '!**/*.module.ts',
  ],
  coverageDirectory: '../coverage',
  coverageReporters: ['text-summary', 'json', 'lcov'],
  coverageThreshold: {
    global: { branches: 100, functions: 100, lines: 100, statements: 100 },
  },
};
