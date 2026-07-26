#!/bin/sh
# Serviço one-shot de migrations (ADR-022). Roda antes da API subir, aplica as
# migrations pendentes e — só quando explicitamente habilitado — o seed de
# desenvolvimento.
#
# `set -e` é o que garante o comportamento exigido: se `migrate deploy` falhar,
# o script sai com código diferente de zero, o serviço `migrate` é marcado como
# falho e o `depends_on: service_completed_successfully` impede a API de subir
# contra um schema desatualizado.
set -eu

echo "[migrate] aplicando migrations pendentes"
./node_modules/.bin/prisma migrate deploy

if [ "${RUN_SEED:-false}" = "true" ]; then
  echo "[migrate] RUN_SEED=true — executando seed idempotente de desenvolvimento"
  ./node_modules/.bin/prisma db seed
else
  echo "[migrate] RUN_SEED != true — seed ignorado"
fi

echo "[migrate] concluído com sucesso"
