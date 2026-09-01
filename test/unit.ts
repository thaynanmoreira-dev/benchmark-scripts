#!/usr/bin/env node
/**
 * Testes de unidade das partes que o smoke test nao alcanca: parsing de
 * subject de merge, extracao de uso do stream, glob, rename e o mapeamento
 * do provider do GitHub (com fetch dublado, sem tocar a rede).
 *
 * Uso: node test/unit.ts
 */

import assert from "node:assert/strict";
import test from "node:test";

import { addUsage, extractText, extractUsage, parseJsonLoose } from "../src/lib/agent.ts";
import { normalizeRenamePath, parseNumstat } from "../src/lib/git.ts";
import { DEFAULT_EXCLUDES, globToRegExp, isTestFile, matchesAny } from "../src/lib/glob.ts";
import { github } from "../src/lib/providers/github.ts";
import { parseMergeSubject } from "../src/lib/providers/local-git.ts";
import { bareRepo } from "../src/lib/git.ts";
import { mulberry32, percentile, shuffle, stdev, wilson } from "../src/lib/stats.ts";

test("glob cobre duplo asterisco, asterisco e extensao", () => {
  assert.ok(globToRegExp("**/dist/**").test("pacotes/a/dist/index.js"));
  assert.ok(globToRegExp("**/*.snap").test("src/__snapshots__/a.snap"));
  assert.ok(!globToRegExp("src/*.ts").test("src/a/b.ts"));
  assert.ok(globToRegExp("src/*.ts").test("src/a.ts"));
});

test("excludes padrao tiram lockfile e build da metrica de tamanho", () => {
  const patterns = DEFAULT_EXCLUDES.map(globToRegExp);
  for (const noise of ["package-lock.json", "apps/api/dist/main.js", "docs/logo.svg"]) {
    assert.ok(matchesAny(noise, patterns), `deveria excluir ${noise}`);
  }
  assert.ok(!matchesAny("src/user/user.service.ts", patterns));
});

test("deteccao de arquivo de teste cobre varias convencoes", () => {
  for (const f of [
    "src/user/user.spec.ts",
    "src/user/user.test.tsx",
    "test/e2e/app.e2e-spec.ts",
    "src/__tests__/helper.js",
    "app/tests/test_login.py",
    "pkg/service_test.go",
  ]) {
    assert.ok(isTestFile(f), `deveria ser teste: ${f}`);
  }
  for (const f of ["src/user/user.service.ts", "src/latest/index.ts", "src/protest.ts"]) {
    assert.ok(!isTestFile(f), `nao deveria ser teste: ${f}`);
  }
});

test("rename do numstat resolve para o caminho de destino", () => {
  assert.equal(normalizeRenamePath("src/{antigo => novo}/f.ts"), "src/novo/f.ts");
  assert.equal(normalizeRenamePath("antigo.ts => novo.ts"), "novo.ts");
  assert.equal(normalizeRenamePath("src/simples.ts"), "src/simples.ts");
});

test("numstat marca binario sem contar linha", () => {
  const stats = parseNumstat("12\t3\tsrc/a.ts\n-\t-\tlogo.png\n", []);
  assert.equal(stats[0].additions, 12);
  assert.equal(stats[0].deletions, 3);
  assert.equal(stats[1].binary, true);
  assert.equal(stats[1].additions, 0);
});

test("subject de merge do Azure DevOps, do GitHub e de squash", () => {
  const azdo = parseMergeSubject("Merged PR 1234: corrige calculo de juros", "corpo");
  assert.equal(azdo.id, 1234);
  assert.equal(azdo.title, "corrige calculo de juros");

  const gh = parseMergeSubject(
    "Merge pull request #77 from org/feature",
    "adiciona endpoint de saldo\n\ndetalhes",
  );
  assert.equal(gh.id, 77);
  assert.equal(gh.title, "adiciona endpoint de saldo");
  assert.equal(gh.description, "detalhes");

  const squash = parseMergeSubject("feat: valida cpf na entrada (#42)", "");
  assert.equal(squash.id, 42);

  const solto = parseMergeSubject("ajuste rapido", "");
  assert.equal(solto.id, null);
  assert.equal(solto.title, "ajuste rapido");
});

test("extracao de texto aceita stream-json e texto puro", () => {
  const stream = [
    JSON.stringify({ message: { content: [{ type: "text", text: "parte um " }] } }),
    JSON.stringify({ message: { content: [{ type: "text", text: "parte dois" }] } }),
  ].join("\n");
  assert.equal(extractText(stream), "parte um parte dois");
  assert.equal(extractText("saida em texto puro"), "saida em texto puro");
});

test("uso: sem evento de resumo, os eventos parciais sao somados", () => {
  const stream = [
    JSON.stringify({ message: { usage: { input_tokens: 100, output_tokens: 20 } } }),
    JSON.stringify({
      message: { usage: { input_tokens: 50, output_tokens: 10, cache_read_input_tokens: 900 } },
    }),
  ].join("\n");
  const usage = extractUsage(stream);
  assert.equal(usage.inputTokens, 150);
  assert.equal(usage.outputTokens, 30);
  assert.equal(usage.cacheReadTokens, 900);
  assert.equal(usage.totalTokens, 1080);
  assert.equal(usage.basis, "somado");
  assert.equal(usage.samples, 2);
});

test("uso: evento de resumo manda, e nao e somado aos parciais que o precedem", () => {
  const stream = [
    JSON.stringify({ message: { usage: { input_tokens: 100, output_tokens: 20 } } }),
    JSON.stringify({ message: { usage: { input_tokens: 50, output_tokens: 10 } } }),
    JSON.stringify({
      type: "result",
      total_cost_usd: 0.42,
      usage: { input_tokens: 150, output_tokens: 30 },
    }),
  ].join("\n");
  const usage = extractUsage(stream);
  assert.equal(usage.totalTokens, 180, "o resumo ja e o acumulado; somar os parciais duplicaria");
  assert.equal(usage.costUsd, 0.42);
  assert.equal(usage.basis, "terminal");
});

test("uso: consumo repetido dentro do mesmo evento conta uma vez so", () => {
  // Forma real do evento final do Claude Code: os mesmos tokens aparecem em
  // `usage`, de novo em `usage.iterations[]` e mais uma vez em `modelUsage`
  // com as chaves em camelCase. Somar tudo multiplicava o consumo por 8.
  const resultadoReal = {
    type: "result",
    duration_api_ms: 2046,
    total_cost_usd: 0.0113365,
    usage: {
      input_tokens: 9,
      output_tokens: 48,
      cache_read_input_tokens: 23965,
      cache_creation_input_tokens: 3871,
      output_tokens_details: { thinking_tokens: 32 },
      cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 3871 },
      iterations: [
        {
          type: "message",
          input_tokens: 9,
          output_tokens: 48,
          cache_read_input_tokens: 23965,
          cache_creation_input_tokens: 3871,
        },
      ],
    },
    modelUsage: {
      "claude-haiku-4-5-20251001": {
        inputTokens: 918,
        outputTokens: 75,
        cacheReadInputTokens: 23965,
        cacheCreationInputTokens: 3871,
        costUSD: 0.0113365,
      },
    },
  };
  const usage = extractUsage(JSON.stringify(resultadoReal));
  assert.equal(usage.inputTokens, 9);
  assert.equal(usage.outputTokens, 48);
  assert.equal(usage.cacheReadTokens, 23965);
  assert.equal(usage.cacheWriteTokens, 3871);
  assert.equal(usage.totalTokens, 27893);
  assert.equal(usage.costUsd, 0.0113365);
  assert.equal(usage.samples, 1, "um evento de resumo e uma amostra, nao oito");
});

test("uso: CLI que da custo no resumo e tokens so nas mensagens usa os dois", () => {
  const stream = [
    JSON.stringify({ message: { usage: { input_tokens: 100, output_tokens: 20 } } }),
    JSON.stringify({ message: { usage: { input_tokens: 50, output_tokens: 10 } } }),
    JSON.stringify({ type: "result", total_cost_usd: 0.031 }),
  ].join("\n");
  const usage = extractUsage(stream);
  assert.equal(usage.totalTokens, 180, "o resumo sem tokens nao pode zerar a contagem");
  assert.equal(usage.costUsd, 0.031);
  assert.equal(usage.basis, "somado");
});

test("uso: turnos de reparo somam, porque sao invocacoes separadas do CLI", () => {
  const turno = (input: number, output: number, custo: number): string =>
    JSON.stringify({ type: "result", total_cost_usd: custo, usage: { input_tokens: input, output_tokens: output } });
  const t1 = extractUsage(turno(100, 20, 0.1));
  const t2 = extractUsage(turno(80, 15, 0.08));
  const total = addUsage(t1, t2);
  assert.equal(total.totalTokens, 215);
  assert.ok(Math.abs((total.costUsd ?? 0) - 0.18) < 1e-9);
});

test("uso ausente e reportado como ausente, nao como zero", () => {
  const usage = extractUsage("o agente so falou texto, sem contabilidade");
  assert.equal(usage.totalTokens, null);
  assert.equal(usage.costUsd, null);
  assert.equal(usage.basis, "nenhum");
  assert.equal(usage.source, "none");
});

test("JSON tolerante a cerca de codigo e a texto ao redor", () => {
  assert.deepEqual(parseJsonLoose('antes ```json\n{"ok":true}\n``` depois'), { ok: true });
  assert.deepEqual(parseJsonLoose('{"a":{"b":1}}'), { a: { b: 1 } });
  assert.equal(parseJsonLoose("sem json aqui"), null);
});

test("provider do GitHub descarta PR fechada sem merge", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify([
        {
          number: 10,
          title: "mergeada",
          body: "corpo",
          merged_at: "2026-01-02T00:00:00Z",
          closed_at: "2026-01-02T00:00:00Z",
          merge_commit_sha: "abc",
          html_url: "https://github.com/o/r/pull/10",
          base: { ref: "main", sha: "base10" },
          head: { ref: "f", sha: "head10" },
        },
        {
          number: 11,
          title: "fechada sem merge",
          body: null,
          merged_at: null,
          closed_at: "2026-01-03T00:00:00Z",
          merge_commit_sha: null,
          html_url: "https://github.com/o/r/pull/11",
          base: { ref: "main", sha: "base11" },
          head: { ref: "g", sha: "head11" },
        },
      ]),
      { status: 200, headers: { "content-type": "application/json" } },
    )) as typeof fetch;

  try {
    const prs = await github.listMergedPrs(
      { repoName: "r", git: bareRepo("/nao-usado"), org: "o" },
      { targetBranch: "refs/heads/main", max: 50 },
    );
    assert.equal(prs.length, 1);
    assert.equal(prs[0].id, 10);
    assert.equal(prs[0].headCommit, "head10");
    assert.equal(prs[0].targetCommit, "base10");
    assert.deepEqual(prs[0].fetchRefs, ["refs/pull/10/head"], "PR de fork precisa da ref");
  } finally {
    globalThis.fetch = original;
  }
});

test("percentil interpola e Wilson nao colapsa com n pequeno", () => {
  assert.equal(percentile([1, 2, 3, 4], 50), 2.5);
  assert.equal(percentile([5], 90), 5);
  const [lo, hi] = wilson(0, 3);
  assert.equal(lo, 0);
  assert.ok(hi > 0.5, "com 0 de 3 o teto ainda precisa ser alto");
});

test("desvio amostral e zero com menos de dois pontos", () => {
  assert.equal(stdev([4]), 0);
  assert.ok(stdev([1, 5]) > 2.8);
});

test("shuffle com a mesma seed produz a mesma ordem", () => {
  const items = Array.from({ length: 20 }, (_, i) => i);
  const a = shuffle(items, mulberry32(42));
  const b = shuffle(items, mulberry32(42));
  const c = shuffle(items, mulberry32(43));
  assert.deepEqual(a, b, "mesma seed precisa dar a mesma ordem de runs");
  assert.notDeepEqual(a, c);
  assert.deepEqual([...a].sort((x, y) => x - y), items);
});
