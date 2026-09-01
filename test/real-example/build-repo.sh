#!/usr/bin/env bash
#
# Builds a realistic Node/TypeScript payments service repository, with three
# merged PRs of different sizes. Real code, real tests, real lint and
# typecheck — nothing mocked.
#
# Each PR is a merge commit whose message is the work item: the description
# the agent will receive, and nothing beyond it. Each PR's tests become the
# held-out grader, invisible at the base commit because they only come into
# existence at the merge.
#
# Usage: bash test/real-example/build-repo.sh <destination>
set -euo pipefail

DEST="${1:?give the destination directory}"
rm -rf "$DEST"; mkdir -p "$DEST"; cd "$DEST"

git init -q -b main .
git config user.email dev@example.invalid
git config user.name "Fixture"

# ─────────────────────────────────────────────── base commit
mkdir -p src/shared src/payment/domain src/payment/application scripts

cat > .gitignore <<'EOF'
node_modules/
EOF

cat > package.json <<'EOF'
{
  "name": "payments-api",
  "version": "1.0.0",
  "type": "module",
  "scripts": {
    "test": "node --test 'src/**/*.spec.ts'",
    "lint": "node scripts/lint.mjs",
    "typecheck": "tsc --noEmit"
  },
  "devDependencies": {
    "typescript": "^5.9.2",
    "@types/node": "^22.15.3"
  }
}
EOF

cat > tsconfig.json <<'EOF'
{
  "compilerOptions": {
    "target": "ES2023",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "allowImportingTsExtensions": true,
    "erasableSyntaxOnly": true,
    "noEmit": true,
    "strict": true,
    "skipLibCheck": true,
    "types": ["node"]
  },
  "include": ["src/**/*.ts"]
}
EOF

cat > scripts/lint.mjs <<'EOF'
// Minimal deterministic lint: forbids `any` and console.log inside src/.
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const errors = [];
const walk = (dir) => {
  for (const e of readdirSync(dir)) {
    const p = path.join(dir, e);
    if (statSync(p).isDirectory()) { walk(p); continue; }
    if (!p.endsWith(".ts")) continue;
    readFileSync(p, "utf8").split("\n").forEach((line, i) => {
      if (/:\s*any\b/.test(line)) errors.push(`${p}:${i + 1} use of \`any\``);
      if (/console\.log\(/.test(line)) errors.push(`${p}:${i + 1} console.log in src/`);
    });
  }
};
walk("src");
if (errors.length) { console.error(errors.join("\n")); process.exit(1); }
console.log("lint ok");
EOF

cat > src/shared/result.ts <<'EOF'
export type Result<T> = { ok: true; value: T } | { ok: false; error: string };

export function success<T>(value: T): Result<T> {
  return { ok: true, value };
}

export function failure<T>(error: string): Result<T> {
  return { ok: false, error };
}
EOF

cat > src/shared/result.spec.ts <<'EOF'
import test from "node:test";
import assert from "node:assert/strict";
import { failure, success } from "./result.ts";

test("success carries the value", () => {
  assert.equal(success(10).ok, true);
});

test("failure carries the error", () => {
  assert.equal(failure<number>("bad").ok, false);
});
EOF

cat > src/payment/domain/money.ts <<'EOF'
/** Cents, always. Floating point on money is a guaranteed incident. */
export function unitsToCents(units: number): number {
  return Math.round(units * 100);
}

export function centsToUnits(cents: number): number {
  return cents / 100;
}
EOF

npm install --silent --no-audit --no-fund >/dev/null 2>&1
git add -A && git commit -qm "chore: initial structure of the payments service"

# ─────────────────────────────────────────────── PR 41 (small)
git checkout -qb feat/tax-id
cat > src/shared/tax-id.ts <<'EOF'
/** Validates a tax id by its two check digits. Punctuation is ignored. */
export function isValidTaxId(taxId: string): boolean {
  const digits = taxId.replace(/\D/g, "");
  if (digits.length !== 11) return false;
  if (/^(\d)\1{10}$/.test(digits)) return false;

  const checkDigit = (upTo: number): number => {
    let sum = 0;
    for (let i = 0; i < upTo; i++) sum += Number(digits[i]) * (upTo + 1 - i);
    const remainder = (sum * 10) % 11;
    return remainder === 10 ? 0 : remainder;
  };

  return checkDigit(9) === Number(digits[9]) && checkDigit(10) === Number(digits[10]);
}
EOF
cat > src/shared/tax-id.spec.ts <<'EOF'
import test from "node:test";
import assert from "node:assert/strict";
import { isValidTaxId } from "./tax-id.ts";

test("accepts a valid tax id with and without punctuation", () => {
  assert.equal(isValidTaxId("529.982.247-25"), true);
  assert.equal(isValidTaxId("52998224725"), true);
});

test("rejects a wrong check digit", () => {
  assert.equal(isValidTaxId("529.982.247-24"), false);
});

test("rejects the wrong length", () => {
  assert.equal(isValidTaxId("1234567890"), false);
});

test("rejects a sequence of repeated digits", () => {
  assert.equal(isValidTaxId("111.111.111-11"), false);
});
EOF
git add -A && git commit -qm wip
git checkout -q main
git merge -q --no-ff feat/tax-id -m "Merged PR 41: tax id validation in shared" -m "Create \`src/shared/tax-id.ts\` exporting \`isValidTaxId(taxId: string): boolean\`.

Rules:
- accept a tax id with or without punctuation (dots and hyphen);
- validate the two check digits with the official algorithm (modulo 11);
- reject any string that does not have 11 digits;
- reject a sequence of identical digits, such as 111.111.111-11, which passes modulo 11 but is not a valid tax id."

# ─────────────────────────────────────────────── PR 47 (medium)
git checkout -qb feat/installments
cat > src/payment/domain/installments.ts <<'EOF'
import { failure, success, type Result } from "../../shared/result.ts";

export interface Installment {
  number: number;
  amountCents: number;
}

/**
 * Installments with compound interest by the amortization (Price) table.
 * Every calculation runs in cents; the rounding difference goes into the
 * first installment so that the sum closes exactly with the total owed.
 */
export function calculateInstallments(
  amountCents: number,
  count: number,
  monthlyRate: number,
): Result<Installment[]> {
  if (!Number.isInteger(amountCents) || amountCents <= 0) {
    return failure("amount must be a positive integer in cents");
  }
  if (!Number.isInteger(count) || count < 1 || count > 12) {
    return failure("installment count must be between 1 and 12");
  }
  if (monthlyRate < 0) return failure("rate cannot be negative");

  const total =
    monthlyRate === 0
      ? amountCents
      : Math.round(
          (amountCents * monthlyRate * (1 + monthlyRate) ** count) /
            ((1 + monthlyRate) ** count - 1),
        ) * count;

  const base = Math.floor(total / count);
  const remainder = total - base * count;

  const installments: Installment[] = [];
  for (let i = 1; i <= count; i++) {
    installments.push({ number: i, amountCents: i === 1 ? base + remainder : base });
  }
  return success(installments);
}
EOF
cat > src/payment/domain/installments.spec.ts <<'EOF'
import test from "node:test";
import assert from "node:assert/strict";
import { calculateInstallments } from "./installments.ts";

test("with no interest it splits the exact amount", () => {
  const r = calculateInstallments(30000, 3, 0);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.deepEqual(r.value.map((p) => p.amountCents), [10000, 10000, 10000]);
});

test("the installments sum to the total, with the remainder in the first", () => {
  const r = calculateInstallments(10000, 3, 0);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.value.reduce((acc, p) => acc + p.amountCents, 0), 10000);
  assert.equal(r.value[0].amountCents, 3334);
  assert.equal(r.value[1].amountCents, 3333);
});

test("numbers the installments starting at 1", () => {
  const r = calculateInstallments(50000, 4, 0);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.deepEqual(r.value.map((p) => p.number), [1, 2, 3, 4]);
});

test("rejects invalid input without throwing", () => {
  assert.equal(calculateInstallments(0, 3, 0).ok, false);
  assert.equal(calculateInstallments(1000, 13, 0).ok, false);
  assert.equal(calculateInstallments(1000, 3, -0.1).ok, false);
});
EOF
git add -A && git commit -qm wip
git checkout -q main
git merge -q --no-ff feat/installments -m "Merged PR 47: installments with interest in the payment domain" -m "Create \`src/payment/domain/installments.ts\` exporting:

- \`interface Installment { number: number; amountCents: number }\`
- \`calculateInstallments(amountCents: number, count: number, monthlyRate: number): Result<Installment[]>\`

Use the \`Result<T>\` that already exists in \`src/shared/result.ts\` — an input error comes back as a \`failure\`, never as a thrown exception.

Rules:
- everything in cents, as integers;
- a \`monthlyRate\` equal to zero means no interest: split the exact amount;
- installments are numbered starting at 1;
- the installments must sum exactly to the total owed: put the rounding remainder in the FIRST installment;
- reject a non-positive amount, a count outside the range 1 to 12, and a negative rate."

# ─────────────────────────────────────────────── PR 53 (larger)
git checkout -qb feat/reconciliation
cat > src/payment/application/reconciliation.ts <<'EOF'
import { failure, success, type Result } from "../../shared/result.ts";

export interface InternalEntry {
  id: string;
  amountCents: number;
}

export interface AcquirerEntry {
  id: string;
  amountCents: number;
}

export interface Discrepancy {
  id: string;
  kind: "missing-in-acquirer" | "missing-in-internal" | "amount-mismatch";
  internalAmountCents: number | null;
  acquirerAmountCents: number | null;
}

export interface ReconciliationReport {
  reconciled: string[];
  discrepancies: Discrepancy[];
}

/**
 * Reconciles the internal statement against the acquirer's.
 * Deterministic output: everything sorted by id, so that two reports of the
 * same pair of statements are identical.
 */
export function reconcile(
  internal: InternalEntry[],
  acquirer: AcquirerEntry[],
): Result<ReconciliationReport> {
  const internalById = new Map<string, InternalEntry>();
  for (const e of internal) {
    if (internalById.has(e.id)) return failure(`duplicate id in the internal statement: ${e.id}`);
    internalById.set(e.id, e);
  }

  const acquirerById = new Map<string, AcquirerEntry>();
  for (const e of acquirer) {
    if (acquirerById.has(e.id)) return failure(`duplicate id in the acquirer statement: ${e.id}`);
    acquirerById.set(e.id, e);
  }

  const reconciled: string[] = [];
  const discrepancies: Discrepancy[] = [];

  for (const [id, entry] of internalById) {
    const external = acquirerById.get(id);
    if (!external) {
      discrepancies.push({
        id,
        kind: "missing-in-acquirer",
        internalAmountCents: entry.amountCents,
        acquirerAmountCents: null,
      });
      continue;
    }
    if (external.amountCents !== entry.amountCents) {
      discrepancies.push({
        id,
        kind: "amount-mismatch",
        internalAmountCents: entry.amountCents,
        acquirerAmountCents: external.amountCents,
      });
      continue;
    }
    reconciled.push(id);
  }

  for (const [id, external] of acquirerById) {
    if (internalById.has(id)) continue;
    discrepancies.push({
      id,
      kind: "missing-in-internal",
      internalAmountCents: null,
      acquirerAmountCents: external.amountCents,
    });
  }

  reconciled.sort();
  discrepancies.sort((a, b) => a.id.localeCompare(b.id));
  return success({ reconciled, discrepancies });
}
EOF
cat > src/payment/application/reconciliation.spec.ts <<'EOF'
import test from "node:test";
import assert from "node:assert/strict";
import { reconcile } from "./reconciliation.ts";

test("identical statements reconcile completely", () => {
  const r = reconcile(
    [{ id: "b", amountCents: 200 }, { id: "a", amountCents: 100 }],
    [{ id: "a", amountCents: 100 }, { id: "b", amountCents: 200 }],
  );
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.deepEqual(r.value.reconciled, ["a", "b"]);
  assert.equal(r.value.discrepancies.length, 0);
});

test("points out entries missing on both sides and mismatched amounts", () => {
  const r = reconcile(
    [{ id: "a", amountCents: 100 }, { id: "b", amountCents: 200 }],
    [{ id: "b", amountCents: 999 }, { id: "c", amountCents: 300 }],
  );
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.deepEqual(r.value.reconciled, []);
  assert.deepEqual(r.value.discrepancies, [
    { id: "a", kind: "missing-in-acquirer", internalAmountCents: 100, acquirerAmountCents: null },
    { id: "b", kind: "amount-mismatch", internalAmountCents: 200, acquirerAmountCents: 999 },
    { id: "c", kind: "missing-in-internal", internalAmountCents: null, acquirerAmountCents: 300 },
  ]);
});

test("a duplicate id becomes a failure, not an exception", () => {
  assert.equal(reconcile([{ id: "a", amountCents: 1 }, { id: "a", amountCents: 2 }], []).ok, false);
});

test("the output is deterministic, sorted by id", () => {
  const sides = [{ id: "z", amountCents: 1 }, { id: "m", amountCents: 1 }, { id: "a", amountCents: 1 }];
  const r = reconcile(sides, sides);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.deepEqual(r.value.reconciled, ["a", "m", "z"]);
});
EOF
git add -A && git commit -qm wip
git checkout -q main
git merge -q --no-ff feat/reconciliation -m "Merged PR 53: statement reconciliation against the acquirer" -m "Create \`src/payment/application/reconciliation.ts\` exporting:

- \`interface InternalEntry { id: string; amountCents: number }\`
- \`interface AcquirerEntry { id: string; amountCents: number }\`
- \`interface Discrepancy { id: string; kind: 'missing-in-acquirer' | 'missing-in-internal' | 'amount-mismatch'; internalAmountCents: number | null; acquirerAmountCents: number | null }\`
- \`interface ReconciliationReport { reconciled: string[]; discrepancies: Discrepancy[] }\`
- \`reconcile(internal: InternalEntry[], acquirer: AcquirerEntry[]): Result<ReconciliationReport>\`

Rules:
- match the entries by \`id\`;
- an id on both sides with the same amount goes into \`reconciled\` (the id alone);
- an id on both sides with a different amount becomes \`amount-mismatch\`, with both amounts filled in;
- an id only in the internal statement becomes \`missing-in-acquirer\`, with \`acquirerAmountCents\` null;
- an id only in the acquirer statement becomes \`missing-in-internal\`, with \`internalAmountCents\` null;
- a repeated id within the same statement becomes a \`failure\`, never an exception;
- the output must be deterministic: \`reconciled\` and \`discrepancies\` sorted by id."

echo "repository built at $DEST"
git log --oneline --first-parent
