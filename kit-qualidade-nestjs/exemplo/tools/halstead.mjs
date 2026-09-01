#!/usr/bin/env node
/**
 * Gate de dificuldade de Halstead por funcao.
 *
 * Nao existe ferramenta viva no ecossistema Node que meca Halstead: escomplex,
 * complexity-report e typhonjs-escomplex estao parados desde 2022, e ts-complex
 * devolve resultado vazio ou errado em TypeScript moderno. Entao a metrica fica
 * aqui, com a convencao de contagem explicita e versionada — que e o que importa,
 * porque um limiar de Halstead so significa alguma coisa se a contagem for estavel.
 *
 * Convencao adotada (documente qualquer mudanca, ela move todos os numeros):
 *   operandos  identificadores, literais, this, super, true, false, null
 *   operadores todo o resto dos tokens: pontuacao e palavras-chave
 *   D = (n1 / 2) * (N2 / n2)
 *        n1 operadores distintos   N1 operadores totais
 *        n2 operandos distintos    N2 operandos totais
 *
 * Uso: node tools/halstead.mjs [--max 80] [--json] [<glob de arquivos>...]
 */
import { readFileSync } from 'node:fs';
import { globSync } from 'node:fs';
import ts from 'typescript';

const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const MAX = Number(flag('--max', '80'));
const JSON_OUT = args.includes('--json');
const padroes = args.filter((a) => !a.startsWith('--') && a !== String(MAX));
const arquivos = globSync(padroes.length ? padroes : ['src/**/*.ts'], {
  exclude: (p) => /node_modules|\.spec\.ts$|\.e2e-spec\.ts$|\.d\.ts$/.test(p),
});

const OPERANDOS = new Set([
  ts.SyntaxKind.Identifier,
  ts.SyntaxKind.PrivateIdentifier,
  ts.SyntaxKind.NumericLiteral,
  ts.SyntaxKind.BigIntLiteral,
  ts.SyntaxKind.StringLiteral,
  ts.SyntaxKind.NoSubstitutionTemplateLiteral,
  ts.SyntaxKind.TemplateHead,
  ts.SyntaxKind.TemplateMiddle,
  ts.SyntaxKind.TemplateTail,
  ts.SyntaxKind.RegularExpressionLiteral,
  ts.SyntaxKind.ThisKeyword,
  ts.SyntaxKind.SuperKeyword,
  ts.SyntaxKind.TrueKeyword,
  ts.SyntaxKind.FalseKeyword,
  ts.SyntaxKind.NullKeyword,
]);

const IGNORADOS = new Set([
  ts.SyntaxKind.EndOfFileToken,
  ts.SyntaxKind.SingleLineCommentTrivia,
  ts.SyntaxKind.MultiLineCommentTrivia,
  ts.SyntaxKind.NewLineTrivia,
  ts.SyntaxKind.WhitespaceTrivia,
]);

function dificuldade(texto) {
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, true, ts.LanguageVariant.Standard, texto);
  const operadores = new Map();
  const operandos = new Map();
  let N1 = 0;
  let N2 = 0;

  let k = scanner.scan();
  while (k !== ts.SyntaxKind.EndOfFileToken) {
    if (!IGNORADOS.has(k)) {
      if (OPERANDOS.has(k)) {
        const t = scanner.getTokenText();
        operandos.set(t, (operandos.get(t) ?? 0) + 1);
        N2++;
      } else {
        operadores.set(k, (operadores.get(k) ?? 0) + 1);
        N1++;
      }
    }
    k = scanner.scan();
  }

  const n1 = operadores.size;
  const n2 = operandos.size;
  if (n1 === 0 || n2 === 0) return { D: 0, n1, n2, N1, N2 };
  return { D: (n1 / 2) * (N2 / n2), n1, n2, N1, N2 };
}

function nomeDe(node, origem) {
  if (node.name) return node.name.getText(origem);
  const pai = node.parent;
  if (pai && ts.isVariableDeclaration(pai) && pai.name) return pai.name.getText(origem);
  if (pai && ts.isPropertyAssignment(pai)) return pai.name.getText(origem);
  return '(anonima)';
}

const ehFuncao = (n) =>
  ts.isFunctionDeclaration(n) ||
  ts.isMethodDeclaration(n) ||
  ts.isFunctionExpression(n) ||
  ts.isArrowFunction(n) ||
  ts.isConstructorDeclaration(n) ||
  ts.isGetAccessor(n) ||
  ts.isSetAccessor(n);

const achados = [];
for (const arquivo of arquivos) {
  const origem = ts.createSourceFile(
    arquivo,
    readFileSync(arquivo, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  );
  const visitar = (node) => {
    if (ehFuncao(node) && node.body) {
      const m = dificuldade(node.getText(origem));
      const linha = origem.getLineAndCharacterOfPosition(node.getStart(origem)).line + 1;
      achados.push({ arquivo, linha, nome: nomeDe(node, origem), ...m });
    }
    ts.forEachChild(node, visitar);
  };
  ts.forEachChild(origem, visitar);
}

const violacoes = achados.filter((a) => a.D >= MAX).sort((a, b) => b.D - a.D);

if (JSON_OUT) {
  console.log(JSON.stringify({ max: MAX, analisadas: achados.length, violacoes }, null, 2));
} else {
  for (const v of violacoes) {
    console.error(
      `${v.arquivo}:${v.linha}  ${v.nome}  dificuldade de Halstead ${v.D.toFixed(1)} (limite < ${MAX})`,
    );
  }
  const pior = achados.reduce((m, a) => Math.max(m, a.D), 0);
  console.log(
    `halstead: ${achados.length} funcao(oes), pior dificuldade ${pior.toFixed(1)}, limite < ${MAX}` +
      (violacoes.length ? ` — ${violacoes.length} violacao(oes)` : ' — ok'),
  );
}

process.exit(violacoes.length > 0 ? 1 : 0);
