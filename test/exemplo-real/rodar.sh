#!/usr/bin/env bash
#
# Teste real reduzido do harness inteiro, contra um CLI de agente de verdade.
#
# Diferente do smoke test, aqui nada e simulado: repositorio real com codigo
# que compila, lint e typecheck reais, testes held-out reais, e um agente real
# implementando as tarefas a partir da descricao do work item.
#
# Uso:
#   bash test/exemplo-real/rodar.sh                 # 2 arms, 3 tarefas, 1 rep
#   ARMS=A0,A2,A5 REPS=2 bash test/exemplo-real/rodar.sh
#
# Variaveis:
#   AGENT_CMD    executavel do agente             (claude)
#   AGENT_ARGS   args fixos, separados por espaco
#   MODEL        modelo travado                   (claude-haiku-4-5-20251001)
#   ARMS         arms a rodar                     (A0,A5)
#   REPS         repeticoes por celula            (1)
#   DESTINO      diretorio de trabalho            (mktemp)
#
# Um benchmark de verdade quer REPS>=3 e todos os seis arms. O default aqui e
# reduzido de proposito: e um teste do harness, nao uma medicao para decidir
# adocao. O relatorio vai dizer isso na secao de validade, e ele esta certo.
set -euo pipefail

RAIZ="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DESTINO="${DESTINO:-$(mktemp -d -t bench-real-XXXXXX)}"
AGENT_CMD="${AGENT_CMD:-claude}"
MODEL="${MODEL:-claude-haiku-4-5-20251001}"
ARMS="${ARMS:-A0,A5}"
REPS="${REPS:-1}"

REPO="$DESTINO/pagamentos-api"
CONFIG="$DESTINO/bench.config.json"
MANIFEST="$DESTINO/manifest.json"

command -v "$AGENT_CMD" >/dev/null || {
  echo "agente '$AGENT_CMD' nao encontrado no PATH. Ajuste AGENT_CMD." >&2
  exit 1
}

echo
echo "== 0. repositorio de exemplo =========================================="
bash "$RAIZ/test/exemplo-real/monta-repo.sh" "$REPO"

DEFAULT_ARGS='"--print","--output-format","stream-json","--verbose","--permission-mode","acceptEdits","--allowedTools","Read,Write,Edit,Bash,Glob,Grep"'
if [ -n "${AGENT_ARGS:-}" ]; then
  DEFAULT_ARGS=$(printf '%s' "$AGENT_ARGS" | tr ' ' '\n' | sed 's/.*/"&"/' | paste -sd, -)
fi

cat > "$CONFIG" <<JSON
{
  "provider": "local-git",
  "root": "$DESTINO/.bench",
  "repos": [{ "name": "pagamentos-api", "dir": "$REPO", "defaultBranch": "main" }],
  "model": "$MODEL",
  "reps": $REPS,
  "seed": 7,
  "maxGateRetries": 1,
  "gateTimeoutMs": 300000,
  "install": { "enabled": true, "timeoutMs": 600000 },
  "agent": {
    "cmd": "$AGENT_CMD",
    "args": [$DEFAULT_ARGS],
    "promptMode": "stdin",
    "modelFlag": "--model",
    "modeArgs": {
      "vibe": [],
      "spec": ["--append-system-prompt", "Antes de escrever qualquer codigo, escreva um plano curto: os requisitos que voce extraiu da tarefa e os arquivos que vai criar ou alterar. So depois implemente."]
    },
    "timeoutMs": 900000
  }
}
JSON

echo
echo "== 1. calibrar o adapter do agente ===================================="
node "$RAIZ/src/bench-init.ts" --probe-agent --config "$CONFIG" 2>&1 | tail -20

echo
echo "== 2. golden dataset a partir das PRs mergeadas ======================="
node "$RAIZ/src/select-prs.ts" --config "$CONFIG" \
  --targets 0,50,100 --require-tests --refresh \
  --cache "$DESTINO/.pr-cache.json" --out "$MANIFEST"

echo
echo "== 3. bootstrap: perfil, arms, plano =================================="
node "$RAIZ/src/bench-init.ts" --config "$CONFIG" --manifest "$MANIFEST"

echo
echo "== 4. execucao ($ARMS, $REPS rep) ====================================="
node "$RAIZ/src/bench-run.ts" --config "$CONFIG" --manifest "$MANIFEST" --only-arms "$ARMS"

echo
echo "== 5. relatorio ======================================================="
node "$RAIZ/src/bench-report.ts" --root "$DESTINO/.bench" --by-task \
  --markdown "$DESTINO/relatorio.md"

echo
echo "artefatos em $DESTINO"
echo "  runs.jsonl  $DESTINO/.bench/obs/runs.jsonl"
echo "  logs        $DESTINO/.bench/logs/"
echo "  relatorio   $DESTINO/relatorio.md"
