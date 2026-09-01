#!/usr/bin/env node
/**
 * Gate anti-atalho.
 *
 * Todo gate de qualidade tem uma porta dos fundos, e quem esta com pressa —
 * pessoa ou agente — acha a porta antes de achar a solucao. Silenciar a regra
 * e mais rapido do que baixar a complexidade, e o build fica verde mentindo.
 *
 * Este gate conta as portas. Em projeto novo, o numero tem de ser zero. Em
 * projeto existente, o numero so pode cair: a linha de base fica versionada em
 * .gates-baseline.json e qualquer aumento reprova.
 *
 * Uso:
 *   node tools/sem-atalho.mjs                 compara com a linha de base
 *   node tools/sem-atalho.mjs --strict        exige zero, ignora a linha de base
 *   node tools/sem-atalho.mjs --gravar        regrava a linha de base (revise no PR!)
 */
import { readFileSync, writeFileSync, existsSync, globSync } from 'node:fs';

const args = process.argv.slice(2);
const STRICT = args.includes('--strict');
const GRAVAR = args.includes('--gravar');
const BASELINE = '.gates-baseline.json';

/** Supressoes no codigo: cada uma desliga um gate para aquele trecho. */
const PADROES = [
  { id: 'eslint-disable', re: /\/[/*]\s*eslint-disable/g, gate: 'lint (complexidade, any, duplicacao)' },
  { id: 'ts-ignore', re: /@ts-ignore/g, gate: 'typecheck' },
  { id: 'ts-expect-error', re: /@ts-expect-error/g, gate: 'typecheck' },
  { id: 'ts-nocheck', re: /@ts-nocheck/g, gate: 'typecheck (arquivo inteiro)' },
  { id: 'istanbul-ignore', re: /istanbul\s+ignore/g, gate: 'cobertura' },
  { id: 'c8-ignore', re: /c8\s+ignore/g, gate: 'cobertura' },
  { id: 'stryker-disable', re: /Stryker\s+disable/gi, gate: 'mutacao' },
  { id: 'jscpd-ignore', re: /jscpd:ignore/g, gate: 'duplicacao' },
  { id: 'knip-ignore', re: /@(public|internal)\b|knip-ignore/g, gate: 'codigo morto' },
  { id: 'cast-any', re: /\bas\s+any\b/g, gate: 'proibicao de any' },
  { id: 'cast-unknown', re: /\bas\s+unknown\b/g, gate: 'proibicao de unknown' },
  { id: 'skip-teste', re: /\b(it|test|describe)\.(skip|todo)\b|\bx(it|describe)\(/g, gate: 'testes' },
];

/** Listas de exclusao nos arquivos de config: alargar a lista tambem e atalho. */
const EXCLUSOES = [
  { id: 'jest-coverage-exclude', arquivo: 'jest.config.mjs', re: /'!\S+'/g },
  { id: 'jscpd-ignore-list', arquivo: '.jscpd.json', re: /"[^"]*\*[^"]*"/g },
  { id: 'stryker-mutate-exclude', arquivo: 'stryker.config.mjs', re: /'!\S+'/g },
  { id: 'eslint-regra-desligada', arquivo: 'eslint.config.mjs', re: /:\s*'off'/g },
];

const contagem = {};
const ocorrencias = [];

const fontes = globSync(['src/**/*.ts'], { exclude: (p) => /node_modules/.test(p) });
for (const arquivo of fontes) {
  const texto = readFileSync(arquivo, 'utf8');
  const linhas = texto.split('\n');
  for (const { id, re, gate } of PADROES) {
    for (const m of texto.matchAll(re)) {
      const linha = texto.slice(0, m.index).split('\n').length;
      contagem[id] = (contagem[id] ?? 0) + 1;
      ocorrencias.push({ id, gate, arquivo, linha, trecho: (linhas[linha - 1] ?? '').trim().slice(0, 90) });
    }
  }
}

for (const { id, arquivo, re } of EXCLUSOES) {
  if (!existsSync(arquivo)) continue;
  const n = [...readFileSync(arquivo, 'utf8').matchAll(re)].length;
  if (n > 0) contagem[id] = n;
}

if (GRAVAR) {
  writeFileSync(BASELINE, `${JSON.stringify(contagem, null, 2)}\n`, 'utf8');
  console.log(`linha de base gravada em ${BASELINE}:`);
  console.log(JSON.stringify(contagem, null, 2));
  process.exit(0);
}

const base = STRICT ? {} : existsSync(BASELINE) ? JSON.parse(readFileSync(BASELINE, 'utf8')) : {};
const violacoes = [];

for (const [id, n] of Object.entries(contagem)) {
  const permitido = base[id] ?? 0;
  if (n > permitido) violacoes.push({ id, n, permitido });
}

for (const v of violacoes) {
  console.error(
    `${v.id}: ${v.n} ocorrencia(s), permitido ${v.permitido}. ` +
      `Este atalho desliga o gate de ${PADROES.find((p) => p.id === v.id)?.gate ?? 'configuracao'}.`,
  );
  for (const o of ocorrencias.filter((x) => x.id === v.id).slice(0, 5)) {
    console.error(`   ${o.arquivo}:${o.linha}  ${o.trecho}`);
  }
}

const total = Object.values(contagem).reduce((a, b) => a + b, 0);
if (violacoes.length === 0) {
  console.log(`sem-atalho: ${total} supressao(oes) conhecida(s), nenhuma nova — ok`);
  process.exit(0);
}
console.error(
  `\nsem-atalho: ${violacoes.length} tipo(s) de atalho acima da linha de base.\n` +
    `Baixe a complexidade, escreva o teste ou tipe a fronteira. Se a supressao for\n` +
    `mesmo necessaria, ela precisa de justificativa no PR e de \`--gravar\` deliberado.`,
);
process.exit(1);
