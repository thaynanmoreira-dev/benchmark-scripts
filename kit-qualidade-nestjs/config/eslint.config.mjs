import tseslint from 'typescript-eslint';
import sonarjs from 'eslint-plugin-sonarjs';

export default tseslint.config(
  { ignores: ['dist/**', 'coverage/**', 'reports/**', 'node_modules/**'] },
  ...tseslint.configs.strictTypeChecked,
  {
    languageOptions: { parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname } },
    plugins: { sonarjs },
    rules: {
      // NestJS: @Module e classe vazia de proposito, e a regra do preset
      // strictTypeChecked reprova. allowWithDecorator libera exatamente esse
      // caso sem desligar a regra para o resto do codigo.
      '@typescript-eslint/no-extraneous-class': ['error', { allowWithDecorator: true }],

      // ── limiar: a regra dispara quando PASSA do maximo, entao max = limite - 1
      complexity: ['error', { max: 21 }],
      'sonarjs/cognitive-complexity': ['error', 21],
      'max-lines': ['error', { max: 499, skipBlankLines: true, skipComments: true }],

      // ── any explicito e any que vaza de biblioteca sem tipo
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unsafe-assignment': 'error',
      '@typescript-eslint/no-unsafe-call': 'error',
      '@typescript-eslint/no-unsafe-member-access': 'error',
      '@typescript-eslint/no-unsafe-return': 'error',
      '@typescript-eslint/no-unsafe-argument': 'error',

      // ── unknown: nao ha regra pronta; proibe pelo no da AST
      'no-restricted-syntax': [
        'error',
        { selector: 'TSUnknownKeyword', message: 'unknown proibido: valide na fronteira e tipe o resultado.' },
      ],

      // Proibir `unknown` sem proibir `as` nao aumenta seguranca nenhuma: so
      // troca uma marcacao honesta de "nao sei o tipo" por uma afirmacao falsa
      // de que sabe. As duas proibicoes andam juntas ou nenhuma vale.
      '@typescript-eslint/consistent-type-assertions': ['error', { assertionStyle: 'never' }],

      // ── codigo morto e redundante que o lint alcanca
      'no-unreachable': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      'sonarjs/no-identical-functions': 'error',
      'sonarjs/no-all-duplicated-branches': 'error',
      'sonarjs/no-redundant-jump': 'error',
    },
  },
  // Testes: producao fica em zero, teste pode dublar.
  //
  // As proibicoes de `unknown` e de asserção de tipo existem para impedir que
  // dado externo entre no sistema sem validacao. Codigo de teste nao recebe
  // dado externo e nao vai para producao. Manter a proibicao aqui obrigaria a
  // criar porta de dominio so para tipar dublê de classe de framework — o
  // linter mandando na arquitetura. Estas tres linhas sao contadas pelo gate
  // `sem-atalho` como excecao conhecida, e qualquer nova entra como violacao.
  {
    files: ['**/*.spec.ts', '**/*.e2e-spec.ts', 'test/**/*.ts'],
    rules: {
      'no-restricted-syntax': 'off',
      '@typescript-eslint/consistent-type-assertions': 'off',
      'sonarjs/no-identical-functions': 'off',
    },
  },
);
