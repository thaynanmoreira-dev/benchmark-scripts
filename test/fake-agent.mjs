#!/usr/bin/env node
/**
 * Fake agent used by the smoke test. It calls no model at all.
 *
 * It reacts to the arm overlay present in the worktree, so that the smoke test
 * produces the same shape of result a real benchmark would:
 *
 *   no steering             implements, invents a file outside the scope
 *   with tech.md            implements, invents less
 *   with grill.md           implements, invents nothing
 *   repair prompt           fixes the red gate
 *
 * Simulated cost grows with the number of files written, so the report has
 * something to aggregate.
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
    match: /sum helper/i,
    files: { "src/user/add.ts": "export function add(a: number, b: number): number {\n  return a + b;\n}\n" },
  },
  {
    match: /order service/i,
    files: {
      "src/order/consts.ts": "export const RATE = 2;\n",
      "src/order/order.service.ts":
        "export class OrderService {\n  total(values: number[]): number {\n    return values.reduce((a, b) => a + b, 0);\n  }\n}\n",
    },
  },
  {
    match: /large constants module/i,
    files: {
      "src/order/big.ts":
        Array.from({ length: 60 }, (_, i) => `export const big${i + 1} = ${i + 1};`).join("\n") + "\n",
    },
  },
];

let written = 0;

if (/^# Repair/m.test(prompt)) {
  write(".repair-marker", "gate fixed\n");
  written = 1;
} else {
  for (const recipe of RECIPES) {
    if (!recipe.match.test(prompt)) continue;
    for (const [rel, body] of Object.entries(recipe.files)) {
      write(rel, body);
      written++;
    }
  }
  const discipline = has(".kiro/steering/grill.md") ? 2 : has(".kiro/steering/tech.md") ? 1 : 0;
  if (discipline === 0) {
    write("src/extra/nobody-asked.ts", "export const unrequestedFeature = true;\n");
    write("docs/README-new.md", "# documentation nobody asked for\n");
    written += 2;
  } else if (discipline === 1) {
    write("src/extra/nobody-asked.ts", "export const unrequestedFeature = true;\n");
    written++;
  }
}

const inputTokens = 800 + written * 400;
const outputTokens = 150 + written * 120;
process.stdout.write(
  JSON.stringify({
    type: "message",
    message: {
      content: [{ type: "text", text: `Wrote ${written} file(s).` }],
      usage: { input_tokens: inputTokens, output_tokens: outputTokens },
    },
  }) + "\n",
);
process.stdout.write(
  JSON.stringify({ type: "result", total_cost_usd: Number(((inputTokens + outputTokens) * 3e-6).toFixed(6)) }) + "\n",
);
