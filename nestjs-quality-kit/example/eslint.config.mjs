import tseslint from 'typescript-eslint';
import sonarjs from 'eslint-plugin-sonarjs';
import jest from 'eslint-plugin-jest';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  { ignores: ['dist/**', 'coverage/**', 'reports/**', 'node_modules/**'] },
  ...tseslint.configs.strictTypeChecked,
  {
    languageOptions: { parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname } },
    plugins: { sonarjs },
    rules: {
      // NestJS: @Module is an empty class on purpose, and the strictTypeChecked
      // preset rejects it. allowWithDecorator permits exactly that case without
      // switching the rule off for the rest of the code.
      '@typescript-eslint/no-extraneous-class': ['error', { allowWithDecorator: true }],

      // ── threshold: the rule fires when the value EXCEEDS max, so max = limit - 1
      complexity: ['error', { max: 21 }],
      'sonarjs/cognitive-complexity': ['error', 21],
      'max-lines': ['error', { max: 499, skipBlankLines: true, skipComments: true }],

      // ── explicit any, and any leaking in from an untyped library
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unsafe-assignment': 'error',
      '@typescript-eslint/no-unsafe-call': 'error',
      '@typescript-eslint/no-unsafe-member-access': 'error',
      '@typescript-eslint/no-unsafe-return': 'error',
      '@typescript-eslint/no-unsafe-argument': 'error',

      // ── unknown: no ready-made rule exists; ban it through the AST node
      'no-restricted-syntax': [
        'error',
        { selector: 'TSUnknownKeyword', message: 'unknown is banned: validate at the boundary and type the result.' },
        {
          // A stack trace is a debugging signal. An error with no message forces an
          // extra round of investigation every time it is thrown.
          selector: 'NewExpression[callee.name=/Error$/][arguments.length=0]',
          message: 'Error with no message: say what you got and what you expected.',
        },
      ],

      // Banning `unknown` without banning `as` adds no safety at all: it swaps an
      // honest "I do not know the type" marker for a false claim that you do. The
      // two bans travel together or neither is worth anything.
      '@typescript-eslint/consistent-type-assertions': ['error', { assertionStyle: 'never' }],

      // ── units small enough to fit in a single read
      //
      // Agents read files in chunks and navigate by grep. A function that does not
      // fit in one read becomes a fragmented mental model, and deep nesting
      // multiplies the attention cost. The numbers come from documented practice.
      'max-lines-per-function': ['error', { max: 20, skipBlankLines: true, skipComments: true }],
      'max-depth': ['error', 2],
      'max-statements': ['error', 15],
      'max-params': ['error', 4],

      // ── explicit types at the boundary: the signature is the answer key
      '@typescript-eslint/explicit-module-boundary-types': 'error',

      // ── names that survive a grep
      //
      // If you search for the name and irrelevant results come back, the name is
      // wrong. These never carry meaning a search can reach.
      'id-denylist': [
        'error',
        'data', 'info', 'obj', 'res', 'val', 'tmp', 'temp',
        'foo', 'bar', 'baz', 'stuff', 'thing',
        'util', 'utils', 'helper', 'manager',
      ],

      // ── dead and redundant code the linter can reach
      'no-unreachable': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      'sonarjs/no-identical-functions': 'error',
      'sonarjs/no-all-duplicated-branches': 'error',
      'sonarjs/no-redundant-jump': 'error',
    },
  },
  // Quality of the suite itself: a disabled or assertion-free test passes in
  // jest, fools coverage and kills no mutant.
  {
    files: ['**/*.spec.ts', '**/*.e2e-spec.ts'],
    plugins: { jest },
    rules: {
      'jest/no-disabled-tests': 'error',
      'jest/no-focused-tests': 'error',
      'jest/no-identical-title': 'error',
      'jest/expect-expect': 'error',
      'jest/valid-expect': 'error',
      'jest/no-conditional-expect': 'error',
    },
  },

  // Tests: production stays at zero, tests may use doubles.
  //
  // The `unknown` and type-assertion bans exist to stop external data from
  // entering the system unvalidated. Test code receives no external data and
  // does not ship. Keeping the ban here would force a domain port into
  // existence purely to type a framework double — the linter dictating the
  // architecture. These three lines are counted by the `no-bypass` gate as a
  // known exception; any new one is a violation.
  {
    files: ['**/*.spec.ts', '**/*.e2e-spec.ts', 'test/**/*.ts'],
    rules: {
      'no-restricted-syntax': 'off',
      '@typescript-eslint/consistent-type-assertions': 'off',
      'sonarjs/no-identical-functions': 'off',
      // describe/it group several cases: the line limit applies to the production
      // unit, not to the block that exercises it.
      'max-lines-per-function': 'off',
      'max-statements': 'off',
    },
  },

  // Last: switch off everything that would fight the formatter. Style is not a
  // linting concern once a formatter exists — it decides, we accept.
  prettier,
);
