/**
 * Types shared across the whole harness.
 *
 * Rule: anything that crosses the boundary between two scripts
 * (manifest.json, projects/*.json, arms/*.json, plan.json, runs.jsonl) is
 * declared here. A type that lives inside a single script stays there.
 */

// ───────────────────────────────────────────────────────── providers

export type ProviderName = "azure-devops" | "github" | "local-git";

/** A merged PR, normalised across providers. */
export interface PullRequestRef {
  /** The PR number/id in the provider. For local-git, a stable counter. */
  id: number;
  title: string;
  description: string;
  targetBranch: string;
  /** Tip of the source branch — the "after". */
  headCommit: string;
  /** Tip of the target branch at merge time — the merge-base input. */
  targetCommit: string;
  /** The merge commit, when there is one. */
  mergeCommit: string | null;
  closedDate: string | null;
  isDraft: boolean;
  url: string | null;
  /** Extra refs to try when fetching a sha the clone does not have. */
  fetchRefs: string[];
}

export interface ListPrsOptions {
  targetBranch: string;
  max: number;
  since?: string;
}

// ───────────────────────────────────────────────────────── config

export interface RepoSpec {
  /** Short name. Becomes the key everywhere (profile, arms, taskId). */
  name: string;
  /** Clone URL. When absent it is derived from provider + org/project. */
  remoteUrl?: string;
  /** An existing local clone. When present, nothing is cloned. */
  dir?: string;
  /** Main branch. Default: main. */
  defaultBranch?: string;
  /** Provider override for this repo only. */
  provider?: ProviderName;
}

export interface AgentConfig {
  /** The agent CLI executable. For example: kiro-cli, kiro, claude. */
  cmd: string;
  /** Fixed args, applied on every invocation. */
  args: string[];
  /** How the prompt reaches the CLI. */
  promptMode: "stdin" | "arg";
  /** Flag used when promptMode = "arg". Empty means a positional prompt. */
  promptFlag?: string;
  /** Model flag. The value comes from BenchConfig.model. */
  modelFlag?: string;
  /** Extra args per agent operating mode. */
  modeArgs?: { vibe?: string[]; spec?: string[] };
  env?: Record<string, string>;
  timeoutMs?: number;
}

export interface BenchConfig {
  /** Default provider for every repo. */
  provider?: ProviderName;
  /** Azure DevOps: the organisation. GitHub: the owner (user or org). */
  org?: string;
  /** Azure DevOps: the project. Ignored elsewhere. */
  project?: string;
  repos: RepoSpec[];
  /** Working root. Default: .bench */
  root?: string;
  /** The agent CLI adapter. `kiro` is accepted as a legacy alias. */
  agent?: AgentConfig;
  kiro?: AgentConfig;
  /** Model pinned for the whole benchmark. */
  model?: string;
  /** Repetitions per (arm × task). */
  reps?: number;
  /** Shuffle seed. */
  seed?: number;
  /** Baseline arms delete any pre-existing .kiro/. Default: true. */
  baselineStripsExistingConfig?: boolean;
  /** Repair turns when the arm has enforceGates. Default: 2. */
  maxGateRetries?: number;
  /** Dependency installation inside the worktree. */
  install?: { enabled?: boolean; timeoutMs?: number };
  /** Timeout for gate and test commands. Default: 600000. */
  gateTimeoutMs?: number;
}

// ───────────────────────────────────────────────────────── manifest (select-prs)

export type TaskKind = "golden-pr" | "scope-bait";

export interface TaskMetrics {
  files: number;
  additions: number;
  deletions: number;
  churn: number;
  prodChurn: number;
  testChurn: number;
  hasTests: boolean;
}

export interface MeasuredPr {
  /** `<repo>#<prId>` */
  id: string;
  kind: TaskKind;
  repo: string;
  prId: number;
  title: string;
  description: string;
  url: string | null;
  targetBranch: string;
  /** The real merge-base: the run's worktree starts here. */
  baseCommit: string;
  headCommit: string;
  mergeCommit: string | null;
  closedDate: string | null;
  metrics: TaskMetrics;
  prodFiles: string[];
  /** Held-out grader. Materialised only at evaluation time. */
  testFiles: string[];
}

export interface ScoredPr extends MeasuredPr {
  rawMetric: number;
  scaledMetric: number;
  sizePercent: number;
}

export interface SelectedPr extends ScoredPr {
  bucket: number;
  distanceToBucket: number;
}

export interface Manifest {
  generatedAt: string;
  provider: ProviderName;
  criteria: Record<string, unknown>;
  corpusSize: number;
  tasks: SelectedPr[];
}

// ───────────────────────────────────────────────────────── profile (bench-init)

export type Ecosystem = "node" | "python" | "go" | "dotnet" | "java" | "unknown";

export interface StackProbe {
  repo: string;
  ecosystem: Ecosystem;
  packageManager: "npm" | "pnpm" | "yarn" | "bun" | "unknown";
  lockfile: string | null;
  lockfileHash: string | null;
  isMonorepo: boolean;
  workspaceTool: string | null;
  runtime: { node: string | null; typescript: string | null };
  framework: string[];
  testRunner: string | null;
  scripts: Record<string, string>;
  commands: {
    install: string | null;
    test: string | null;
    /** Template holding {files} — tests scoped to the held-out grader. */
    testFile: string | null;
    lint: string | null;
    typecheck: string | null;
    build: string | null;
    arch: string | null;
  };
  deps: { db: string[]; messaging: string[]; orm: string[]; observability: string[] };
  lintConfig: string | null;
  hasDependencyCruiser: boolean;
  ci: string[];
  srcTree: string[];
  /** Agent configuration already committed to the repo. It taints the baseline. */
  existingKiro: { steering: string[]; hooks: string[]; mcp: boolean; agentsMd: boolean };
}

export interface SemanticProfile {
  architectureStyle: string;
  layers: Array<{ name: string; globs: string[]; mayImport: string[] }>;
  domainSummary: string;
  criticalInvariants: string[];
  testFileConvention: string;
  suggestedNonGoals: string[];
  confidence: "high" | "medium" | "low";
  notes: string;
}

export interface ProjectProfile {
  repo: string;
  generatedAt: string;
  /** The bare git repository the worktrees come from. */
  mirrorPath: string;
  probe: StackProbe;
  semantic: SemanticProfile;
  semanticSource: "agent" | "fallback" | "cached";
}

// ───────────────────────────────────────────────────────── arms

export interface ArmOverlay {
  /** Files materialised in the worktree before the run. */
  files: Record<string, string>;
  /** Paths deleted from the worktree before the run (a pre-existing .kiro, say). */
  remove: string[];
  /** Extra args passed to the agent CLI. */
  extraArgs: string[];
  /** Mandatory repair loop driven by lint/typecheck/arch. */
  enforceGates: boolean;
}

export interface Arm {
  id: string;
  repo: string;
  label: string;
  hypothesis: string;
  mode: "vibe" | "spec";
  overlay: ArmOverlay;
}

// ───────────────────────────────────────────────────────── plan

export interface PlanEntry {
  order: number;
  runId: string;
  arm: string;
  taskId: string;
  repo: string;
  rep: number;
  baseCommit: string;
  mirrorPath: string;
}

export interface Plan {
  generatedAt: string;
  model: string | null;
  reps: number;
  seed: number;
  arms: string[];
  totalRuns: number;
  entries: PlanEntry[];
}

// ───────────────────────────────────────────────────────── runs.jsonl

export interface GateResult {
  name: string;
  command: string | null;
  passed: boolean | null;
  exitCode: number | null;
  durationMs: number;
  output: string;
}

export interface UsageSnapshot {
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  totalTokens: number | null;
  costUsd: number | null;
  credits: number | null;
  /** How many usage events went into the total. 0 means none. */
  samples: number;
  /**
   * How the total was obtained. "terminal" = the CLI's summary event, which is
   * already cumulative. "summed" = the sum of partial events, absent a summary.
   */
  basis: "terminal" | "summed" | "none";
  source: "stream" | "none";
}

export interface RunRecord {
  runId: string;
  arm: string;
  taskId: string;
  repo: string;
  rep: number;
  mode: "vibe" | "spec";
  model: string | null;
  startedAt: string;
  endedAt: string;
  wallClockMs: number;
  agentMs: number;
  exitCode: number | null;
  /** Agent turns: 1 = first attempt, >1 = repair driven by a gate. */
  agentTurns: number;
  timedOut: boolean;
  usageFromStream: UsageSnapshot;
  creditsBefore: number | null;
  creditsAfter: number | null;
  creditsDelta: number | null;
  filesTouched: string[];
  filesOutsideGoldenDiff: string[];
  goldenFilesMissed: string[];
  heldOutOverwrites: string[];
  gates: Record<string, boolean | null>;
  gateDetail: GateResult[];
  heldOutTests: { passed: number; failed: number; total: number; ran: boolean };
  success: boolean;
  status: "ok" | "agent-failed" | "setup-failed" | "graded-failed";
  notes: string;
}
