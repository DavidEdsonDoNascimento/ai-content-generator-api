import { buildApp, type AppInstance } from './app.js';
import { loadApiEnv } from './config/api-env.js';
import { env } from './config/env.js';
import { logger } from './config/logger.js';
import { disconnectPrisma, prisma } from './infra/db/prisma.js';
import { closeConnection, createPublisherConnection } from './infra/queue/connection.js';
import { createContentQueue, type ContentQueue } from './infra/queue/content-queue.js';
import { buildContentService } from './modules/contents/content.service.js';

/** Tempo máximo que o encerramento gracioso tem antes de o processo ser derrubado. */
const SHUTDOWN_TIMEOUT_MS = 10_000;

/**
 * *Composition root* da API: é aqui — e só aqui — que as conexões nascem.
 *
 * Concentrar a montagem num ponto só é o que permite ao resto do código não
 * saber se fala com um Redis de verdade ou com um duplo de teste, e é o que
 * torna o encerramento previsível: quem abriu, fecha, na ordem inversa.
 */
function composeQueue(): { queue: ContentQueue; close: () => Promise<void> } {
  // Ambiente específico da API, validado aqui e não no import de um módulo: a
  // API publica jobs, então precisa do Redis — e **não** declara nada de S3,
  // porque não faz upload (ADR-030).
  const apiEnv = loadApiEnv();

  const connection = createPublisherConnection(apiEnv.REDIS_URL);
  const queue = createContentQueue({ connection, attempts: apiEnv.JOB_ATTEMPTS });

  return {
    queue,
    close: async () => {
      await queue.close();
      await closeConnection(connection);
    },
  };
}

function registerShutdownHandlers(app: AppInstance, closeQueue: () => Promise<void>): void {
  let shuttingDown = false;

  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    app.log.info({ signal }, 'encerrando a API');

    // Rede de segurança: se algo travar o `close`, o processo não fica pendurado.
    const forceExit = setTimeout(() => {
      app.log.error('tempo limite de encerramento excedido; finalizando à força');
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);
    forceExit.unref();

    try {
      // Ordem importa: primeiro para de aceitar requisições e drena as que estão
      // em voo, só então fecha a fila e o pool do banco que essas requisições
      // ainda podiam estar usando.
      await app.close();
      await closeQueue();
      await disconnectPrisma();
      app.log.info('API encerrada com sucesso');
      process.exit(0);
    } catch (error) {
      app.log.error({ err: error }, 'falha ao encerrar a API');
      process.exit(1);
    }
  };

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      void shutdown(signal);
    });
  }
}

async function start(): Promise<void> {
  const { queue, close } = composeQueue();

  const contentService = buildContentService({
    db: prisma,
    transaction: (fn) => prisma.$transaction(fn),
    queue,
    logger,
  });

  const app = await buildApp({ contentService });
  registerShutdownHandlers(app, close);

  await app.listen({ host: env.HOST, port: env.PORT });
}

start().catch((error: unknown) => {
  const reason = error instanceof Error ? error.message : 'erro desconhecido';
  process.stderr.write(`Falha ao iniciar a API: ${reason}\n`);
  process.exit(1);
});
