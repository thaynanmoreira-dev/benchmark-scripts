/** Console output kept consistent across the scripts. No dependencies. */

const CSI = `${String.fromCharCode(27)}[`;
const useColor = process.stdout.isTTY === true && process.env.NO_COLOR === undefined;
const paint = (code: string, s: string): string => (useColor ? `${CSI}${code}m${s}${CSI}0m` : s);

export const dim = (s: string): string => paint("2", s);
export const bold = (s: string): string => paint("1", s);
export const red = (s: string): string => paint("31", s);
export const green = (s: string): string => paint("32", s);
export const yellow = (s: string): string => paint("33", s);
export const cyan = (s: string): string => paint("36", s);

export function step(n: number, total: number, title: string): void {
  console.log(`\n${bold(`[${n}/${total}]`)} ${title}`);
}

export function info(msg: string): void {
  console.log(`  ${msg}`);
}

export function warn(msg: string): void {
  console.warn(`${yellow("⚠")}  ${msg}`);
}

export function fail(msg: string): void {
  console.error(`${red("✗")} ${msg}`);
}

export function ok(msg: string): void {
  console.log(`${green("✓")} ${msg}`);
}

export function rule(label = ""): void {
  const line = "─".repeat(Math.max(4, 58 - label.length));
  console.log(`\n${dim(`── ${label} ${line}`)}`);
}

/** Fixed-width table. `cols` defines header, width and alignment. */
export function table(
  cols: Array<{ header: string; width: number; align?: "left" | "right" }>,
  rows: string[][],
): void {
  const pad = (s: string, w: number, align?: "left" | "right"): string =>
    align === "right" ? s.padStart(w) : s.padEnd(w);
  const header = cols.map((c) => pad(c.header, c.width, c.align)).join("  ");
  console.log(bold(header));
  console.log(dim("─".repeat(header.length)));
  for (const row of rows) {
    console.log(cols.map((c, i) => pad(row[i] ?? "", c.width, c.align)).join("  "));
  }
}

/** Truncates keeping head and tail. A long error log stays readable. */
export function clip(s: string, max: number): string {
  if (s.length <= max) return s;
  const head = Math.floor(max * 0.6);
  const tail = max - head;
  return `${s.slice(0, head)}\n... [${s.length - max} chars omitidos] ...\n${s.slice(-tail)}`;
}
