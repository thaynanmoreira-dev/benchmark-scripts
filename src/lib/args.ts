/** Parser de flags minimalista, compartilhado pelos quatro CLIs. */

export interface ArgReader {
  /** Valor de `--flag valor`. */
  str(flag: string, fallback?: string): string | undefined;
  /** Valor numérico, com fallback obrigatório. */
  num(flag: string, fallback: number): number;
  /** Presença de `--flag`. */
  bool(flag: string): boolean;
  /** `--flag a,b,c` -> ["a","b","c"], vazios descartados. */
  list(flag: string, fallback?: string): string[];
  /** Valores numéricos separados por vírgula. */
  nums(flag: string, fallback: string): number[];
  /** Argumentos posicionais, isto é, os não consumidos por flags lidas. */
  rest(): string[];
  raw: string[];
}

export function readArgs(argv: string[]): ArgReader {
  const consumed = new Set<number>();

  const str = (flag: string, fallback?: string): string | undefined => {
    const i = argv.indexOf(flag);
    if (i < 0) return fallback;
    consumed.add(i);
    const v = argv[i + 1];
    if (v === undefined || v.startsWith("--")) return fallback;
    consumed.add(i + 1);
    return v;
  };

  const bool = (flag: string): boolean => {
    const i = argv.indexOf(flag);
    if (i < 0) return false;
    consumed.add(i);
    return true;
  };

  return {
    str,
    bool,
    num: (flag, fallback) => {
      const v = str(flag);
      const n = v === undefined ? NaN : Number(v);
      return Number.isFinite(n) ? n : fallback;
    },
    list: (flag, fallback) =>
      (str(flag, fallback) ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    nums: (flag, fallback) =>
      (str(flag, fallback) ?? "")
        .split(",")
        .map((s) => Number(s.trim()))
        .filter((n) => Number.isFinite(n)),
    rest: () => argv.filter((a, i) => !consumed.has(i) && !a.startsWith("--")),
    raw: argv,
  };
}
