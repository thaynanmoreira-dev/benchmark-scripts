import { readdir } from "node:fs/promises";
import path from "node:path";

import { existsSync, firstExisting, hash, readJson } from "./fsx.ts";
import { readFile } from "node:fs/promises";
import type { Ecosystem, StackProbe } from "./types.ts";

/**
 * Deterministic probe. Nothing here calls an LLM.
 *
 * The project's principle: only pay tokens for what a deterministic tool cannot
 * answer. package.json, the lockfile and the directory tree are free and always
 * reliable; reading the code for meaning comes afterwards.
 */

const DEP_BUCKETS = {
  db: ["pg", "postgres", "mongodb", "mongoose", "ioredis", "redis", "mssql", "mysql2"],
  messaging: ["amqplib", "kafkajs", "@azure/service-bus", "bullmq", "@nestjs/microservices"],
  orm: ["typeorm", "prisma", "@prisma/client", "sequelize", "drizzle-orm", "knex", "mikro-orm"],
  observability: [
    "@opentelemetry/api",
    "applicationinsights",
    "pino",
    "winston",
    "@nestjs/terminus",
  ],
};

const FRAMEWORK_HINTS: Array<[string, string]> = [
  ["@nestjs/core", "NestJS"],
  ["@nestjs/cqrs", "NestJS CQRS"],
  ["express", "Express"],
  ["fastify", "Fastify"],
  ["next", "Next.js"],
  ["react", "React"],
  ["@angular/core", "Angular"],
];

const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "out",
  "coverage",
  ".next",
  ".turbo",
  ".bench",
  "vendor",
  "__pycache__",
  ".venv",
]);

export async function listSrcTree(dir: string, maxDepth = 3, limit = 400): Promise<string[]> {
  const out: string[] = [];

  async function walk(cur: string, depth: number, rel: string): Promise<void> {
    if (depth > maxDepth || out.length >= limit) return;
    let entries;
    try {
      entries = await readdir(cur, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (out.length >= limit) return;
      if (e.name.startsWith(".") && e.name !== ".kiro") continue;
      if (SKIP_DIRS.has(e.name)) continue;
      if (!e.isDirectory()) continue;
      const nextRel = rel ? `${rel}/${e.name}` : e.name;
      out.push(`${nextRel}/`);
      await walk(path.join(cur, e.name), depth + 1, nextRel);
    }
  }

  await walk(dir, 1, "");
  return out;
}

async function detectEcosystem(dir: string): Promise<Ecosystem> {
  if (existsSync(path.join(dir, "package.json"))) return "node";
  if (
    (await firstExisting(dir, ["pyproject.toml", "requirements.txt", "setup.py", "Pipfile"])) !==
    null
  ) {
    return "python";
  }
  if (existsSync(path.join(dir, "go.mod"))) return "go";
  if ((await firstExisting(dir, ["pom.xml", "build.gradle", "build.gradle.kts"])) !== null) {
    return "java";
  }
  const entries = await readdir(dir).catch(() => [] as string[]);
  if (entries.some((e) => e.endsWith(".csproj") || e.endsWith(".sln"))) return "dotnet";
  return "unknown";
}

/** Commands per ecosystem when there is no package.json to consult. */
function nonNodeCommands(eco: Ecosystem): StackProbe["commands"] {
  const table: Record<string, StackProbe["commands"]> = {
    python: {
      install: "python -m pip install -e .",
      test: "pytest -q",
      testFile: "pytest -q {files}",
      lint: "ruff check .",
      typecheck: "mypy .",
      build: null,
      arch: null,
    },
    go: {
      install: "go mod download",
      test: "go test ./...",
      testFile: "go test {files}",
      lint: "go vet ./...",
      typecheck: "go build ./...",
      build: "go build ./...",
      arch: null,
    },
  };
  return (
    table[eco] ?? {
      install: null,
      test: null,
      testFile: null,
      lint: null,
      typecheck: null,
      build: null,
      arch: null,
    }
  );
}

export async function probeStack(repoName: string, dir: string): Promise<StackProbe> {
  const ecosystem = await detectEcosystem(dir);
  const pkg = await readJson<Record<string, any>>(path.join(dir, "package.json"));
  const scripts: Record<string, string> = pkg?.scripts ?? {};
  const allDeps: Record<string, string> = {
    ...(pkg?.dependencies ?? {}),
    ...(pkg?.devDependencies ?? {}),
  };
  const depNames = Object.keys(allDeps);

  const lockfile = await firstExisting(dir, [
    "pnpm-lock.yaml",
    "package-lock.json",
    "yarn.lock",
    "bun.lock",
    "bun.lockb",
    "poetry.lock",
    "go.sum",
    "requirements.txt",
  ]);

  const pm: StackProbe["packageManager"] =
    lockfile === "pnpm-lock.yaml"
      ? "pnpm"
      : lockfile === "package-lock.json"
        ? "npm"
        : lockfile === "yarn.lock"
          ? "yarn"
          : lockfile?.startsWith("bun.")
            ? "bun"
            : ecosystem === "node"
              ? "npm"
              : "unknown";

  let lockfileHash: string | null = null;
  if (lockfile) {
    try {
      lockfileHash = hash(await readFile(path.join(dir, lockfile), "utf8"));
    } catch {
      /* lockfile binario ilegivel como utf8 */
    }
  }

  const workspaceTool = await firstExisting(dir, [
    "pnpm-workspace.yaml",
    "turbo.json",
    "nx.json",
    "lerna.json",
  ]);

  const testRunner = depNames.includes("vitest")
    ? "vitest"
    : depNames.includes("jest")
      ? "jest"
      : depNames.includes("mocha")
        ? "mocha"
        : ecosystem === "node" && scripts.test?.includes("node --test")
          ? "node:test"
          : null;

  const runPrefix =
    pm === "pnpm" ? "pnpm run" : pm === "yarn" ? "yarn run" : pm === "bun" ? "bun run" : "npm run";

  const pick = (...keys: string[]): string | null => {
    const k = keys.find((x) => typeof scripts[x] === "string" && scripts[x].trim());
    return k ? `${runPrefix} ${k}` : null;
  };

  const testFileTemplate =
    testRunner === "jest"
      ? "npx jest --runTestsByPath {files}"
      : testRunner === "vitest"
        ? "npx vitest run {files}"
        : testRunner === "mocha"
          ? "npx mocha {files}"
          : testRunner === "node:test"
            ? "node --test {files}"
            : null;

  const hasDependencyCruiser =
    (await firstExisting(dir, [
      ".dependency-cruiser.js",
      ".dependency-cruiser.cjs",
      ".dependency-cruiser.json",
      "dependency-cruiser.config.js",
    ])) !== null;

  const nonNode = nonNodeCommands(ecosystem);

  const commands: StackProbe["commands"] =
    ecosystem === "node"
      ? {
          install:
            pm === "pnpm"
              ? "pnpm install --frozen-lockfile"
              : pm === "yarn"
                ? "yarn install --immutable"
                : pm === "bun"
                  ? "bun install --frozen-lockfile"
                  : lockfile === "package-lock.json"
                    ? "npm ci"
                    : "npm install",
          test: pick("test", "test:unit"),
          testFile: testFileTemplate,
          lint: pick("lint"),
          typecheck: pick("typecheck", "type-check", "tsc") ?? "npx tsc --noEmit",
          build: pick("build"),
          arch: hasDependencyCruiser
            ? (pick("depcruise", "arch", "arch:check") ?? "npx depcruise --validate src")
            : null,
        }
      : nonNode;

  const bucket = (list: string[]): string[] => list.filter((d) => depNames.includes(d));
  const dirList = async (rel: string): Promise<string[]> =>
    existsSync(path.join(dir, rel)) ? await readdir(path.join(dir, rel)).catch(() => []) : [];

  return {
    repo: repoName,
    ecosystem,
    packageManager: pm,
    lockfile,
    lockfileHash,
    isMonorepo: Boolean(workspaceTool) || Array.isArray(pkg?.workspaces),
    workspaceTool,
    runtime: { node: pkg?.engines?.node ?? null, typescript: allDeps["typescript"] ?? null },
    framework: FRAMEWORK_HINTS.filter(([d]) => depNames.includes(d)).map(([, n]) => n),
    testRunner,
    scripts,
    commands,
    deps: {
      db: bucket(DEP_BUCKETS.db),
      messaging: bucket(DEP_BUCKETS.messaging),
      orm: bucket(DEP_BUCKETS.orm),
      observability: bucket(DEP_BUCKETS.observability),
    },
    lintConfig: await firstExisting(dir, [
      "eslint.config.js",
      "eslint.config.mjs",
      "eslint.config.ts",
      "biome.json",
      ".eslintrc.js",
      ".eslintrc.json",
      ".eslintrc.cjs",
    ]),
    hasDependencyCruiser,
    ci: (
      await Promise.all(
        [
          "azure-pipelines.yml",
          ".azuredevops",
          ".github/workflows",
          ".gitlab-ci.yml",
          "Jenkinsfile",
        ].map(async (p) => (existsSync(path.join(dir, p)) ? p : null)),
      )
    ).filter((x): x is string => x !== null),
    srcTree: await listSrcTree(dir),
    existingKiro: {
      steering: await dirList(".kiro/steering"),
      hooks: await dirList(".kiro/hooks"),
      mcp: existsSync(path.join(dir, ".kiro/settings/mcp.json")),
      agentsMd: existsSync(path.join(dir, "AGENTS.md")),
    },
  };
}
