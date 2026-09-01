#!/usr/bin/env node
/**
 * Verifica se os próprios gates continuam de pé.
 *
 * O `sem-atalho` conta supressões: `eslint-disable`, `istanbul ignore`, regra
 * desligada com `'off'`. Ele não vê a saída mais simples de todas — **apagar a
 * regra**. Config sem a regra não tem `'off'` para contar, o lint fica verde
 * porque não há mais nada checando, e o gate anti-atalho diz que está tudo bem.
 *
 * Este script fecha esse buraco. Ele não olha o texto da config: pergunta ao
 * ESLint qual configuração *resolvida* vale para um arquivo de verdade, e
 * confere contra o que o kit exige. Mesma ideia para cobertura, mutação,
 * duplicação e arquitetura.
 *
 * Regra de ouro: **apertar pode, afrouxar não**. Baixar o limite de
 * complexidade de 21 para 15 passa. Subir para 40, ou apagar, reprova.
 *
 * Uso: node tools/gates-intactos.mjs
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * Regras exigidas na configuração resolvida do ESLint.
 *
 * `maximo` é o teto do valor: o número na config precisa ser menor ou igual.
 * Sem `maximo`, basta a regra existir como erro.
 */
const REGRAS_PRODUCAO = [
  { regra: 'complexity', opcao: 'max', maximo: 21 },
  { regra: 'sonarjs/cognitive-complexity', opcao: 0, maximo: 21 },
  { regra: 'max-lines', opcao: 'max', maximo: 499 },
  { regra: 'max-lines-per-function', opcao: 'max', maximo: 20 },
  { regra: 'max-depth', opcao: 0, maximo: 2 },
  { regra: 'max-statements', opcao: 0, maximo: 15 },
  { regra: 'max-params', opcao: 0, maximo: 4 },
  { regra: '@typescript-eslint/no-explicit-any' },
  { regra: '@typescript-eslint/no-unsafe-assignment' },
  { regra: '@typescript-eslint/no-unsafe-call' },
  { regra: '@typescript-eslint/no-unsafe-member-access' },
  { regra: '@typescript-eslint/no-unsafe-return' },
  { regra: '@typescript-eslint/no-unsafe-argument' },
  { regra: '@typescript-eslint/explicit-module-boundary-types' },
  { regra: '@typescript-eslint/consistent-type-assertions' },
  { regra: 'no-restricted-syntax' },
  { regra: 'id-denylist' },
  { regra: 'sonarjs/no-identical-functions' },
  { regra: 'no-unreachable' },
];

const REGRAS_TESTE = [
  { regra: 'jest/no-disabled-tests' },
  { regra: 'jest/no-focused-tests' },
  { regra: 'jest/expect-expect' },
  { regra: 'jest/no-identical-title' },
];

/** Scripts que precisam existir e estar dentro da composição rápida. */
const SCRIPTS_OBRIGATORIOS = [
  'format:check',
  'typecheck',
  'typecoverage',
  'lint',
  'arch',
  'estrutura',
  'halstead',
  'segredos',
  'sem-atalho',
  'deadcode',
  'duplication',
  'test',
];

const REGRAS_ARQUITETURA = [
  'dominio-isolado',
  'aplicacao-nao-conhece-detalhe',
  'ninguem-importa-interface',
  'dominio-sem-framework',
  'sem-ciclo',
];

const problemas = [];
const anotar = (msg) => problemas.push(msg);

// ─────────────────────────────────────────────────────────── eslint

function configResolvida(arquivo) {
  try {
    return JSON.parse(
      execFileSync('npx', ['eslint', '--print-config', arquivo], {
        encoding: 'utf8',
        maxBuffer: 32 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'ignore'],
      }),
    );
  } catch {
    return null;
  }
}

function conferirRegras(rules, exigidas, ondeLabel) {
  for (const { regra, opcao, maximo } of exigidas) {
    const valor = rules[regra];
    if (valor === undefined) {
      anotar(`${ondeLabel}: a regra \`${regra}\` sumiu da configuração`);
      continue;
    }
    const lista = Array.isArray(valor) ? valor : [valor];
    const severidade = lista[0];
    if (severidade !== 2 && severidade !== 'error') {
      anotar(`${ondeLabel}: \`${regra}\` não está como erro (está: ${JSON.stringify(severidade)})`);
      continue;
    }
    if (maximo === undefined) continue;

    const bruto = lista[1];
    const atual = typeof opcao === 'string' ? bruto?.[opcao] : bruto;
    if (typeof atual !== 'number') {
      anotar(`${ondeLabel}: \`${regra}\` perdeu o limite numérico (veio ${JSON.stringify(bruto)})`);
    } else if (atual > maximo) {
      anotar(`${ondeLabel}: \`${regra}\` foi afrouxada para ${atual}; o teto do kit é ${maximo}`);
    }
  }
}

const arquivoProducao = ['src/pedido/domain/pedido.ts', 'src/main.ts'].find((f) => existsSync(f));
const arquivoTeste = ['src/pedido/domain/pedido.spec.ts'].find((f) => existsSync(f));

if (arquivoProducao === undefined) {
  anotar('não achei arquivo de produção em src/ para resolver a configuração do ESLint');
} else {
  const cfg = configResolvida(arquivoProducao);
  if (cfg === null) anotar('`eslint --print-config` falhou: a configuração do ESLint está quebrada');
  else conferirRegras(cfg.rules ?? {}, REGRAS_PRODUCAO, 'produção');
}

if (arquivoTeste !== undefined) {
  const cfg = configResolvida(arquivoTeste);
  if (cfg !== null) conferirRegras(cfg.rules ?? {}, REGRAS_TESTE, 'testes');
}

// ─────────────────────────────────────────────────────────── demais gates

async function carregar(arquivo) {
  if (!existsSync(arquivo)) return null;
  try {
    const mod = await import(pathToFileURL(path.resolve(arquivo)).href);
    return mod.default ?? mod;
  } catch {
    return null;
  }
}

const jest = await carregar('jest.config.mjs');
if (jest === null) {
  anotar('jest.config.mjs ausente ou ilegível');
} else {
  const limites = jest.coverageThreshold?.global ?? {};
  for (const contador of ['branches', 'functions', 'lines', 'statements']) {
    const v = limites[contador];
    if (typeof v !== 'number') anotar(`cobertura: limite de \`${contador}\` sumiu`);
    else if (v < 100) anotar(`cobertura: \`${contador}\` foi afrouxado para ${v}%`);
  }
  const inclui = jest.collectCoverageFrom ?? [];
  if (!inclui.some((p) => String(p).includes('**/*.ts') && !String(p).startsWith('!'))) {
    anotar(
      'cobertura: `collectCoverageFrom` não inclui mais todo o código — ' +
        'arquivo sem teste some do relatório e a métrica passa a mentir',
    );
  }
}

const stryker = await carregar('stryker.config.mjs');
if (stryker === null) {
  anotar('stryker.config.mjs ausente ou ilegível');
} else {
  const quebra = stryker.thresholds?.break;
  if (typeof quebra !== 'number') anotar('mutação: `thresholds.break` sumiu — o build não reprova mais');
  else if (quebra < 100) anotar(`mutação: \`thresholds.break\` foi afrouxado para ${quebra}`);
}

if (!existsSync('.jscpd.json')) {
  anotar('.jscpd.json ausente');
} else {
  const jscpd = JSON.parse(readFileSync('.jscpd.json', 'utf8'));
  if (typeof jscpd.threshold !== 'number') anotar('duplicação: `threshold` sumiu');
  else if (jscpd.threshold > 0) anotar(`duplicação: \`threshold\` foi afrouxado para ${jscpd.threshold}`);
}

if (!existsSync('.dependency-cruiser.cjs')) {
  anotar('.dependency-cruiser.cjs ausente — a direção de dependência deixou de ser verificada');
} else {
  const texto = readFileSync('.dependency-cruiser.cjs', 'utf8');
  for (const nome of REGRAS_ARQUITETURA) {
    if (!texto.includes(`'${nome}'`)) anotar(`arquitetura: a regra \`${nome}\` sumiu`);
  }
  if (/severity:\s*'(warn|info)'/.test(texto)) {
    anotar("arquitetura: alguma regra virou 'warn' ou 'info' e deixou de reprovar o build");
  }
}

if (!existsSync('.ls-lint.yml')) anotar('.ls-lint.yml ausente — nomes deixaram de ser verificados');
if (!existsSync('.secretlintrc.json')) anotar('.secretlintrc.json ausente — segredos deixaram de ser varridos');
if (!existsSync('.prettierrc.json')) anotar('.prettierrc.json ausente');
if (!existsSync('tools/sem-atalho.mjs')) anotar('tools/sem-atalho.mjs ausente');
if (!existsSync('tools/contrato.mjs')) anotar('tools/contrato.mjs ausente');

// ─────────────────────────────────────────────────────────── scripts

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const scripts = pkg.scripts ?? {};

/**
 * Onde procurar cada gate: o executor `tools/gates.mjs`, quando existir, ou a
 * string do `gates:rapidos` para quem ainda encadeia com `&&`. Sem isto, tirar
 * um gate da lista do executor passaria despercebido.
 */
const executor = existsSync('tools/gates.mjs') ? readFileSync('tools/gates.mjs', 'utf8') : null;
const rapidos = scripts['gates:rapidos'] ?? '';
const ondeRoda = executor ?? rapidos;
const comoRoda = executor === null ? '`gates:rapidos`' : '`tools/gates.mjs`';

for (const nome of SCRIPTS_OBRIGATORIOS) {
  if (scripts[nome] === undefined) {
    anotar(`script \`${nome}\` sumiu do package.json`);
  } else if (!new RegExp(`script:\\s*'${nome}'|\\brun ${nome}\\b`).test(ondeRoda)) {
    anotar(`\`${nome}\` existe mas saiu de ${comoRoda} — deixou de rodar no laço local`);
  }
}
if (executor !== null && !/script:\s*'contrato'/.test(executor)) {
  anotar('`contrato` saiu de `tools/gates.mjs` — o gate de requisito deixou de rodar');
}
const mutacaoRoda =
  /script:\s*'mutation'/.test(executor ?? '') || (scripts.gates ?? '').includes('mutation');
if (!mutacaoRoda) {
  anotar('`mutation` saiu de `gates` — o teste de mutação deixou de rodar antes da entrega');
}
if (!/--at-least\s+100/.test(scripts.typecoverage ?? '')) {
  anotar('cobertura de tipos: `--at-least 100` foi afrouxado ou removido');
}

// ─────────────────────────────────────────────────────────── veredito

if (problemas.length === 0) {
  console.log(
    `gates-intactos: ${REGRAS_PRODUCAO.length + REGRAS_TESTE.length} regras de lint, ` +
      `${SCRIPTS_OBRIGATORIOS.length} scripts e 8 configurações conferidas — nenhuma afrouxada`,
  );
  process.exit(0);
}

console.error('gates afrouxados ou removidos:\n');
for (const p of problemas) console.error(`  - ${p}`);
console.error(
  `\n${problemas.length} problema(s). Apertar um limite é bem-vindo; afrouxar ou apagar\n` +
    `precisa de decisão registrada em PR, e deste arquivo atualizado junto.`,
);
process.exit(1);
