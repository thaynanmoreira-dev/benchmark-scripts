#!/usr/bin/env bash
#
# Installs the quality kit into a NestJS service.
#
# Copies the Kiro rules, the tool configs and the gate scripts into the target
# repository, then prints what is left to do by hand (dependencies and
# package.json scripts, which cannot be merged blindly).
#
# Usage:
#   bash install.sh /path/to/service
#   MODE=ratchet bash install.sh /path/to/service   # existing repo
#
# MODE=new      (default) requires zero suppressions from day one
# MODE=ratchet  records the current suppressions as the baseline; from there the
#               number may only go down
set -euo pipefail

KIT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TARGET="${1:?usage: bash install.sh /path/to/service}"
MODE="${MODE:-new}"

[ -f "$TARGET/package.json" ] || { echo "error: $TARGET has no package.json" >&2; exit 1; }

echo "installing the kit into $TARGET (mode: $MODE)"

# ── Kiro rules
mkdir -p "$TARGET/.kiro/steering"
for f in "$KIT"/.kiro/steering/*.md; do
  name="$(basename "$f")"
  if [ -e "$TARGET/.kiro/steering/$name" ]; then
    echo "  kept (already exists): .kiro/steering/$name"
  else
    cp "$f" "$TARGET/.kiro/steering/$name"
    echo "  created: .kiro/steering/$name"
  fi
done

# ── tool configuration
for f in eslint.config.mjs jest.config.mjs stryker.config.mjs knip.json .jscpd.json \
         .dependency-cruiser.cjs .swcrc .prettierrc.json .prettierignore \
         .ls-lint.yml .secretlintrc.json; do
  if [ -e "$TARGET/$f" ]; then
    cp "$KIT/config/$f" "$TARGET/$f.kit"
    echo "  WARNING: $f already exists — the kit copy is at $f.kit for you to merge"
  else
    cp "$KIT/config/$f" "$TARGET/$f"
    echo "  created: $f"
  fi
done

# ── gate scripts
mkdir -p "$TARGET/tools"
cp "$KIT"/tools/*.mjs "$TARGET/tools/"
echo "  created: tools/{gates,gates-intact,contract,halstead,no-bypass}.mjs"
mkdir -p "$TARGET/.kiro/contracts"

# ── Kiro hooks: the gates stop depending on the agent remembering
mkdir -p "$TARGET/.kiro/hooks"
if [ -e "$TARGET/.kiro/hooks/gates.json" ]; then
  echo "  kept (already exists): .kiro/hooks/gates.json"
else
  cp "$KIT/.kiro/hooks/gates.json" "$TARGET/.kiro/hooks/"
  echo "  created: .kiro/hooks/gates.json"
fi

# ── instructions for agents that are not Kiro
if [ -e "$TARGET/AGENTS.md" ]; then
  cp "$KIT/templates/AGENTS.md" "$TARGET/AGENTS.md.kit"
  echo "  WARNING: AGENTS.md already exists — the kit copy is at AGENTS.md.kit"
else
  cp "$KIT/templates/AGENTS.md" "$TARGET/AGENTS.md"
  echo "  created: AGENTS.md"
fi

# ── from nothing to running, with no manual step
mkdir -p "$TARGET/bin"
if [ -e "$TARGET/bin/setup" ]; then
  echo "  kept (already exists): bin/setup"
else
  cp "$KIT/templates/bin/setup" "$TARGET/bin/setup"
  chmod +x "$TARGET/bin/setup"
  echo "  created: bin/setup (review the backing-services section)"
fi

# ── pipeline
if [ -d "$TARGET/.azuredevops" ] || [ -f "$TARGET/azure-pipelines.yml" ]; then
  mkdir -p "$TARGET/.azuredevops"
  cp "$KIT/ci/azure-pipelines-gates.yml" "$TARGET/.azuredevops/"
  echo "  created: .azuredevops/azure-pipelines-gates.yml (reference it from your pipeline)"
fi

# ── suppression baseline
cd "$TARGET"
if [ "$MODE" = "ratchet" ]; then
  node tools/no-bypass.mjs --record
  echo "  baseline recorded. Review .gates-baseline.json in the PR: every number there is debt."
else
  echo '{}' > .gates-baseline.json
  echo "  created: .gates-baseline.json, empty (new mode)"
fi

cat <<'END'

Left to do by hand:

0) FILL IN .kiro/steering/product.md

   It ships as a template, with TODO in the three domain sections. Until it is
   filled in, the agent works without knowing what this service does — which is
   exactly the part no gate can verify for you.

package.json cannot be merged blindly:

1) devDependencies (versions verified together):

   npm i -D --save-exact \
     typescript@5.9.3 @types/node@22.20.1 \
     eslint@9.39.5 typescript-eslint@8.69.0 eslint-plugin-sonarjs@4.2.0 \
     jest@29.7.0 @types/jest@29.5.14 @swc/core@1.13.5 @swc/jest@0.2.39 \
     eslint-plugin-jest@29.16.6 eslint-config-prettier@10.1.8 prettier@3.9.6 \
     @stryker-mutator/core@10.0.0 @stryker-mutator/jest-runner@10.0.0 \
     @stryker-mutator/typescript-checker@10.0.0 \
     knip@6.34.0 jscpd@5.1.1 dependency-cruiser@17.4.3 \
     type-coverage@2.30.1 @ls-lint/ls-lint@2.3.1 \
     secretlint@13.0.5 @secretlint/secretlint-rule-preset-recommend@13.0.5

2) REMOVE ts-jest if the service uses it (the Nest CLI adds it by default):

   npm rm ts-jest

   ts-jest@29 requires @babel/core 7 and Stryker 10 requires 8; npm cannot hoist
   both and a clean install fails with ERESOLVE. `overrides` does not fix it, it
   only moves the symptom. The .swcrc the kit installed replaces ts-jest with
   decoratorMetadata enabled, which is what Nest dependency injection needs.

3) package.json scripts — copy them from example/package.json, which is the
   verified version. There are 19, including:

   "format", "format:check", "typecheck", "contract", "typecoverage", "lint",
   "arch", "structure", "halstead", "secrets", "vulns", "no-bypass",
   "gates-intact", "deadcode", "duplication", "test", "mutation",
   "gates:fast", "gates"

4) Then: bin/setup

   An existing repo will report plenty. Read the "Adotando em código que já
   existe" section of the kit README before fixing things at random — turning on
   all fifteen at once is how a team gives up in the first week.
END
