import { logger } from './config/logger.js';
import { loadWorkerEnv } from './config/worker-env.js';
import { disconnectPrisma, prisma } from './infra/db/prisma.js';
import { closeConnection, createWorkerConnection } from './infra/queue/connection.js';
import { createS3Client } from './infra/storage/s3-client.js';
import { createStorageService } from './infra/storage/storage.service.js';
import * as contentRepository from './modules/contents/content.repository.js';
import { createAiGenerator } from './worker/ai/generate-content.js';
import { createContentProcessor } from './worker/content.processor.js';
import { createContentWorker, DEFAULT_CONCURRENCY } from './worker/content.worker.js';

/**
 * *Composition root* do Worker — processo separado da API (ADR-012: mesma
 * imagem, `command` diferente).
 *
 * Nada de Fastify aqui. O Worker não serve HTTP e não deve carregar rotas,
 * plugins ou porta: o acoplamento inverso (Worker importando `routes/`) é o que
 * transformaria dois processos independentes num só, disfarçado.
 *
 * É também o único processo que valida configuração de S3 — a API não faz
 * upload, e o container de migrations não fala nem com Redis nem com storage
 * (ADR-029/ADR-030).
 */

/**
 * Teto do encerramento gracioso. Precisa acomodar um job em voo — até 5 s de IA
 * mais o upload e a escrita final —, senão o `SIGTERM` mataria trabalho que
 * estava a segundos de terminar.
 */
const SHUTDOWN_TIMEOUT_MS = 30_000;

async function start(): Promise<void> {
  const env = loadWorkerEnv();

  const connection = createWorkerConnection(env.REDIS_URL);

  // Endpoint **interno**: é por aqui que o Worker fala com o Minio. A URL que
  // vai para o banco vem de `S3_PUBLIC_BASE_URL`, e as duas nunca se cruzam.
  const s3Client = createS3Client({
    endpoint: env.S3_ENDPOINT,
    region: env.S3_REGION,
    accessKeyId: env.S3_ACCESS_KEY_ID,
    secretAccessKey: env.S3_SECRET_ACCESS_KEY,
  });

  const storage = createStorageService({
    client: s3Client,
    bucket: env.S3_BUCKET,
    publicBaseUrl: env.S3_PUBLIC_BASE_URL,
  });

  const processor = createContentProcessor({
    db: prisma,
    contents: contentRepository,
    generate: createAiGenerator({
      delayMs: env.AI_DELAY_MS,
      failureRate: env.AI_FAILURE_RATE,
    }),
    storage,
    logger,
  });

  const worker = createContentWorker({ connection, processor, logger });

  let shuttingDown = false;

  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    // Idempotente: um segundo SIGTERM durante o encerramento é ignorado, em vez
    // de disparar um segundo `close` sobre conexões já fechando.
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    logger.info({ signal }, 'encerrando o worker');

    const forceExit = setTimeout(() => {
      logger.error('tempo limite de encerramento excedido; finalizando à força');
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);
    forceExit.unref();

    try {
      // Ordem inversa da abertura, e ela importa: `close()` para de puxar jobs
      // novos e **aguarda** os ativos terminarem — é o que evita abandonar um
      // conteúdo em PROCESSING sem ninguém para finalizá-lo. Só depois os
      // recursos que esse job podia estar usando são liberados: fila, storage e
      // banco.
      await worker.close();
      await closeConnection(connection);
      storage.close();
      await disconnectPrisma();
      logger.info('worker encerrado com sucesso');
      process.exit(0);
    } catch (error) {
      logger.error({ err: error }, 'falha ao encerrar o worker');
      process.exit(1);
    }
  };

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      void shutdown(signal);
    });
  }

  await worker.waitUntilReady();
  logger.info(
    {
      concurrency: DEFAULT_CONCURRENCY,
      aiDelayMs: env.AI_DELAY_MS,
      bucket: env.S3_BUCKET,
      // Endereços sim, credenciais **nunca**.
      s3Endpoint: env.S3_ENDPOINT,
      s3PublicBaseUrl: env.S3_PUBLIC_BASE_URL,
    },
    'worker pronto, consumindo a fila',
  );
}

start().catch((error: unknown) => {
  const reason = error instanceof Error ? error.message : 'erro desconhecido';
  process.stderr.write(`Falha ao iniciar o worker: ${reason}\n`);
  process.exit(1);
});
