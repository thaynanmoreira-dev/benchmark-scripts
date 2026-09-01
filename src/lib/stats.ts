/** Estatistica basica. Deterministico e sem dependencia. */

/** Percentil por interpolacao linear. `sorted` precisa estar ordenado asc. */
export function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  if (sorted.length === 1) return sorted[0];
  const clamped = Math.min(100, Math.max(0, p));
  const idx = (clamped / 100) * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

export function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

/** Desvio padrao amostral (n-1). Retorna 0 para n menor que 2. */
export function stdev(values: number[]): number {
  if (values.length < 2) return 0;
  const m = mean(values);
  const variance = values.reduce((acc, v) => acc + (v - m) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance);
}

/**
 * Intervalo de Wilson para proporcao. Com n pequeno (3 reps por celula) o
 * intervalo normal mente; o de Wilson nao colapsa em zero quando k = 0.
 */
export function wilson(successes: number, total: number, z = 1.96): [number, number] {
  if (total === 0) return [0, 0];
  const p = successes / total;
  const denom = 1 + (z * z) / total;
  const center = p + (z * z) / (2 * total);
  const spread = z * Math.sqrt((p * (1 - p)) / total + (z * z) / (4 * total * total));
  return [Math.max(0, (center - spread) / denom), Math.min(1, (center + spread) / denom)];
}

/**
 * Teste de McNemar pareado, com correcao de continuidade.
 *
 * Comparar duas taxas de sucesso soltas ignora que os dois arms rodaram AS
 * MESMAS tarefas. O que interessa nao e quantos cada um acertou, e sim em
 * quantas tarefas eles discordaram e para que lado: `b` = so o baseline
 * passou, `c` = so o tratamento passou. Tarefa que os dois acertam, ou que os
 * dois erram, nao carrega informacao sobre a diferenca entre eles.
 *
 * Devolve o p-valor bilateral aproximado pela qui-quadrado com 1 grau de
 * liberdade. Com b + c pequeno a aproximacao e grosseira, e o chamador avisa.
 */
export function mcnemar(b: number, c: number): { estatistica: number; p: number; n: number } {
  const n = b + c;
  if (n === 0) return { estatistica: 0, p: 1, n: 0 };
  const estatistica = (Math.abs(b - c) - 1) ** 2 / n;
  return { estatistica, p: qui2SobrevivenciaGl1(estatistica), n };
}

/**
 * Cauda superior da qui-quadrado com 1 grau de liberdade.
 * Para gl = 1 vale P(X > x) = erfc(sqrt(x / 2)), entao basta uma erfc.
 */
function qui2SobrevivenciaGl1(x: number): number {
  if (x <= 0) return 1;
  return erfc(Math.sqrt(x / 2));
}

/** erfc por aproximacao de Numerical Recipes: erro relativo abaixo de 1.2e-7. */
function erfc(x: number): number {
  const z = Math.abs(x);
  const t = 1 / (1 + z / 2);
  const soma =
    -z * z -
    1.26551223 +
    t *
      (1.00002368 +
        t *
          (0.37409196 +
            t *
              (0.09678418 +
                t *
                  (-0.18628806 +
                    t *
                      (0.27886807 +
                        t *
                          (-1.13520398 +
                            t * (1.48851587 + t * (-0.82215223 + t * 0.17087277))))))));
  const r = t * Math.exp(soma);
  return x >= 0 ? r : 2 - r;
}

/** PRNG deterministico. Mesma seed, mesma ordem de runs. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function shuffle<T>(arr: T[], rand: () => number): T[] {
  const out = [...arr];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

export function fmt(n: number): string {
  return n.toLocaleString("pt-BR");
}

export function fmtMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const min = Math.floor(ms / 60_000);
  const sec = Math.round((ms % 60_000) / 1000);
  return `${min}m${String(sec).padStart(2, "0")}s`;
}
