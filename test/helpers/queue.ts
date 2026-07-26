import { Queue, type Job, type Worker } from 'bullmq';
import type { Redis } from 'ioredis';

import { prisma } from '../../src/infra/db/prisma.js';
import {
  closeConnection,
  createPublisherConnection,
  createWorkerConnection,
} from '../../src/infra/queue/connection.js';
import { createContentQueue, type ContentQueue } from '../../src/infra/queue/content-queue.js';
import type { ContentJobData } from '../../src/infra/queue/job.types.js';
import * as contentRepository from '../../src/modules/contents/content.repository.js';
import type { StorageService } from '../../src/infra/storage/storage.types.js';
import type { GenerateWithAi } from '../../src/worker/ai/generate-content.js';
import { createContentProcessor } from '../../src/worker/content.processor.js';
import { createContentWorker } from '../../src/worker/content.worker.js';

/**
 * Fila e Worker **reais**, contra o Redis de teste.
 *
 * Só duas coisas são substituídas, e por motivos diferentes:
 *
 * - a **IA**, porque os 5 s e os 20 % de falha são aleatoriedade e espera, não
 *   invariante — o teste injeta um duplo determinístico;
 * - o **backoff**, reduzido a milissegundos, para a suíte não passar 6 s parada
 *   entre tentativas.
 *
 * Fila, Worker, conexões, processor e repositórios são os de produção. Cada
 * suíte usa um `queueName` próprio: nomes compartilhados fariam um Worker de um
 * arquivo consumir o job de outro.
 */

export interface QueueContext {
  readonly queue: ContentQueue;
  /** Handle cru, para inspecionar jobs — o que a fachada de produção não expõe. */
  readonly raw: Queue<ContentJobData>;
  readonly publisherConnection: Redis;
  readonly workerConnection: Redis;
  close(): Promise<void>;
}

export interface QueueContextOptions {
  readonly queueName: string;
  readonly attempts?: number;
  readonly backoffDelayMs?: number;
}

export function createQueueContext(options: QueueContextOptions): QueueContext {
  const redisUrl = process.env['REDIS_URL'];

  if (redisUrl === undefined || redisUrl === '') {
    throw new Error('REDIS_URL ausente no ambiente de teste.');
  }

  const publisherConnection = createPublisherConnection(redisUrl);
  const workerConnection = createWorkerConnection(redisUrl);

  const queue = createContentQueue({
    connection: publisherConnection,
    queueName: options.queueName,
    attempts: options.attempts ?? 3,
    backoffDelayMs: options.backoffDelayMs ?? 10,
  });

  const raw = new Queue<ContentJobData>(options.queueName, { connection: publisherConnection });

  return {
    queue,
    raw,
    publisherConnection,
    workerConnection,
    close: async () => {
      await raw.close();
      await queue.close();
      await closeConnection(publisherConnection);
      await closeConnection(workerConnection);
    },
  };
}

const silentLogger = {
  info: (): void => undefined,
  warn: (): void => undefined,
  error: (): void => undefined,
};

export interface StartWorkerOptions {
  readonly context: QueueContext;
  readonly queueName: string;
  readonly generate: GenerateWithAi;
  readonly storage: StorageService;
  readonly concurrency?: number;
}

/**
 * Sobe o Worker de produção com a IA injetada. O processor e os repositórios são
 * os reais — é neles que mora a garantia que estes testes existem para provar.
 */
export function startWorker(options: StartWorkerOptions): Worker<ContentJobData> {
  const processor = createContentProcessor({
    db: prisma,
    contents: contentRepository,
    generate: options.generate,
    storage: options.storage,
    logger: silentLogger,
  });

  return createContentWorker({
    connection: options.context.workerConnection,
    processor,
    logger: silentLogger,
    queueName: options.queueName,
    concurrency: options.concurrency ?? 5,
    // Curto o suficiente para o teste ser rápido, longo o bastante para caber
    // qualquer job desta suíte sem o lock expirar no meio.
    lockDurationMs: 30_000,
  });
}

/** O processor real, para exercitar idempotência sem passar pela fila. */
export function buildProcessor(
  generate: GenerateWithAi,
  storage: StorageService,
): (job: Job<ContentJobData>) => Promise<void> {
  return createContentProcessor({
    db: prisma,
    contents: contentRepository,
    generate,
    storage,
    logger: silentLogger,
  });
}

/** Job mínimo: o processor lê apenas `id`, `data`, `attemptsMade` e `opts`. */
export function fakeJob(contentId: string, attemptsMade = 0, attempts = 3): Job<ContentJobData> {
  return {
    id: contentId,
    data: { contentId },
    attemptsMade,
    opts: { attempts },
  } as unknown as Job<ContentJobData>;
}
