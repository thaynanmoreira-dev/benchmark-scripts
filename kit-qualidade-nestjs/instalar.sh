#!/usr/bin/env bash
#
# Instala o kit de qualidade num serviço NestJS.
#
# Copia as regras do Kiro, as configs das ferramentas e os dois scripts de gate
# para o repositório alvo, e imprime o que falta fazer à mão (dependências e
# scripts do package.json, que não dá para mesclar às cegas).
#
# Uso:
#   bash instalar.sh /caminho/do/servico
#   MODO=catraca bash instalar.sh /caminho/do/servico   # repo existente
#
# MODO=novo     (padrão) exige zero supressões desde o primeiro dia
# MODO=catraca  fixa as supressões atuais como linha de base; dali só pode cair
set -euo pipefail

KIT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ALVO="${1:?uso: bash instalar.sh /caminho/do/servico}"
MODO="${MODO:-novo}"

[ -f "$ALVO/package.json" ] || { echo "erro: $ALVO não tem package.json" >&2; exit 1; }

echo "instalando o kit em $ALVO (modo: $MODO)"

# ── regras do Kiro
mkdir -p "$ALVO/.kiro/steering"
for f in "$KIT"/.kiro/steering/*.md; do
  nome="$(basename "$f")"
  if [ -e "$ALVO/.kiro/steering/$nome" ]; then
    echo "  mantido (já existe): .kiro/steering/$nome"
  else
    cp "$f" "$ALVO/.kiro/steering/$nome"
    echo "  criado: .kiro/steering/$nome"
  fi
done

# ── configs das ferramentas
for f in eslint.config.mjs jest.config.mjs stryker.config.mjs knip.json .jscpd.json .dependency-cruiser.cjs .swcrc; do
  if [ -e "$ALVO/$f" ]; then
    cp "$KIT/config/$f" "$ALVO/$f.kit"
    echo "  ATENÇÃO: $f já existe — o do kit ficou em $f.kit para você mesclar"
  else
    cp "$KIT/config/$f" "$ALVO/$f"
    echo "  criado: $f"
  fi
done

# ── scripts de gate
mkdir -p "$ALVO/tools"
cp "$KIT"/tools/halstead.mjs "$KIT"/tools/sem-atalho.mjs "$ALVO/tools/"
echo "  criado: tools/halstead.mjs, tools/sem-atalho.mjs"

# ── pipeline
if [ -d "$ALVO/.azuredevops" ] || [ -f "$ALVO/azure-pipelines.yml" ]; then
  mkdir -p "$ALVO/.azuredevops"
  cp "$KIT/ci/azure-pipelines-gates.yml" "$ALVO/.azuredevops/"
  echo "  criado: .azuredevops/azure-pipelines-gates.yml (referencie no seu pipeline)"
fi

# ── linha de base das supressões
cd "$ALVO"
if [ "$MODO" = "catraca" ]; then
  node tools/sem-atalho.mjs --gravar
  echo "  linha de base gravada. Revise .gates-baseline.json no PR: cada número ali é dívida."
else
  echo '{}' > .gates-baseline.json
  echo "  criado: .gates-baseline.json zerado (modo novo)"
fi

cat <<'FIM'

Falta fazer à mão:

0) PREENCHA .kiro/steering/produto.md

   Ele vem como template, com TODO nas três seções de domínio. Enquanto não for
   preenchido, o agente trabalha sem saber o que este serviço faz — que é
   justamente a parte que nenhum gate consegue verificar por você.

O package.json não dá para mesclar às cegas:

1) devDependencies (versões verificadas juntas):

   npm i -D --save-exact \
     typescript@5.9.3 @types/node@22.20.1 \
     eslint@9.39.5 typescript-eslint@8.69.0 eslint-plugin-sonarjs@4.2.0 \
     jest@29.7.0 @types/jest@29.5.14 @swc/core@1.13.5 @swc/jest@0.2.39 \
     @stryker-mutator/core@10.0.0 @stryker-mutator/jest-runner@10.0.0 \
     @stryker-mutator/typescript-checker@10.0.0 \
     knip@6.34.0 jscpd@5.1.1 dependency-cruiser@17.4.3

2) REMOVA o ts-jest se o serviço usa (o Nest CLI põe por padrão):

   npm rm ts-jest

   ts-jest@29 exige @babel/core 7 e o Stryker 10 exige o 8; o npm não consegue
   içar os dois e a instalação do zero falha com ERESOLVE. `overrides` não
   resolve, só troca o sintoma. O .swcrc que o kit instalou substitui o ts-jest
   com decoratorMetadata ligado, que é o que a DI do Nest precisa.

3) scripts no package.json:

   "typecheck":     "tsc --noEmit",
   "lint":          "eslint src/",
   "arch":          "depcruise src --config .dependency-cruiser.cjs",
   "halstead":      "node tools/halstead.mjs --max 80 'src/**/*.ts'",
   "sem-atalho":    "node tools/sem-atalho.mjs",
   "deadcode":      "knip",
   "duplication":   "jscpd src --config .jscpd.json",
   "test":          "jest",
   "mutation":      "stryker run",
   "gates:rapidos": "npm run typecheck && npm run lint && npm run arch && npm run halstead && npm run sem-atalho && npm run deadcode && npm run duplication && npm test",
   "gates":         "npm run gates:rapidos && npm run mutation"

4) Depois: npm run gates:rapidos

   Repo existente vai acusar bastante. Leia a seção "Adotando em código que já
   existe" no README do kit antes de sair corrigindo — ligar os onze de uma vez
   é como o time desiste na primeira semana.
FIM
