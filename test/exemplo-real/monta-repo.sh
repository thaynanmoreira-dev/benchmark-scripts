#!/usr/bin/env bash
#
# Monta um repositorio realista de servico de pagamentos em Node/TypeScript,
# com tres PRs mergeadas de tamanhos diferentes. Codigo de verdade, testes de
# verdade, lint e typecheck de verdade — nada de mock.
#
# Cada PR e um merge commit cuja mensagem e o work item: a descricao que o
# agente vai receber, e nada alem dela. Os testes de cada PR viram o grader
# held-out, invisivel no commit base porque so passam a existir no merge.
#
# Uso: bash test/exemplo-real/monta-repo.sh <destino>
set -euo pipefail

DESTINO="${1:?informe o diretorio destino}"
rm -rf "$DESTINO"; mkdir -p "$DESTINO"; cd "$DESTINO"

git init -q -b main .
git config user.email dev@exemplo.invalid
git config user.name "Fixture"

# ─────────────────────────────────────────────── commit base
mkdir -p src/shared src/pagamento/domain src/pagamento/application scripts

cat > .gitignore <<'EOF'
node_modules/
EOF

cat > package.json <<'EOF'
{
  "name": "pagamentos-api",
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
// Lint minimo e deterministico: proibe `any` e console.log em src/.
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const erros = [];
const walk = (dir) => {
  for (const e of readdirSync(dir)) {
    const p = path.join(dir, e);
    if (statSync(p).isDirectory()) { walk(p); continue; }
    if (!p.endsWith(".ts")) continue;
    readFileSync(p, "utf8").split("\n").forEach((linha, i) => {
      if (/:\s*any\b/.test(linha)) erros.push(`${p}:${i + 1} uso de \`any\``);
      if (/console\.log\(/.test(linha)) erros.push(`${p}:${i + 1} console.log em src/`);
    });
  }
};
walk("src");
if (erros.length) { console.error(erros.join("\n")); process.exit(1); }
console.log("lint ok");
EOF

cat > src/shared/resultado.ts <<'EOF'
export type Resultado<T> = { ok: true; valor: T } | { ok: false; erro: string };

export function sucesso<T>(valor: T): Resultado<T> {
  return { ok: true, valor };
}

export function falha<T>(erro: string): Resultado<T> {
  return { ok: false, erro };
}
EOF

cat > src/shared/resultado.spec.ts <<'EOF'
import test from "node:test";
import assert from "node:assert/strict";
import { falha, sucesso } from "./resultado.ts";

test("sucesso carrega o valor", () => {
  assert.equal(sucesso(10).ok, true);
});

test("falha carrega o erro", () => {
  assert.equal(falha<number>("ruim").ok, false);
});
EOF

cat > src/pagamento/domain/moeda.ts <<'EOF'
/** Centavos, sempre. Ponto flutuante em dinheiro e incidente na certa. */
export function reaisParaCentavos(reais: number): number {
  return Math.round(reais * 100);
}

export function centavosParaReais(centavos: number): number {
  return centavos / 100;
}
EOF

npm install --silent --no-audit --no-fund >/dev/null 2>&1
git add -A && git commit -qm "chore: estrutura inicial do servico de pagamentos"

# ─────────────────────────────────────────────── PR 41 (pequena)
git checkout -qb feat/cpf
cat > src/shared/cpf.ts <<'EOF'
/** Valida CPF pelos dois digitos verificadores. Ignora pontuacao. */
export function cpfValido(cpf: string): boolean {
  const digitos = cpf.replace(/\D/g, "");
  if (digitos.length !== 11) return false;
  if (/^(\d)\1{10}$/.test(digitos)) return false;

  const calcular = (ate: number): number => {
    let soma = 0;
    for (let i = 0; i < ate; i++) soma += Number(digitos[i]) * (ate + 1 - i);
    const resto = (soma * 10) % 11;
    return resto === 10 ? 0 : resto;
  };

  return calcular(9) === Number(digitos[9]) && calcular(10) === Number(digitos[10]);
}
EOF
cat > src/shared/cpf.spec.ts <<'EOF'
import test from "node:test";
import assert from "node:assert/strict";
import { cpfValido } from "./cpf.ts";

test("aceita CPF valido com e sem pontuacao", () => {
  assert.equal(cpfValido("529.982.247-25"), true);
  assert.equal(cpfValido("52998224725"), true);
});

test("recusa digito verificador errado", () => {
  assert.equal(cpfValido("529.982.247-24"), false);
});

test("recusa tamanho errado", () => {
  assert.equal(cpfValido("1234567890"), false);
});

test("recusa sequencia de digitos repetidos", () => {
  assert.equal(cpfValido("111.111.111-11"), false);
});
EOF
git add -A && git commit -qm wip
git checkout -q main
git merge -q --no-ff feat/cpf -m "Merged PR 41: validacao de CPF no shared" -m "Criar \`src/shared/cpf.ts\` exportando \`cpfValido(cpf: string): boolean\`.

Regras:
- aceitar CPF com ou sem pontuacao (pontos e hifen);
- validar os dois digitos verificadores pelo algoritmo oficial (modulo 11);
- recusar string que nao tenha 11 digitos;
- recusar sequencia de digitos todos iguais, como 111.111.111-11, que passa no modulo 11 mas nao e CPF valido."

# ─────────────────────────────────────────────── PR 47 (media)
git checkout -qb feat/parcelamento
cat > src/pagamento/domain/parcelamento.ts <<'EOF'
import { falha, sucesso, type Resultado } from "../../shared/resultado.ts";

export interface Parcela {
  numero: number;
  valorCentavos: number;
}

/**
 * Parcelamento com juros compostos pela Tabela Price.
 * Todo o calculo roda em centavos; a diferenca de arredondamento vai na
 * primeira parcela para que a soma feche exatamente com o total devido.
 */
export function calcularParcelas(
  valorCentavos: number,
  quantidade: number,
  taxaMensal: number,
): Resultado<Parcela[]> {
  if (!Number.isInteger(valorCentavos) || valorCentavos <= 0) {
    return falha("valor deve ser inteiro positivo em centavos");
  }
  if (!Number.isInteger(quantidade) || quantidade < 1 || quantidade > 12) {
    return falha("quantidade de parcelas deve estar entre 1 e 12");
  }
  if (taxaMensal < 0) return falha("taxa nao pode ser negativa");

  const total =
    taxaMensal === 0
      ? valorCentavos
      : Math.round(
          (valorCentavos * taxaMensal * (1 + taxaMensal) ** quantidade) /
            ((1 + taxaMensal) ** quantidade - 1),
        ) * quantidade;

  const base = Math.floor(total / quantidade);
  const sobra = total - base * quantidade;

  const parcelas: Parcela[] = [];
  for (let i = 1; i <= quantidade; i++) {
    parcelas.push({ numero: i, valorCentavos: i === 1 ? base + sobra : base });
  }
  return sucesso(parcelas);
}
EOF
cat > src/pagamento/domain/parcelamento.spec.ts <<'EOF'
import test from "node:test";
import assert from "node:assert/strict";
import { calcularParcelas } from "./parcelamento.ts";

test("sem juros divide o valor exato", () => {
  const r = calcularParcelas(30000, 3, 0);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.deepEqual(r.valor.map((p) => p.valorCentavos), [10000, 10000, 10000]);
});

test("a soma das parcelas fecha com o total, com sobra na primeira", () => {
  const r = calcularParcelas(10000, 3, 0);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.valor.reduce((acc, p) => acc + p.valorCentavos, 0), 10000);
  assert.equal(r.valor[0].valorCentavos, 3334);
  assert.equal(r.valor[1].valorCentavos, 3333);
});

test("numera as parcelas a partir de 1", () => {
  const r = calcularParcelas(50000, 4, 0);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.deepEqual(r.valor.map((p) => p.numero), [1, 2, 3, 4]);
});

test("recusa entrada invalida sem lancar excecao", () => {
  assert.equal(calcularParcelas(0, 3, 0).ok, false);
  assert.equal(calcularParcelas(1000, 13, 0).ok, false);
  assert.equal(calcularParcelas(1000, 3, -0.1).ok, false);
});
EOF
git add -A && git commit -qm wip
git checkout -q main
git merge -q --no-ff feat/parcelamento -m "Merged PR 47: parcelamento com juros no dominio de pagamento" -m "Criar \`src/pagamento/domain/parcelamento.ts\` exportando:

- \`interface Parcela { numero: number; valorCentavos: number }\`
- \`calcularParcelas(valorCentavos: number, quantidade: number, taxaMensal: number): Resultado<Parcela[]>\`

Usar o \`Resultado<T>\` que ja existe em \`src/shared/resultado.ts\` — erro de entrada volta como \`falha\`, nunca como excecao.

Regras:
- tudo em centavos, inteiros;
- \`taxaMensal\` igual a zero significa sem juros: divide o valor exato;
- as parcelas sao numeradas a partir de 1;
- a soma das parcelas tem de fechar exatamente com o total devido: jogue a sobra do arredondamento na PRIMEIRA parcela;
- recusar valor nao positivo, quantidade fora do intervalo de 1 a 12, e taxa negativa."

# ─────────────────────────────────────────────── PR 53 (maior)
git checkout -qb feat/conciliacao
cat > src/pagamento/application/conciliacao.ts <<'EOF'
import { falha, sucesso, type Resultado } from "../../shared/resultado.ts";

export interface LancamentoInterno {
  id: string;
  valorCentavos: number;
}

export interface LancamentoAdquirente {
  id: string;
  valorCentavos: number;
}

export interface Divergencia {
  id: string;
  tipo: "ausente-no-adquirente" | "ausente-no-interno" | "valor-divergente";
  valorInternoCentavos: number | null;
  valorAdquirenteCentavos: number | null;
}

export interface RelatorioConciliacao {
  conciliados: string[];
  divergencias: Divergencia[];
}

/**
 * Concilia o extrato interno contra o do adquirente.
 * Saida deterministica: tudo ordenado por id, para que dois relatorios do
 * mesmo par de extratos sejam identicos.
 */
export function conciliar(
  internos: LancamentoInterno[],
  adquirente: LancamentoAdquirente[],
): Resultado<RelatorioConciliacao> {
  const porIdInterno = new Map<string, LancamentoInterno>();
  for (const l of internos) {
    if (porIdInterno.has(l.id)) return falha(`id duplicado no extrato interno: ${l.id}`);
    porIdInterno.set(l.id, l);
  }

  const porIdAdquirente = new Map<string, LancamentoAdquirente>();
  for (const l of adquirente) {
    if (porIdAdquirente.has(l.id)) return falha(`id duplicado no extrato do adquirente: ${l.id}`);
    porIdAdquirente.set(l.id, l);
  }

  const conciliados: string[] = [];
  const divergencias: Divergencia[] = [];

  for (const [id, interno] of porIdInterno) {
    const externo = porIdAdquirente.get(id);
    if (!externo) {
      divergencias.push({
        id,
        tipo: "ausente-no-adquirente",
        valorInternoCentavos: interno.valorCentavos,
        valorAdquirenteCentavos: null,
      });
      continue;
    }
    if (externo.valorCentavos !== interno.valorCentavos) {
      divergencias.push({
        id,
        tipo: "valor-divergente",
        valorInternoCentavos: interno.valorCentavos,
        valorAdquirenteCentavos: externo.valorCentavos,
      });
      continue;
    }
    conciliados.push(id);
  }

  for (const [id, externo] of porIdAdquirente) {
    if (porIdInterno.has(id)) continue;
    divergencias.push({
      id,
      tipo: "ausente-no-interno",
      valorInternoCentavos: null,
      valorAdquirenteCentavos: externo.valorCentavos,
    });
  }

  conciliados.sort();
  divergencias.sort((a, b) => a.id.localeCompare(b.id));
  return sucesso({ conciliados, divergencias });
}
EOF
cat > src/pagamento/application/conciliacao.spec.ts <<'EOF'
import test from "node:test";
import assert from "node:assert/strict";
import { conciliar } from "./conciliacao.ts";

test("extratos iguais conciliam tudo", () => {
  const r = conciliar(
    [{ id: "b", valorCentavos: 200 }, { id: "a", valorCentavos: 100 }],
    [{ id: "a", valorCentavos: 100 }, { id: "b", valorCentavos: 200 }],
  );
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.deepEqual(r.valor.conciliados, ["a", "b"]);
  assert.equal(r.valor.divergencias.length, 0);
});

test("aponta ausente dos dois lados e valor divergente", () => {
  const r = conciliar(
    [{ id: "a", valorCentavos: 100 }, { id: "b", valorCentavos: 200 }],
    [{ id: "b", valorCentavos: 999 }, { id: "c", valorCentavos: 300 }],
  );
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.deepEqual(r.valor.conciliados, []);
  assert.deepEqual(r.valor.divergencias, [
    { id: "a", tipo: "ausente-no-adquirente", valorInternoCentavos: 100, valorAdquirenteCentavos: null },
    { id: "b", tipo: "valor-divergente", valorInternoCentavos: 200, valorAdquirenteCentavos: 999 },
    { id: "c", tipo: "ausente-no-interno", valorInternoCentavos: null, valorAdquirenteCentavos: 300 },
  ]);
});

test("id duplicado vira falha, nao excecao", () => {
  assert.equal(conciliar([{ id: "a", valorCentavos: 1 }, { id: "a", valorCentavos: 2 }], []).ok, false);
});

test("saida e deterministica, ordenada por id", () => {
  const lados = [{ id: "z", valorCentavos: 1 }, { id: "m", valorCentavos: 1 }, { id: "a", valorCentavos: 1 }];
  const r = conciliar(lados, lados);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.deepEqual(r.valor.conciliados, ["a", "m", "z"]);
});
EOF
git add -A && git commit -qm wip
git checkout -q main
git merge -q --no-ff feat/conciliacao -m "Merged PR 53: conciliacao de extrato contra o adquirente" -m "Criar \`src/pagamento/application/conciliacao.ts\` exportando:

- \`interface LancamentoInterno { id: string; valorCentavos: number }\`
- \`interface LancamentoAdquirente { id: string; valorCentavos: number }\`
- \`interface Divergencia { id: string; tipo: 'ausente-no-adquirente' | 'ausente-no-interno' | 'valor-divergente'; valorInternoCentavos: number | null; valorAdquirenteCentavos: number | null }\`
- \`interface RelatorioConciliacao { conciliados: string[]; divergencias: Divergencia[] }\`
- \`conciliar(internos: LancamentoInterno[], adquirente: LancamentoAdquirente[]): Resultado<RelatorioConciliacao>\`

Regras:
- casar os lancamentos por \`id\`;
- id nos dois com mesmo valor entra em \`conciliados\` (so o id);
- id nos dois com valor diferente vira \`valor-divergente\`, com os dois valores preenchidos;
- id so no interno vira \`ausente-no-adquirente\`, com \`valorAdquirenteCentavos\` nulo;
- id so no adquirente vira \`ausente-no-interno\`, com \`valorInternoCentavos\` nulo;
- id repetido dentro do mesmo extrato vira \`falha\`, nunca excecao;
- a saida tem de ser deterministica: \`conciliados\` e \`divergencias\` ordenados por id."

echo "repositorio montado em $DESTINO"
git log --oneline --first-parent
