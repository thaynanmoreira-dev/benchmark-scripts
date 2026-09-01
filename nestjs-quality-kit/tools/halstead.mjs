#!/usr/bin/env node
/**
 * Halstead difficulty gate, per function.
 *
 * No maintained tool in the Node ecosystem measures Halstead: escomplex,
 * complexity-report and typhonjs-escomplex have been dormant since 2022, and
 * ts-complex returns empty or wrong results on modern TypeScript. So the metric
 * lives here, with an explicit, version-controlled counting convention — which
 * is what matters, because a Halstead threshold only means something when the
 * counting is stable.
 *
 * The convention (document any change, it moves every number):
 *   operands   identifiers, literals, this, super, true, false, null
 *   operators  every other token: punctuation and keywords
 *   D = (n1 / 2) * (N2 / n2)
 *        n1 distinct operators   N1 total operators
 *        n2 distinct operands    N2 total operands
 *
 * Usage: node tools/halstead.mjs [--max 80] [--json] [<file globs>...]
 */
import { readFileSync, globSync } from 'node:fs';
import ts from 'typescript';

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
};
const MAX = Number(flag('--max', '80'));
const AS_JSON = args.includes('--json');
const patterns = args.filter((a) => !a.startsWith('--') && a !== String(MAX));
const files = globSync(patterns.length ? patterns : ['src/**/*.ts'], {
  exclude: (p) => /node_modules|\.spec\.ts$|\.e2e-spec\.ts$|\.d\.ts$/.test(p),
});

const OPERANDS = new Set([
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

const IGNORED = new Set([
  ts.SyntaxKind.EndOfFileToken,
  ts.SyntaxKind.SingleLineCommentTrivia,
  ts.SyntaxKind.MultiLineCommentTrivia,
  ts.SyntaxKind.NewLineTrivia,
  ts.SyntaxKind.WhitespaceTrivia,
]);

function difficulty(text) {
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, true, ts.LanguageVariant.Standard, text);
  const operators = new Map();
  const operands = new Map();
  let N1 = 0;
  let N2 = 0;

  let kind = scanner.scan();
  while (kind !== ts.SyntaxKind.EndOfFileToken) {
    if (!IGNORED.has(kind)) {
      if (OPERANDS.has(kind)) {
        const token = scanner.getTokenText();
        operands.set(token, (operands.get(token) ?? 0) + 1);
        N2++;
      } else {
        operators.set(kind, (operators.get(kind) ?? 0) + 1);
        N1++;
      }
    }
    kind = scanner.scan();
  }

  const n1 = operators.size;
  const n2 = operands.size;
  if (n1 === 0 || n2 === 0) return { D: 0, n1, n2, N1, N2 };
  return { D: (n1 / 2) * (N2 / n2), n1, n2, N1, N2 };
}

function nameOf(node, source) {
  if (node.name) return node.name.getText(source);
  const parent = node.parent;
  if (parent && ts.isVariableDeclaration(parent) && parent.name) return parent.name.getText(source);
  if (parent && ts.isPropertyAssignment(parent)) return parent.name.getText(source);
  return '(anonymous)';
}

const isFunction = (n) =>
  ts.isFunctionDeclaration(n) ||
  ts.isMethodDeclaration(n) ||
  ts.isFunctionExpression(n) ||
  ts.isArrowFunction(n) ||
  ts.isConstructorDeclaration(n) ||
  ts.isGetAccessor(n) ||
  ts.isSetAccessor(n);

const found = [];
for (const file of files) {
  const source = ts.createSourceFile(
    file,
    readFileSync(file, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  );
  const visit = (node) => {
    if (isFunction(node) && node.body) {
      const metrics = difficulty(node.getText(source));
      const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
      found.push({ file, line, name: nameOf(node, source), ...metrics });
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(source, visit);
}

const violations = found.filter((f) => f.D >= MAX).sort((a, b) => b.D - a.D);

if (AS_JSON) {
  console.log(JSON.stringify({ max: MAX, analyzed: found.length, violations }, null, 2));
} else {
  for (const v of violations) {
    console.error(
      `${v.file}:${v.line}  ${v.name}  Halstead difficulty ${v.D.toFixed(1)} (limit < ${MAX})`,
    );
  }
  const worst = found.reduce((m, f) => Math.max(m, f.D), 0);
  console.log(
    `halstead: ${found.length} function(s), worst difficulty ${worst.toFixed(1)}, limit < ${MAX}` +
      (violations.length ? ` — ${violations.length} violation(s)` : ' — ok'),
  );
}

process.exit(violations.length > 0 ? 1 : 0);
