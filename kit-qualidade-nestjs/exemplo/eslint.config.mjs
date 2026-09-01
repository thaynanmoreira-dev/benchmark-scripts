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
        {
          // Stack trace e sinal de depuracao para o agente. Erro sem mensagem
          // obriga uma rodada extra de investigacao a cada vez que estoura.
          selector: 'NewExpression[callee.name=/Error$/][arguments.length=0]',
          message: 'Erro sem mensagem: diga o que recebeu e o que esperava.',
        },
      ],

      // Proibir `unknown` sem proibir `as` nao aumenta seguranca nenhuma: so
      // troca uma marcacao honesta de "nao sei o tipo" por uma afirmacao falsa
      // de que sabe. As duas proibicoes andam juntas ou nenhuma vale.
      '@typescript-eslint/consistent-type-assertions': ['error', { assertionStyle: 'never' }],

      // ── unidades pequenas o bastante para caber numa leitura do agente
      //
      // Agente le arquivo em pedaco e navega por grep. Funcao que nao cabe numa
      // leitura vira modelo mental fragmentado, e aninhamento profundo multiplica
      // o custo de atencao. Os numeros vem de pratica documentada, nao de gosto.
      'max-lines-per-function': ['error', { max: 20, skipBlankLines: true, skipComments: true }],
      'max-depth': ['error', 2],
      'max-statements': ['error', 15],
      'max-params': ['error', 4],

      // ── tipos explicitos na fronteira: a assinatura e o gabarito do agente
      '@typescript-eslint/explicit-module-boundary-types': 'error',

      // ── nomes que sobrevivem ao grep
      //
      // Se voce procura o nome e vem resultado irrelevante, o nome esta errado.
      // Estes nunca carregam significado alcancavel por busca.
      'id-denylist': [
        'error',
        'data', 'info', 'obj', 'res', 'val', 'tmp', 'temp',
        'foo', 'bar', 'baz', 'stuff', 'thing',
        'util', 'utils', 'helper', 'manager',
      ],

      // ── codigo morto e redundante que o lint alcanca
      'no-unreachable': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      'sonarjs/no-identical-functions': 'error',
      'sonarjs/no-all-duplicated-branches': 'error',
      'sonarjs/no-redundant-jump': 'error',
    },
  },
  // Qualidade da propria suite: teste desligado ou sem assercao passa no jest,
  // engana a cobertura e nao mata mutante nenhum.
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
      // describe/it agrupam varios casos: o limite de linhas vale para a unidade
      // de producao, nao para o bloco que a exercita.
      'max-lines-per-function': 'off',
      'max-statements': 'off',
    },
  },

  // Por ultimo: desliga tudo que brigaria com o formatador. Estilo nao e
  // assunto de lint quando existe formatador — ele decide, a gente aceita.
  prettier,
);
