export default {
  // swc no lugar do ts-jest. Nao e so velocidade: ts-jest 29 exige @babel/core 7
  // e o Stryker 10 exige o 8, e o npm nao consegue icar os dois. Com swc o babel
  // sai do lado do Jest e o conflito deixa de existir. decoratorMetadata fica
  // ligado no .swcrc porque a injecao de dependencia do Nest depende dele.
  transform: { '^.+\\.ts$': ['@swc/jest', {}] },
  testEnvironment: 'node',
  rootDir: 'src',
  testRegex: '.*\\.spec\\.ts$',

  collectCoverage: true,
  // Inclui TODO o codigo de producao, nao so o que algum teste importou.
  // Sem isto, um arquivo sem nenhum teste simplesmente nao aparece no
  // relatorio, e a cobertura marca 100% com o arquivo inteiro descoberto.
  // A lista de exclusao e onde "100% de cobertura" vira mentira sem ninguem
  // perceber. Ela existe apenas para fiacao sem ramo de decisao: o bootstrap e
  // os @Module, que so declaram providers. Qualquer linha nova aqui e uma
  // decisao de engenharia que precisa passar por revisao — o gate
  // tools/sem-atalho.mjs reprova quem mexer nela sem justificar.
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
