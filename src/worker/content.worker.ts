import { Worker, type Job } from 'bullmq';
import type { Redis } from 'ioredis';

import { CONTENT_QUEUE_NAME, type ContentJobData } from '../infra/queue/job.types.js';
import type { ProcessorLogger } from './content.processor.js';

/**
 * O Worker BullMQ.
 *
 * Ele é uma casca fina de propósito: consome a fila e delega ao processor. Os
 * listeners abaixo servem **apenas para observabilidade** — nenhuma transição de
 * estado acontece neles. A tentação de marcar `FAILED` no evento `failed` é
 * comum e errada: o listener roda depois de o job ter terminado, sem acesso ao
 * predicado de estado, e transformaria a consistência num efeito colateral de
 * evento. A decisão vive no processor, dentro de `UPDATE`s condicionais.
 */

/**
 * Quanto tempo o Worker segura o lock de um job antes que a fila o considere
 * abandonado. Precisa folgar bem sobre os 5 s da IA: se o lock expirar com o job
 * ainda rodando, o BullMQ entrega o mesmo job a outro Worker e passam a existir
 * dois processadores para o mesmo conteúdo. O claim condicional impediria dano,
 * mas o desperdício seria real.
 */
export const LOCK_DURATION_MS = 60_000;

/** Jobs processados em paralelo por instância (0002 §9). */
export const DEFAULT_CONCURRENCY = 5;

export interface ContentWorkerOptions {
  readonly connection: Redis;
  readonly processor: (job: Job<ContentJobData>) => Promise<void>;
  readonly logger: ProcessorLogger;
  readonly concurrency?: number;
  readonly lockDurationMs?: number;
  /** Isolamento entre suítes de teste; a aplicação usa o nome padrão. */
  readonly queueName?: string;
}

export function createContentWorker(options: ContentWorkerOptions): Worker<ContentJobData> {
  const worker = new Worker<ContentJobData>(
    options.queueName ?? CONTENT_QUEUE_NAME,
    options.processor,
    {
      connection: options.connection,
      concurrency: options.concurrency ?? DEFAULT_CONCURRENCY,
      lockDuration: options.lockDurationMs ?? LOCK_DURATION_MS,
    },
  );

  worker.on('completed', (job: Job<ContentJobData>) => {
    options.logger.info({ jobId: job.id, contentId: job.data.contentId }, 'job concluído');
  });

  worker.on('failed', (job: Job<ContentJobData> | undefined, error: Error) => {
    options.logger.warn(
      {
        jobId: job?.id,
        contentId: job?.data.contentId,
        attemptsMade: job?.attemptsMade,
        // Só a mensagem, e só no log: o banco guarda um código do catálogo.
        reason: error.message,
      },
      'job falhou',
    );
  });

  worker.on('error', (error: Error) => {
    // Erro da própria infraestrutura da fila (conexão, lock). Sem listener, o
    // BullMQ emitiria um evento de erro não tratado e derrubaria o processo.
    options.logger.error({ err: error }, 'erro do worker');
  });

  return worker;
}
