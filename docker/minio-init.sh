#!/bin/sh
# Bootstrap idempotente do bucket do Minio. Roda uma vez por `docker compose up`
# (serviço one-shot `minio-init`), mas pode ser executado quantas vezes for
# preciso sem erro: `mc mb --ignore-existing` não falha se o bucket já existe,
# e reaplicar a mesma policy de leitura é um no-op.
#
# `depends_on: minio: condition: service_healthy` no compose já garante que o
# Minio está de pé antes deste script rodar — por isso não há um loop de
# espera aqui: a espera é responsabilidade da orquestração, não do script.
set -eu

ALIAS="local"
ENDPOINT="http://minio:9000"

: "${MINIO_ROOT_USER:?MINIO_ROOT_USER não definido}"
: "${MINIO_ROOT_PASSWORD:?MINIO_ROOT_PASSWORD não definido}"
: "${MINIO_BUCKET:?MINIO_BUCKET não definido}"

echo "[minio-init] configurando alias '${ALIAS}' -> ${ENDPOINT}"
mc alias set "${ALIAS}" "${ENDPOINT}" "${MINIO_ROOT_USER}" "${MINIO_ROOT_PASSWORD}"

echo "[minio-init] garantindo o bucket '${MINIO_BUCKET}'"
mc mb --ignore-existing "${ALIAS}/${MINIO_BUCKET}"

echo "[minio-init] aplicando policy de leitura pública em '${MINIO_BUCKET}'"
mc anonymous set download "${ALIAS}/${MINIO_BUCKET}"

echo "[minio-init] concluído com sucesso"
