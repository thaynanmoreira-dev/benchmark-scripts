#!/usr/bin/env node
/**
 * Gate de contrato de tarefa.
 *
 * O agente e otimo em preencher lacuna. Esse e o problema: quando a tarefa nao
 * diz qual e o arredondamento, ele escolhe um, escreve o teste que confirma a
 * escolha dele, e entrega verde. Todo gate de qualidade passa. O comportamento
 * esta errado do mesmo jeito, e ninguem descobre ate o incidente.
 *
 * Este gate nao verifica codigo. Verifica se alguem separou, por escrito e
 * antes de implementar, o que a tarefa DIZ do que alguem ACHOU. E reprova
 * enquanto sobrar pergunta em aberto ou suposicao bloqueante sem resposta.
 *
 * Uso:
 *   node tools/contrato.mjs --novo <slug>   cria o contrato a partir do modelo
 *   node tools/contrato.mjs                 valida o contrato do branch atual
 *   node tools/contrato.mjs <caminho>       valida um contrato especifico
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

const DIR = '.kiro/contratos';

const SECOES = [
  'Tarefa',
  'Fatos',
  'Suposições',
  'Perguntas em aberto',
  'Fora de escopo',
  'Como vou provar que funcionou',
];

const MODELO = (slug) => `# Contrato: ${slug}

Preencha antes de escrever código. Enquanto sobrar pergunta em aberto ou
suposição bloqueante sem resposta, este contrato reprova e a tarefa não começa.

## Tarefa

Uma frase, com suas palavras, do que precisa existir ao final.

Origem: <link do card, issue ou conversa>

## Fatos

O que a tarefa ou o código **afirmam**. Todo fato precisa de fonte verificável:
\`arquivo:linha\`, nome de teste, ou trecho citado do card. Sem fonte não é fato,
é suposição — desça para a seção de baixo.

- [F1] ... — fonte: <arquivo:linha | card | teste>

## Suposições

O que você está preenchendo por conta própria. Classifique cada uma:

- **segura** — se estiver errada, o conserto é barato e nada quebra em produção.
- **bloqueante** — se estiver errada, o que você entregar está errado.

Suposição bloqueante precisa virar fato antes de implementar. Pergunte, e
registre a resposta com \`RESOLVIDA:\` mais quem respondeu e quando.

- [S1] (segura) ...
- [S2] (bloqueante) ... — RESOLVIDA: <resposta, quem, quando>

## Perguntas em aberto

O que você não consegue responder sozinho. **Enquanto houver item aqui, não
implemente** — leve ao autor da tarefa. Sem item, escreva \`(nenhuma)\`.

- (nenhuma)

## Fora de escopo

O que seria razoável fazer junto e você **não** vai fazer nesta tarefa.

- ...

## Como vou provar que funcionou

O teste que vai falhar hoje e passar no fim. Não "vou testar": qual caso.

- ...
`;

// ─────────────────────────────────────────────────────────── util

function branchAtual() {
  try {
    return execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return '';
  }
}

/** `feat/PED-123-desconto` vira `feat-ped-123-desconto`. */
function slugDe(texto) {
  return texto
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function secoesDe(texto) {
  const mapa = new Map();
  let atual = null;
  for (const linha of texto.split('\n')) {
    const cabecalho = linha.match(/^##\s+(.+?)\s*$/);
    if (cabecalho) {
      atual = cabecalho[1];
      mapa.set(atual, []);
      continue;
    }
    if (atual !== null) mapa.get(atual).push(linha);
  }
  return mapa;
}

/**
 * Itens de verdade da lista.
 *
 * Descarta o que ficou do modelo: linha com reticência ou com <placeholder> é
 * instrução para preencher, não conteúdo preenchido. Descarta também a linha
 * que começa em negrito, que no modelo é explicação de vocabulário.
 */
function itensReais(linhas) {
  return linhas
    .map((l) => l.trim())
    .filter((l) => l.startsWith('- '))
    .map((l) => l.slice(2).trim())
    .filter(
      (l) =>
        l.length > 0 &&
        !l.includes('...') &&
        !/<[^>]+>/.test(l) &&
        !l.startsWith('**'),
    );
}

// ─────────────────────────────────────────────────────────── validação

function validar(arquivo) {
  const texto = readFileSync(arquivo, 'utf8');
  const secoes = secoesDe(texto);
  const problemas = [];

  for (const nome of SECOES) {
    if (!secoes.has(nome)) problemas.push(`falta a seção "## ${nome}"`);
  }
  if (problemas.length > 0) return problemas;

  // Tarefa: precisa de uma frase que não seja o texto do modelo
  const tarefa = secoes
    .get('Tarefa')
    .join(' ')
    .replace(/Origem:.*/s, '')
    .trim();
  if (tarefa.length === 0 || tarefa.startsWith('Uma frase, com suas palavras')) {
    problemas.push('a seção "Tarefa" continua com o texto do modelo');
  }
  if (!/Origem:\s*\S/.test(texto) || /Origem:\s*<link/.test(texto)) {
    problemas.push('a origem da tarefa não foi preenchida: aponte o card, a issue ou a conversa');
  }

  // Fatos: cada um precisa de fonte
  const fatos = itensReais(secoes.get('Fatos'));
  if (fatos.length === 0) {
    problemas.push('nenhum fato registrado: o que a tarefa e o código realmente afirmam?');
  }
  for (const fato of fatos) {
    if (!/—\s*fonte:\s*\S/i.test(fato) && !/\bfonte:\s*\S/i.test(fato)) {
      problemas.push(`fato sem fonte verificável: "${fato.slice(0, 70)}"`);
    } else if (/fonte:\s*</.test(fato)) {
      problemas.push(`fato com fonte de modelo, não preenchida: "${fato.slice(0, 70)}"`);
    }
  }

  // Suposições bloqueantes precisam estar resolvidas
  for (const sup of itensReais(secoes.get('Suposições'))) {
    const bloqueante = /\(bloqueante\)/i.test(sup);
    const classificada = bloqueante || /\(segura\)/i.test(sup);
    if (!classificada) {
      problemas.push(`suposição sem classificação (segura|bloqueante): "${sup.slice(0, 70)}"`);
      continue;
    }
    if (!bloqueante) continue;
    const resolvida = /RESOLVIDA:\s*\S/.test(sup) && !/RESOLVIDA:\s*</.test(sup);
    if (!resolvida) {
      problemas.push(
        `suposição BLOQUEANTE sem resposta: "${sup.slice(0, 70)}"\n` +
          `     Pergunte a quem pediu a tarefa e registre com RESOLVIDA: quem respondeu e quando.`,
      );
    }
  }

  // Perguntas em aberto travam a tarefa
  const perguntas = itensReais(secoes.get('Perguntas em aberto')).filter(
    (p) => !/^\(nenhuma\)$/i.test(p),
  );
  for (const p of perguntas) {
    problemas.push(`pergunta em aberto: "${p.slice(0, 70)}"`);
  }

  if (itensReais(secoes.get('Fora de escopo')).length === 0) {
    problemas.push(
      'nada em "Fora de escopo": escreva o que seria razoável fazer junto e você não vai fazer',
    );
  }
  if (itensReais(secoes.get('Como vou provar que funcionou')).length === 0) {
    problemas.push('nada em "Como vou provar que funcionou": qual teste falha hoje e passa no fim?');
  }

  return problemas;
}

// ─────────────────────────────────────────────────────────── main

const args = process.argv.slice(2);
const iNovo = args.indexOf('--novo');

if (iNovo >= 0) {
  const slug = slugDe(args[iNovo + 1] || branchAtual()) || 'tarefa';
  const destino = path.join(DIR, `${slug}.md`);
  if (existsSync(destino)) {
    console.error(`já existe: ${destino}`);
    process.exit(1);
  }
  mkdirSync(DIR, { recursive: true });
  writeFileSync(destino, MODELO(slug), 'utf8');
  console.log(`contrato criado em ${destino}`);
  console.log('Preencha antes de escrever código. Depois: npm run contrato');
  process.exit(0);
}

const explicito = args.find((a) => !a.startsWith('--'));
const doBranch = path.join(DIR, `${slugDe(branchAtual())}.md`);
let arquivo = explicito ?? (existsSync(doBranch) ? doBranch : null);

if (arquivo === null && existsSync(DIR)) {
  const candidatos = readdirSync(DIR).filter((f) => f.endsWith('.md'));
  if (candidatos.length === 1) arquivo = path.join(DIR, candidatos[0]);
}

if (arquivo === null || !existsSync(arquivo)) {
  console.error(
    `Nenhum contrato de tarefa para o branch "${branchAtual() || '(sem git)'}".\n\n` +
      `Antes de escrever código, separe o que a tarefa DIZ do que você ACHOU:\n\n` +
      `    node tools/contrato.mjs --novo ${slugDe(branchAtual()) || '<slug>'}\n\n` +
      `Leva dois minutos e é o único gate que pega requisito faltando — todos os\n` +
      `outros olham o código, e código errado pelo motivo certo passa em todos.`,
  );
  process.exit(1);
}

const problemas = validar(arquivo);
if (problemas.length === 0) {
  console.log(`contrato: ${arquivo} — completo, sem pergunta em aberto`);
  process.exit(0);
}

console.error(`contrato incompleto: ${arquivo}\n`);
for (const p of problemas) console.error(`  - ${p}`);
console.error(
  `\n${problemas.length} pendência(s). Enquanto houver pergunta em aberto ou suposição\n` +
    `bloqueante sem resposta, a tarefa não começa: pergunte a quem pediu.`,
);
process.exit(1);
