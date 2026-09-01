#!/usr/bin/env node
/**
 * Agente falso usado pelo smoke test. Nao chama modelo nenhum.
 *
 * Ele reage ao overlay do arm que esta no worktree, para que o smoke test
 * produza a mesma forma de resultado que um benchmark real produziria:
 *
 *   sem steering            implementa, inventa arquivo fora do escopo
 *   com tech.md             implementa, inventa menos
 *   com grill.md            implementa, nao inventa nada
 *   prompt de reparo        conserta o gate vermelho
 *
 * Custo simulado cresce com o numero de arquivos escritos, para o relatorio
 * ter o que agregar.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const prompt = readFileSync(0, "utf8");
const cwd = process.cwd();
const has = (rel) => existsSync(path.join(cwd, rel));
const write = (rel, body) => {
  mkdirSync(path.dirname(path.join(cwd, rel)), { recursive: true });
  writeFileSync(path.join(cwd, rel), body, "utf8");
};

const RECIPES = [
  {
    match: /helper de soma/i,
    files: { "src/user/add.ts": "export function add(a: number, b: number): number {\n  return a + b;\n}\n" },
  },
  {
    match: /servico de pedidos/i,
    files: {
      "src/order/consts.ts": "export const TAXA = 2;\n",
      "src/order/order.service.ts":
        "export class OrderService {\n  total(valores: number[]): number {\n    return valores.reduce((a, b) => a + b, 0);\n  }\n}\n",
    },
  },
  {
    match: /modulo grande/i,
    files: {
      "src/order/big.ts":
        Array.from({ length: 60 }, (_, i) => `export const big${i + 1} = ${i + 1};`).join("\n") + "\n",
    },
  },
];

let written = 0;

if (/^# Reparo/m.test(prompt)) {
  write(".repair-marker", "gate consertado\n");
  written = 1;
} else {
  for (const recipe of RECIPES) {
    if (!recipe.match.test(prompt)) continue;
    for (const [rel, body] of Object.entries(recipe.files)) {
      write(rel, body);
      written++;
    }
  }
  const disciplina = has(".kiro/steering/grill.md") ? 2 : has(".kiro/steering/tech.md") ? 1 : 0;
  if (disciplina === 0) {
    write("src/extra/ninguem-pediu.ts", "export const featureNaoSolicitada = true;\n");
    write("docs/README-novo.md", "# documentacao que ninguem pediu\n");
    written += 2;
  } else if (disciplina === 1) {
    write("src/extra/ninguem-pediu.ts", "export const featureNaoSolicitada = true;\n");
    written++;
  }
}

const inputTokens = 800 + written * 400;
const outputTokens = 150 + written * 120;
process.stdout.write(
  JSON.stringify({
    type: "message",
    message: {
      content: [{ type: "text", text: `Escrevi ${written} arquivo(s).` }],
      usage: { input_tokens: inputTokens, output_tokens: outputTokens },
    },
  }) + "\n",
);
process.stdout.write(
  JSON.stringify({ type: "result", total_cost_usd: Number(((inputTokens + outputTokens) * 3e-6).toFixed(6)) }) + "\n",
);
