import { Queue } from 'bullmq';
import type { Redis } from 'ioredis';

import { CONTENT_JOB_NAME, CONTENT_QUEUE_NAME, type ContentJobData } from './job.types.js';

/**
 * Fila de geração de conteúdo.
 *
 * Construída por **factory**, nunca no topo do módulo: importar este arquivo não
 * pode abrir conexão com o Redis, senão um teste unitário de regra de negócio
 * passaria a depender de infraestrutura de verdade. Quem monta a fila são os
 * *composition roots* — `src/main.ts`, `src/worker.ts` e os testes.
 */

/** Backoff de produção entre tentativas (~2 s e ~4 s com o exponencial). */
export const DEFAULT_BACKOFF_DELAY_MS = 2_000;

/**
 * Estados dos quais um job ainda pode ser retirado da fila. `active` fica de
 * fora porque um job em execução está travado por um Worker — e é exatamente o
 * caso que o predicado de status no banco já resolve (ADR-006).
 */
const REMOVABLE_STATES = new Set(['waiting', 'delayed', 'prioritized', 'waiting-children']);

/** Resultado da tentativa de remoção. Nenhum deles é erro para o cliente. */
export type JobRemovalOutcome =
  /** Job estava na fila e foi retirado. */
  | 'removed'
  /** Job existe, mas está `active` ou virou `active` no meio do caminho. */
  | 'not-removable'
  /** Não há job com este id — já executou, ou nunca chegou a ser publicado. */
  | 'absent'
  /** Redis indisponível. O cancelamento no banco continua valendo. */
  | 'unavailable';

/** O que o `ContentService` precisa da fila — e nada além disso. */
export interface ContentQueuePublisher {
  /** Publica o job. **Lança** se o Redis não aceitar: o service compensa. */
  enqueue(contentId: string): Promise<void>;
  /** Remoção best-effort. **Nunca lança** — o cancelamento já foi confirmado. */
  removeIfPending(contentId: string): Promise<JobRemovalOutcome>;
}

export interface ContentQueue extends ContentQueuePublisher {
  close(): Promise<void>;
}

export interface ContentQueueOptions {
  readonly connection: Redis;
  /** Tentativas por job, contando a primeira. Padrão: 3 (ADR-005). */
  readonly attempts?: number;
  /** Injetável para que os testes não esperem segundos entre as tentativas. */
  readonly backoffDelayMs?: number;
  /** Isolamento entre suítes de teste; a aplicação usa o nome padrão. */
  readonly queueName?: string;
}

export function createContentQueue(options: ContentQueueOptions): ContentQueue {
  const attempts = options.attempts ?? 3;
  const backoffDelayMs = options.backoffDelayMs ?? DEFAULT_BACKOFF_DELAY_MS;

  const queue = new Queue<ContentJobData>(options.queueName ?? CONTENT_QUEUE_NAME, {
    connection: options.connection,
    defaultJobOptions: {
      attempts,
      backoff: { type: 'exponential', delay: backoffDelayMs },
      // Retenção deliberada: os últimos jobs ficam para inspeção. Remover tudo
      // na hora apagaria a evidência de um retry logo depois de ele acontecer —
      // e é a existência da chave do job que dá o dedupe por `jobId`.
      removeOnComplete: { count: 100 },
      removeOnFail: { count: 500 },
    },
  });

  return {
    async enqueue(contentId: string): Promise<void> {
      // `jobId = contentId` (ADR-007): dedupe de graça — um segundo `add` com o
      // mesmo id é ignorado enquanto o job existir — e rastreabilidade direta
      // entre log da fila e linha do banco.
      await queue.add(CONTENT_JOB_NAME, { contentId }, { jobId: contentId });
    },

    async removeIfPending(contentId: string): Promise<JobRemovalOutcome> {
      try {
        const job = await queue.getJob(contentId);

        if (job === undefined) {
          return 'absent';
        }

        const state = await job.getState();

        if (!REMOVABLE_STATES.has(state)) {
          return 'not-removable';
        }

        try {
          await job.remove();
          return 'removed';
        } catch {
          // Corrida real: entre `getState` e `remove` o Worker pegou o job. O
          // BullMQ recusa remover job travado, e está certo — a garantia do
          // cancelamento é o `WHERE status` do banco, não esta limpeza.
          return 'not-removable';
        }
      } catch {
        return 'unavailable';
      }
    },

    async close(): Promise<void> {
      await queue.close();
    },
  };
}
