#!/usr/bin/env node
/**
 * Unit tests for the parts the smoke test does not reach: parsing of
 * merge subjects, usage extraction from the stream, glob, rename and the
 * GitHub provider mapping (with a stubbed fetch, never touching the network).
 *
 * Usage: node test/unit.ts
 */

import assert from "node:assert/strict";
import test from "node:test";

import { addUsage, extractText, extractUsage, parseJsonLoose } from "../src/lib/agent.ts";
import { normalizeRenamePath, parseNumstat } from "../src/lib/git.ts";
import { DEFAULT_EXCLUDES, globToRegExp, isTestFile, matchesAny } from "../src/lib/glob.ts";
import { github } from "../src/lib/providers/github.ts";
import { parseMergeSubject } from "../src/lib/providers/local-git.ts";
import { bareRepo } from "../src/lib/git.ts";
import { mcnemar, mulberry32, percentile, shuffle, stdev, wilson } from "../src/lib/stats.ts";

test("glob cobre duplo asterisco, asterisco e extensao", () => {
  assert.ok(globToRegExp("**/dist/**").test("pacotes/a/dist/index.js"));
  assert.ok(globToRegExp("**/*.snap").test("src/__snapshots__/a.snap"));
  assert.ok(!globToRegExp("src/*.ts").test("src/a/b.ts"));
  assert.ok(globToRegExp("src/*.ts").test("src/a.ts"));
});

test("the default excludes keep lockfiles and builds out of the size metric", () => {
  const patterns = DEFAULT_EXCLUDES.map(globToRegExp);
  for (const noise of ["package-lock.json", "apps/api/dist/main.js", "docs/logo.svg"]) {
    assert.ok(matchesAny(noise, patterns), `deveria excluir ${noise}`);
  }
  assert.ok(!matchesAny("src/user/user.service.ts", patterns));
});

test("test-file detection covers several conventions", () => {
  for (const f of [
    "src/user/user.spec.ts",
    "src/user/user.test.tsx",
    "test/e2e/app.e2e-spec.ts",
    "src/__tests__/helper.js",
    "app/tests/test_login.py",
    "pkg/service_test.go",
  ]) {
    assert.ok(isTestFile(f), `should be a test: ${f}`);
  }
  for (const f of ["src/user/user.service.ts", "src/latest/index.ts", "src/protest.ts"]) {
    assert.ok(!isTestFile(f), `should not be a test: ${f}`);
  }
});

test("a numstat rename resolves to the destination path", () => {
  assert.equal(normalizeRenamePath("src/{old => new}/f.ts"), "src/new/f.ts");
  assert.equal(normalizeRenamePath("old.ts => new.ts"), "new.ts");
  assert.equal(normalizeRenamePath("src/simples.ts"), "src/simples.ts");
});

test("numstat marks a binary without counting lines", () => {
  const stats = parseNumstat("12\t3\tsrc/a.ts\n-\t-\tlogo.png\n", []);
  assert.equal(stats[0].additions, 12);
  assert.equal(stats[0].deletions, 3);
  assert.equal(stats[1].binary, true);
  assert.equal(stats[1].additions, 0);
});

test("merge subjects from Azure DevOps, from GitHub and from a squash", () => {
  const azdo = parseMergeSubject("Merged PR 1234: fix interest calculation", "body");
  assert.equal(azdo.id, 1234);
  assert.equal(azdo.title, "fix interest calculation");

  const gh = parseMergeSubject(
    "Merge pull request #77 from org/feature",
    "add balance endpoint\n\ndetails",
  );
  assert.equal(gh.id, 77);
  assert.equal(gh.title, "add balance endpoint");
  assert.equal(gh.description, "details");

  const squash = parseMergeSubject("feat: validate the id on input (#42)", "");
  assert.equal(squash.id, 42);

  const loose = parseMergeSubject("quick fix", "");
  assert.equal(loose.id, null);
  assert.equal(loose.title, "quick fix");
});

test("text extraction accepts stream-json and plain text", () => {
  const stream = [
    JSON.stringify({ message: { content: [{ type: "text", text: "parte um " }] } }),
    JSON.stringify({ message: { content: [{ type: "text", text: "parte dois" }] } }),
  ].join("\n");
  assert.equal(extractText(stream), "parte um parte dois");
  assert.equal(extractText("out em texto puro"), "out em texto puro");
});

test("usage: with no summary event, partial events are summed", () => {
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
  assert.equal(usage.basis, "summed");
  assert.equal(usage.samples, 2);
});

test("usage: the summary event wins, and is not summed with the partials before it", () => {
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
  assert.equal(usage.totalTokens, 180, "the summary is already cumulative; summing the partials would double it");
  assert.equal(usage.costUsd, 0.42);
  assert.equal(usage.basis, "terminal");
});

test("usage: repeated consumption inside one event counts only once", () => {
  // Real shape of the Claude Code final event: the same tokens appear in
  // `usage`, again in `usage.iterations[]` and once more in `modelUsage`
  // with camelCase keys. Summing everything multiplied consumption by 8.
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
  assert.equal(usage.samples, 1, "one summary event is one sample, not eight");
});

test("usage: a CLI giving cost in the summary and tokens only in messages uses both", () => {
  const stream = [
    JSON.stringify({ message: { usage: { input_tokens: 100, output_tokens: 20 } } }),
    JSON.stringify({ message: { usage: { input_tokens: 50, output_tokens: 10 } } }),
    JSON.stringify({ type: "result", total_cost_usd: 0.031 }),
  ].join("\n");
  const usage = extractUsage(stream);
  assert.equal(usage.totalTokens, 180, "a summary with no tokens must not zero the count");
  assert.equal(usage.costUsd, 0.031);
  assert.equal(usage.basis, "summed");
});

test("usage: repair turns add up, because they are separate CLI invocations", () => {
  const turn = (input: number, output: number, cost: number): string =>
    JSON.stringify({ type: "result", total_cost_usd: cost, usage: { input_tokens: input, output_tokens: output } });
  const t1 = extractUsage(turn(100, 20, 0.1));
  const t2 = extractUsage(turn(80, 15, 0.08));
  const total = addUsage(t1, t2);
  assert.equal(total.totalTokens, 215);
  assert.ok(Math.abs((total.costUsd ?? 0) - 0.18) < 1e-9);
});

test("absent usage is reported as absent, not as zero", () => {
  const usage = extractUsage("the agent only produced text, with no accounting");
  assert.equal(usage.totalTokens, null);
  assert.equal(usage.costUsd, null);
  assert.equal(usage.basis, "none");
  assert.equal(usage.source, "none");
});

test("JSON parsing tolerates code fences and surrounding text", () => {
  assert.deepEqual(parseJsonLoose('before ```json\n{"ok":true}\n``` after'), { ok: true });
  assert.deepEqual(parseJsonLoose('{"a":{"b":1}}'), { a: { b: 1 } });
  assert.equal(parseJsonLoose("no json here"), null);
});

test("the GitHub provider discards a PR closed without merging", async () => {
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
          title: "closed without merging",
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
      { repoName: "r", git: bareRepo("/unused"), org: "o" },
      { targetBranch: "refs/heads/main", max: 50 },
    );
    assert.equal(prs.length, 1);
    assert.equal(prs[0].id, 10);
    assert.equal(prs[0].headCommit, "head10");
    assert.equal(prs[0].targetCommit, "base10");
    assert.deepEqual(prs[0].fetchRefs, ["refs/pull/10/head"], "a fork PR needs the ref");
  } finally {
    globalThis.fetch = original;
  }
});

test("the percentile interpolates and Wilson does not collapse with a small n", () => {
  assert.equal(percentile([1, 2, 3, 4], 50), 2.5);
  assert.equal(percentile([5], 90), 5);
  const [lo, hi] = wilson(0, 3);
  assert.equal(lo, 0);
  assert.ok(hi > 0.5, "with 0 of 3 the ceiling still has to be high");
});

test("McNemar looks only at the disagreements, not the total of passes", () => {
  // Ten tasks where only the baseline passed against two where only the
  // treatment passed: the value matches the classic table of the test with
  // a continuity correction, (|10-2|-1)^2 / 12 = 4.083, p = 0.043.
  const r = mcnemar(10, 2);
  assert.ok(Math.abs(r.statistic - 4.0833) < 0.001);
  assert.ok(Math.abs(r.p - 0.0433) < 0.001);
  assert.equal(r.n, 12);

  // A task both arms pass, or both fail, does not enter the tally: what
  // separates the arms are the disagreements alone.
  assert.deepEqual(mcnemar(10, 2), mcnemar(10, 2));
});

test("McNemar with no disagreement concludes nothing", () => {
  const r = mcnemar(0, 0);
  assert.equal(r.p, 1);
  assert.equal(r.n, 0);
});

test("McNemar is symmetric: direction comes from the counters, not from p", () => {
  assert.ok(Math.abs(mcnemar(2, 10).p - mcnemar(10, 2).p) < 1e-12);
});

test("McNemar grows with the asymmetry", () => {
  const weak = mcnemar(6, 4);
  const strong = mcnemar(25, 5);
  assert.ok(strong.p < weak.p, "a more asymmetric disagreement must give a smaller p");
  assert.ok(strong.p < 0.01);
  assert.ok(weak.p > 0.5);
});

test("the sample deviation is zero with fewer than two points", () => {
  assert.equal(stdev([4]), 0);
  assert.ok(stdev([1, 5]) > 2.8);
});

test("shuffle with the same seed produces the same order", () => {
  const items = Array.from({ length: 20 }, (_, i) => i);
  const a = shuffle(items, mulberry32(42));
  const b = shuffle(items, mulberry32(42));
  const c = shuffle(items, mulberry32(43));
  assert.deepEqual(a, b, "the same seed must give the same run order");
  assert.notDeepEqual(a, c);
  assert.deepEqual([...a].sort((x, y) => x - y), items);
});
