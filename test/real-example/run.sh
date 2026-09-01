#!/usr/bin/env bash
#
# Reduced real test of the whole harness, against an actual agent CLI.
#
# Unlike the smoke test, nothing here is simulated: a real repository with code
# that compiles, real lint and typecheck, real held-out tests, and a real agent
# implementing the tasks from the work item description.
#
# Usage:
#   bash test/real-example/run.sh                  # 2 arms, 3 tasks, 1 rep
#   ARMS=A0,A2,A5 REPS=2 bash test/real-example/run.sh
#
# Variables:
#   AGENT_CMD    agent executable                (claude)
#   AGENT_ARGS   fixed args, space separated
#   MODEL        pinned model                    (claude-haiku-4-5-20251001)
#   ARMS         arms to run                     (A0,A5)
#   REPS         repetitions per cell            (1)
#   DEST         working directory               (mktemp)
#
# A real benchmark wants REPS>=3 and all six arms. The default here is reduced
# on purpose: this is a test of the harness, not a measurement to decide
# adoption. The report will say so in its validity section, and it is right.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DEST="${DEST:-$(mktemp -d -t bench-real-XXXXXX)}"
AGENT_CMD="${AGENT_CMD:-claude}"
MODEL="${MODEL:-claude-haiku-4-5-20251001}"
ARMS="${ARMS:-A0,A5}"
REPS="${REPS:-1}"

REPO="$DEST/payments-api"
CONFIG="$DEST/bench.config.json"
MANIFEST="$DEST/manifest.json"

command -v "$AGENT_CMD" >/dev/null || {
  echo "agent '$AGENT_CMD' not found in PATH. Adjust AGENT_CMD." >&2
  exit 1
}

echo
echo "== 0. example repository ============================================="
bash "$ROOT/test/real-example/build-repo.sh" "$REPO"

DEFAULT_ARGS='"--print","--output-format","stream-json","--verbose","--permission-mode","acceptEdits","--allowedTools","Read,Write,Edit,Bash,Glob,Grep"'
if [ -n "${AGENT_ARGS:-}" ]; then
  DEFAULT_ARGS=$(printf '%s' "$AGENT_ARGS" | tr ' ' '\n' | sed 's/.*/"&"/' | paste -sd, -)
fi

cat > "$CONFIG" <<JSON
{
  "provider": "local-git",
  "root": "$DEST/.bench",
  "repos": [{ "name": "payments-api", "dir": "$REPO", "defaultBranch": "main" }],
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
      "spec": ["--append-system-prompt", "Before writing any code, write a short plan: the requirements you extracted from the task and the files you will create or change. Only then implement."]
    },
    "timeoutMs": 900000
  }
}
JSON

echo
echo "== 1. calibrate the agent adapter ====================================="
node "$ROOT/src/bench-init.ts" --probe-agent --config "$CONFIG" 2>&1 | tail -20

echo
echo "== 2. golden dataset from the merged PRs =============================="
node "$ROOT/src/select-prs.ts" --config "$CONFIG" \
  --targets 0,50,100 --require-tests --refresh \
  --cache "$DEST/.pr-cache.json" --out "$MANIFEST"

echo
echo "== 3. bootstrap: profile, arms, plan =================================="
node "$ROOT/src/bench-init.ts" --config "$CONFIG" --manifest "$MANIFEST"

echo
echo "== 4. execution ($ARMS, $REPS rep) ===================================="
node "$ROOT/src/bench-run.ts" --config "$CONFIG" --manifest "$MANIFEST" --only-arms "$ARMS"

echo
echo "== 5. report =========================================================="
node "$ROOT/src/bench-report.ts" --root "$DEST/.bench" --by-task \
  --markdown "$DEST/report.md"

echo
echo "artifacts at $DEST"
echo "  runs.jsonl  $DEST/.bench/obs/runs.jsonl"
echo "  logs        $DEST/.bench/logs/"
echo "  report      $DEST/report.md"
