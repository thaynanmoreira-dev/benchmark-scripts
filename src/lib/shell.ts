import { spawn } from "node:child_process";

export interface CommandResult {
  command: string;
  exitCode: number | null;
  ok: boolean;
  output: string;
  durationMs: number;
  timedOut: boolean;
}

export interface CommandOptions {
  cwd: string;
  timeoutMs?: number;
  env?: Record<string, string>;
  /** Corta a saida guardada. O log completo vira ruido no runs.jsonl. */
  maxOutput?: number;
}

/**
 * Executa um comando de shell e devolve o resultado sem lancar.
 * Falha de gate e informacao, nao excecao.
 */
export function runCommand(command: string, opts: CommandOptions): Promise<CommandResult> {
  const timeoutMs = opts.timeoutMs ?? 600_000;
  const maxOutput = opts.maxOutput ?? 8000;
  const startedAt = Date.now();

  return new Promise((resolve) => {
    let output = "";
    let timedOut = false;
    let settled = false;

    const child = spawn(command, {
      cwd: opts.cwd,
      shell: true,
      env: { ...process.env, CI: "1", ...(opts.env ?? {}) },
      stdio: ["ignore", "pipe", "pipe"],
    });

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);

    const collect = (d: Buffer): void => {
      if (output.length < maxOutput * 4) output += d.toString();
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);

    const finish = (exitCode: number | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // as ultimas linhas sao as que dizem o que quebrou
      const trimmed = output.length > maxOutput ? output.slice(-maxOutput) : output;
      resolve({
        command,
        exitCode,
        ok: exitCode === 0 && !timedOut,
        output: trimmed,
        durationMs: Date.now() - startedAt,
        timedOut,
      });
    };

    child.on("error", (e) => {
      output += `\n[spawn error] ${e.message}`;
      finish(null);
    });
    child.on("close", (code) => finish(code));
  });
}

/** Preenche o template `{files}` com paths devidamente aspeados. */
export function fillFiles(template: string, files: string[]): string {
  const quoted = files.map((f) => `'${f.replace(/'/g, `'\\''`)}'`).join(" ");
  return template.includes("{files}")
    ? template.replace("{files}", quoted)
    : `${template} ${quoted}`;
}
