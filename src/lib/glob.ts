const SLASHSTAR = " SLASHSTAR ";
const DOUBLESTAR = " DOUBLESTAR ";

/** Minimal glob to RegExp. Supports double-star, star and `?`. */
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

/** Test conventions covered: JS/TS, Python, Go, Ruby, .NET, Java. */
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

/** Noise that counts neither toward PR size nor toward scope violations. */
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
