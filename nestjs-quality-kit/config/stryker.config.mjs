export default {
  packageManager: 'npm',
  testRunner: 'jest',
  jest: { configFile: 'jest.config.mjs' },
  checkers: ['typescript'],
  tsconfigFile: 'tsconfig.json',
  mutate: ['src/**/*.ts', '!src/**/*.spec.ts', '!src/main.ts', '!src/**/*.module.ts'],
  reporters: ['clear-text', 'progress', 'json'],
  coverageAnalysis: 'perTest',
  // break: 100 fails the build on any surviving mutant.
  thresholds: { high: 100, low: 100, break: 100 },
  incremental: true,
  incrementalFile: 'reports/stryker-incremental.json',
  tempDirName: '.stryker-tmp',
};
