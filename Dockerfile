# syntax=docker/dockerfile:1
#
# Imagem da API. Multi-stage: instala deps uma vez, compila o TypeScript,
# reinstala só as deps de produção e monta um runtime mínimo, sem privilégio
# de root. Nesta fase não há Prisma: nenhuma migration roda no boot.
#
# A versão do Node é fixada em 22.17.1 — a mesma já validada localmente na
# Fase 1 — para que dev e container rodem exatamente o mesmo runtime.

# -----------------------------------------------------------------------------
# deps: todas as dependências (incluindo dev), necessárias só para compilar.
# -----------------------------------------------------------------------------
FROM node:22.17.1-alpine3.22 AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

# -----------------------------------------------------------------------------
# build: compila src/ (TypeScript estrito) para dist/.
# -----------------------------------------------------------------------------
FROM node:22.17.1-alpine3.22 AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json package-lock.json tsconfig.json ./
COPY src ./src
RUN npm run build

# -----------------------------------------------------------------------------
# prod-deps: reinstala só as dependências de produção (sem devDependencies).
# -----------------------------------------------------------------------------
FROM node:22.17.1-alpine3.22 AS prod-deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# -----------------------------------------------------------------------------
# runner: imagem final. Só dist/ + node_modules de produção; usuário sem
# privilégio (o `node`, já criado pela imagem oficial); sinais chegam direto
# ao processo Node (PID 1) porque o CMD está em forma exec, sem shell no meio.
# -----------------------------------------------------------------------------
FROM node:22.17.1-alpine3.22 AS runner
ENV NODE_ENV=production
WORKDIR /app

COPY --from=prod-deps --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node package.json ./

USER node
EXPOSE 3000

CMD ["node", "dist/main.js"]

# -----------------------------------------------------------------------------
# minio-init: estágio independente (não participa da imagem da API acima).
# `minio/mc` oficial não tem shell (base ubi9-micro) — não dá para encadear
# `alias set && mb && anonymous set` dentro dele. Aqui usamos alpine (que tem
# `/bin/sh`) e copiamos só o binário `mc` da imagem oficial via `COPY --from`,
# sem baixar nada da internet em tempo de execução.
# -----------------------------------------------------------------------------
FROM alpine:3.22.5 AS minio-init
COPY --from=minio/mc:RELEASE.2025-08-13T08-35-41Z /usr/bin/mc /usr/bin/mc
COPY docker/minio-init.sh /minio-init.sh
RUN chmod +x /minio-init.sh
ENTRYPOINT ["/bin/sh", "/minio-init.sh"]
