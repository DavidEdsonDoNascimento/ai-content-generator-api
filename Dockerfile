# syntax=docker/dockerfile:1
#
# Imagem da API. Multi-stage: instala deps uma vez, compila o TypeScript,
# reinstala só as deps de produção e monta um runtime mínimo, sem privilégio
# de root.
#
# A versão do Node é fixada em 22.17.1 — a mesma já validada localmente na
# Fase 1 — para que dev e container rodem exatamente o mesmo runtime.
#
# Prisma 7 é "Rust-free": o client não embarca engine binário, então a imagem
# final não precisa de OpenSSL nem de binário de query engine. O engine nativo
# de *schema* (usado só por `migrate`) fica no estágio `migrator`, fora da
# imagem da API — ver ADR-022.

# -----------------------------------------------------------------------------
# deps: todas as dependências (incluindo dev), necessárias só para compilar.
# -----------------------------------------------------------------------------
FROM node:22.17.1-alpine3.22 AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

# -----------------------------------------------------------------------------
# build: gera o Prisma Client e compila src/ (TypeScript estrito) para dist/.
# `npm run build` já encadeia `prisma generate && tsc`. O generate não acessa
# banco algum — por isso não há DATABASE_URL aqui.
# -----------------------------------------------------------------------------
FROM node:22.17.1-alpine3.22 AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json package-lock.json tsconfig.json tsconfig.build.json prisma.config.ts ./
COPY prisma ./prisma
COPY src ./src
RUN npm run build

# -----------------------------------------------------------------------------
# prod-deps: reinstala só as dependências de produção.
#
# `--omit=optional` não é decoração: `@prisma/client` declara `prisma` (a CLI)
# como *optional peer dependency*, e por isso a CLI não é marcada como `dev` no
# lockfile — `--omit=dev` sozinho a mantém, arrastando ~275 MB de ferramentas
# que a API nunca executa (CLI, Studio, engines de schema, @prisma/dev).
# Com as duas flags, node_modules cai de ~374 MB para ~96 MB e o runtime segue
# completo: o client Rust-free precisa apenas de @prisma/client + adapter + pg.
# -----------------------------------------------------------------------------
FROM node:22.17.1-alpine3.22 AS prod-deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --omit=optional

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
# migrator: serviço one-shot que aplica as migrations antes de a API subir
# (ADR-022). Precisa do que a imagem da API deliberadamente NÃO tem: a CLI do
# Prisma (devDependency), o engine nativo de schema, o schema e as migrations.
# Mantê-lo separado é o que permite que a imagem da API continue sem dev deps.
#
# `src/` vem do estágio `build` já com `src/generated/` dentro, porque o seed
# importa o mesmo cliente Prisma que a aplicação usa — assim o seed exercita o
# caminho real, e não uma segunda instanciação paralela.
# -----------------------------------------------------------------------------
FROM node:22.17.1-alpine3.22 AS migrator
ENV NODE_ENV=production
# A CLI do Prisma executa o comando de seed (`tsx prisma/seed.ts`) como um
# processo filho, sem o PATH que o `npm run` monta. Sem isto, o seed falha com
# `spawn tsx ENOENT` dentro do container, embora funcione no host.
ENV PATH="/app/node_modules/.bin:${PATH}"
WORKDIR /app

COPY --from=deps --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node package.json package-lock.json tsconfig.json prisma.config.ts ./
COPY --chown=node:node prisma ./prisma
COPY --from=build --chown=node:node /app/src ./src
COPY --chown=node:node docker/migrate-entrypoint.sh /usr/local/bin/migrate-entrypoint.sh
RUN chmod +x /usr/local/bin/migrate-entrypoint.sh

USER node
ENTRYPOINT ["/bin/sh", "/usr/local/bin/migrate-entrypoint.sh"]

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
