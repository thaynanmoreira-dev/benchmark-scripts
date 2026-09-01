#!/usr/bin/env node
/**
 * Roda os gates em paralelo e relata TODOS os problemas de uma vez.
 *
 * Encadear com `&&` tem dois custos. O primeiro é tempo: os gates são leituras
 * independentes, então esperar um pelo outro é desperdício puro. O segundo é
 * pior — parar no primeiro vermelho esconde os outros, e o agente descobre um
 * problema por rodada. Cada rodada dessas é uma invocação inteira do CLI, paga
 * em token. Relatar tudo junto troca cinco idas e voltas por uma.
 *
 * Uso:
 *   node tools/gates.mjs                 gates rápidos
 *   node tools/gates.mjs --com-mutacao   inclui a mutação no fim
 *   node tools/gates.mjs --serie         um de cada vez, para depurar
 *   node tools/gates.mjs -j 2            limita a concorrência
 */
import { spawn } from 'node:child_process';
import { availableParallelism } from 'node:os';

const args = process.argv.slice(2);
const flag = (n, d) => {
  const i = args.indexOf(n);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : d;
};

/**
 * O contrato vem primeiro e sozinho: sem requisito fechado, o resto não
 * importa. Os demais são leituras independentes e podem correr juntos.
 */
const CONTRATO = { nome: 'contrato', script: 'contrato' };

const PARALELOS = [
  { nome: 'formatação', script: 'format:check' },
  { nome: 'typecheck', script: 'typecheck' },
  { nome: 'cobertura de tipos', script: 'typecoverage' },
  { nome: 'lint', script: 'lint' },
  { nome: 'arquitetura', script: 'arch' },
  { nome: 'estrutura', script: 'estrutura' },
  { nome: 'halstead', script: 'halstead' },
  { nome: 'segredos', script: 'segredos' },
  { nome: 'sem-atalho', script: 'sem-atalho' },
  { nome: 'gates-intactos', script: 'gates-intactos' },
  { nome: 'código morto', script: 'deadcode' },
  { nome: 'duplicação', script: 'duplication' },
  { nome: 'testes', script: 'test' },
];

const MUTACAO = { nome: 'mutação', script: 'mutation' };

const serie = args.includes('--serie');
const comMutacao = args.includes('--com-mutacao');
const limite = serie ? 1 : Math.max(1, Number(flag('-j', String(Math.min(4, availableParallelism())))));

function rodar({ nome, script }) {
  const inicio = Date.now();
  return new Promise((resolve) => {
    const filho = spawn('npm', ['run', '--silent', script], {
      shell: process.platform === 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, FORCE_COLOR: '0' },
    });
    let saida = '';
    const juntar = (d) => {
      saida += d.toString();
    };
    filho.stdout.on('data', juntar);
    filho.stderr.on('data', juntar);
    filho.on('error', (e) => {
      resolve({ nome, ok: false, ms: Date.now() - inicio, saida: `falha ao executar: ${e.message}` });
    });
    filho.on('close', (codigo) => {
      resolve({ nome, ok: codigo === 0, ms: Date.now() - inicio, saida });
    });
  });
}

/** Executa com concorrência limitada, preservando a ordem do relatório. */
async function rodarTodos(gates, concorrencia) {
  const resultados = new Array(gates.length);
  let proximo = 0;
  const trabalhador = async () => {
    while (proximo < gates.length) {
      const meu = proximo++;
      process.stderr.write('.');
      resultados[meu] = await rodar(gates[meu]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concorrencia, gates.length) }, trabalhador));
  return resultados;
}

const ms = (n) => (n < 1000 ? `${n}ms` : `${(n / 1000).toFixed(1)}s`);

function relatar(resultados, decorrido) {
  const largura = Math.max(...resultados.map((r) => r.nome.length));
  console.log('');
  for (const r of resultados) {
    console.log(`  ${r.ok ? 'ok  ' : 'FALHOU'} ${r.nome.padEnd(largura)}  ${ms(r.ms).padStart(7)}`);
  }

  const falhas = resultados.filter((r) => !r.ok);
  const somaSerie = resultados.reduce((a, r) => a + r.ms, 0);
  console.log(
    `\n  ${resultados.length} gates em ${ms(decorrido)} ` +
      `(em série seriam ${ms(somaSerie)})`,
  );

  if (falhas.length === 0) return 0;

  for (const f of falhas) {
    console.error(`\n${'='.repeat(64)}\n${f.nome}\n${'='.repeat(64)}`);
    console.error(f.saida.trimEnd() || '(sem saída)');
  }
  console.error(
    `\n${falhas.length} de ${resultados.length} gates vermelhos: ` +
      `${falhas.map((f) => f.nome).join(', ')}.\n` +
      `Estão todos acima, de uma vez — conserte tudo antes de rodar de novo.`,
  );
  return 1;
}

const inicio = Date.now();

// O contrato roda sozinho e antes: sem requisito fechado, o resto não importa.
const doContrato = await rodar(CONTRATO);
if (!doContrato.ok) {
  console.error(doContrato.saida.trimEnd());
  console.error('\nO contrato da tarefa não fechou. Os outros gates olham o código; este');
  console.error('olha o requisito, e código certo pelo motivo errado passa em todos eles.');
  process.exit(1);
}

const lista = comMutacao ? [...PARALELOS, MUTACAO] : PARALELOS;
const resultados = await rodarTodos(lista, limite);
process.exit(relatar([doContrato, ...resultados], Date.now() - inicio));
