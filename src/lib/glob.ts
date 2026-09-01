const SLASHSTAR = " SLASHSTAR ";
const DOUBLESTAR = " DOUBLESTAR ";

/** Glob minimalista para RegExp. Suporta duplo-asterisco, asterisco e `?`. */
export function globToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  const body = escaped
    .replace(/\*\*\//g, SLASHSTAR)
    .replace(/\*\*/g, DOUBLESTAR)
    .replace(/\*/g, "[^/]*")
    .replace(/\?/g, "[^/]")
    .split(SLASHSTAR)
    .join("(?:.*/)?")
    .split(DOUBLESTAR)
    .join(".*");
  return new RegExp(`^${body}$`);
}

export function matchesAny(filePath: string, patterns: RegExp[]): boolean {
  return patterns.some((re) => re.test(filePath));
}

/** Convencoes de teste cobertas: JS/TS, Python, Go, Ruby, .NET, Java. */
const TEST_PATTERNS: RegExp[] = [
  /(\.|_)(spec|test|e2e-spec|int-spec|integration)\.[cm]?[jt]sx?$/i,
  /(^|\/)(__tests__|__test__|tests?|spec|e2e|cypress|playwright)\//i,
  /(^|\/)test_[^/]+\.py$/i,
  /_test\.(py|go|rb)$/i,
  /(^|\/)src\/test\//i,
  /Tests?\.cs$/,
];

export function isTestFile(filePath: string): boolean {
  return TEST_PATTERNS.some((re) => re.test(filePath));
}

/** Ruido que nao conta como tamanho do PR nem como escopo violado. */
export const DEFAULT_EXCLUDES: string[] = [
  "**/package-lock.json",
  "**/pnpm-lock.yaml",
  "**/yarn.lock",
  "**/bun.lock",
  "**/bun.lockb",
  "**/poetry.lock",
  "**/go.sum",
  "**/*.snap",
  "**/dist/**",
  "**/build/**",
  "**/out/**",
  "**/coverage/**",
  "**/node_modules/**",
  "**/*.min.js",
  "**/*.map",
  "**/*.svg",
  "**/*.png",
  "**/*.jpg",
  "**/*.jpeg",
  "**/*.gif",
  "**/*.ico",
  "**/*.pdf",
  "**/CHANGELOG.md",
  "**/*.generated.ts",
];
