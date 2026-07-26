import type {
  ContentQueuePublisher,
  JobRemovalOutcome,
} from '../../src/infra/queue/content-queue.js';

/**
 * Duplo de fila que **registra** o que foi publicado.
 *
 * Usado onde a invariante em teste é do banco, não do Redis — débito de crédito,
 * cancelamento, contrato HTTP. Nesses casos subir um Redis de verdade só
 * acrescentaria uma razão de o teste falhar sem acrescentar nada ao que ele
 * prova. O duplo ainda permite a asserção que importa nesses cenários: que
 * **nada** foi publicado quando a requisição foi recusada.
 *
 * A garantia da fila em si — dedupe, retry, `jobId` — é provada contra Redis
 * real, em `test/integration/worker.test.ts`.
 */
export interface RecordingQueue extends ContentQueuePublisher {
  readonly enqueued: string[];
  readonly removed: string[];
}

export interface RecordingQueueOptions {
  /** Erro lançado por `enqueue`, para exercitar a compensação. */
  readonly enqueueError?: Error;
  /** Resultado devolvido por `removeIfPending`. Padrão: `removed`. */
  readonly removalOutcome?: JobRemovalOutcome;
}

export function createRecordingQueue(options: RecordingQueueOptions = {}): RecordingQueue {
  const enqueued: string[] = [];
  const removed: string[] = [];

  return {
    enqueued,
    removed,

    async enqueue(contentId: string): Promise<void> {
      if (options.enqueueError !== undefined) {
        throw options.enqueueError;
      }
      enqueued.push(contentId);
    },

    async removeIfPending(contentId: string): Promise<JobRemovalOutcome> {
      removed.push(contentId);
      return options.removalOutcome ?? 'removed';
    },
  };
}
