/**
 * Tipos compartilhados por todo o harness.
 *
 * Regra: qualquer coisa que atravesse a fronteira entre dois scripts
 * (manifest.json, projects/*.json, arms/*.json, plan.json, runs.jsonl)
 * é declarada aqui. Se um tipo vive dentro de um único script, ele fica lá.
 */

// ───────────────────────────────────────────────────────── providers

export type ProviderName = "azure-devops" | "github" | "local-git";

/** Um PR já mergeado, normalizado entre providers. */
export interface PullRequestRef {
  /** Número/id do PR no provider. Para local-git, um contador estável. */
  id: number;
  title: string;
  description: string;
  targetBranch: string;
  /** Ponta do branch de origem — o "depois". */
  headCommit: string;
  /** Ponta do branch alvo no momento do merge — base do merge-base. */
  targetCommit: string;
  /** Commit de merge, quando existir. */
  mergeCommit: string | null;
  closedDate: string | null;
  isDraft: boolean;
  url: string | null;
  /** Refs extras para tentar no fetch quando o sha não está no clone. */
  fetchRefs: string[];
}

export interface ListPrsOptions {
  targetBranch: string;
  max: number;
  since?: string;
}

// ───────────────────────────────────────────────────────── config

export interface RepoSpec {
  /** Nome curto. Vira chave em todo lugar (perfil, arms, taskId). */
  name: string;
  /** URL de clone. Se ausente, é derivada do provider + org/project. */
  remoteUrl?: string;
  /** Clone local já existente. Se presente, nada é clonado. */
  dir?: string;
  /** Branch principal. Default: main. */
  defaultBranch?: string;
  /** Override do provider só para este repo. */
  provider?: ProviderName;
}

export interface AgentConfig {
  /** Executável do CLI do agente. Ex: kiro-cli, kiro, claude. */
  cmd: string;
  /** Args fixos, aplicados em toda invocação. */
  args: string[];
  /** Como o prompt chega no CLI. */
  promptMode: "stdin" | "arg";
  /** Flag usada quando promptMode = "arg". Vazio = prompt posicional. */
  promptFlag?: string;
  /** Flag do modelo. O valor vem de BenchConfig.model. */
  modelFlag?: string;
  /** Args extras por modo de operação do agente. */
  modeArgs?: { vibe?: string[]; spec?: string[] };
  env?: Record<string, string>;
  timeoutMs?: number;
}

export interface BenchConfig {
  /** Default do provider para todos os repos. */
  provider?: ProviderName;
  /** Azure DevOps: organização. GitHub: owner (user ou org). */
  org?: string;
  /** Azure DevOps: projeto. Ignorado nos demais. */
  project?: string;
  repos: RepoSpec[];
  /** Raiz de trabalho. Default: .bench */
  root?: string;
  /** Adapter do CLI do agente. `kiro` é aceito como alias legado. */
  agent?: AgentConfig;
  kiro?: AgentConfig;
  /** Modelo travado para todo o benchmark. */
  model?: string;
  /** Repetições por (arm × tarefa). */
  reps?: number;
  /** Semente do shuffle. */
  seed?: number;
  /** Arms de baseline apagam .kiro/ pré-existente. Default: true. */
  baselineStripsExistingConfig?: boolean;
  /** Turnos de reparo quando o arm tem enforceGates. Default: 2. */
  maxGateRetries?: number;
  /** Instalação de dependências no worktree. */
  install?: { enabled?: boolean; timeoutMs?: number };
  /** Timeout dos comandos de gate/teste. Default: 600000. */
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
  /** merge-base real: o worktree do run nasce aqui. */
  baseCommit: string;
  headCommit: string;
  mergeCommit: string | null;
  closedDate: string | null;
  metrics: TaskMetrics;
  prodFiles: string[];
  /** Grader held-out. Materializado só na avaliação. */
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

// ───────────────────────────────────────────────────────── perfil (bench-init)

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
    /** Template com {files} — testes escopados ao grader held-out. */
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
  /** Configuração de agente já versionada no repo. Contamina o baseline. */
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
  /** Repositório git bare de onde saem os worktrees. */
  mirrorPath: string;
  probe: StackProbe;
  semantic: SemanticProfile;
  semanticSource: "agent" | "fallback" | "cached";
}

// ───────────────────────────────────────────────────────── arms

export interface ArmOverlay {
  /** Arquivos materializados no worktree antes do run. */
  files: Record<string, string>;
  /** Caminhos apagados do worktree antes do run (ex: .kiro pré-existente). */
  remove: string[];
  /** Args extras passados ao CLI do agente. */
  extraArgs: string[];
  /** Loop de reparo obrigatório com lint/typecheck/arch. */
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

// ───────────────────────────────────────────────────────── plano

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
  /** Quantos eventos de usage entraram na conta. 0 = nada. */
  samples: number;
  /**
   * Como o total foi obtido. "terminal" = evento de resumo do CLI, que ja vem
   * acumulado. "somado" = soma de eventos parciais, na ausencia de resumo.
   */
  basis: "terminal" | "somado" | "nenhum";
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
  /** Turnos do agente: 1 = tentativa inicial, >1 = reparo por gate. */
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
