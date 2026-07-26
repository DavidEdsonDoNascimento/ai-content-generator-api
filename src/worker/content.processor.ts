import { UnrecoverableError, type Job } from 'bullmq';

import { ContentStatus } from '../generated/prisma/enums.js';
import type { DbClient } from '../infra/db/prisma.js';
import type { ContentJobData } from '../infra/queue/job.types.js';
import type * as contentRepository from '../modules/contents/content.repository.js';
import { isTerminal } from '../modules/contents/content.state.js';
import {
  AI_GENERATION_FAILED,
  isAiGenerationError,
  type GenerateWithAi,
} from './ai/generate-content.js';

/**
 * O job de geração.
 *
 * Duas propriedades sustentam este arquivo, e nenhuma delas depende de o Worker
 * "se comportar bem":
 *
 * - **idempotência** — entregar de fila é *at-least-once*, então reprocessar o
 *   mesmo `contentId` precisa ser inofensivo. A guarda de estado terminal e o
 *   claim condicional garantem isso (ADR-007);
 * - **o cancelamento sempre vence** — toda escrita de status carrega o estado de
 *   origem no `WHERE`. Como `CANCELED` não pertence a nenhum desses conjuntos, é
 *   fisicamente impossível este código ressuscitar um conteúdo cancelado; não é
 *   uma questão de checar antes, é a cláusula que o PostgreSQL avalia sob lock
 *   (ADR-006).
 *
 * A consistência mora aqui e no repositório — nunca nos listeners do Worker, que
 * existem só para log. Um listener roda depois de o job ter terminado e não tem
 * como impor transição alguma.
 */

/** Log estruturado do processamento. Sem dados sensíveis, só identificadores. */
export interface ProcessorLogger {
  info(context: Record<string, unknown>, message: string): void;
  warn(context: Record<string, unknown>, message: string): void;
  error(context: Record<string, unknown>, message: string): void;
}

export interface ContentProcessorDeps {
  readonly db: DbClient;
  readonly contents: Pick<
    typeof contentRepository,
    'findById' | 'claimForProcessing' | 'completeIfProcessing' | 'failIfProcessing'
  >;
  readonly generate: GenerateWithAi;
  readonly logger: ProcessorLogger;
}

/**
 * Última tentativa?
 *
 * `job.attemptsMade` é **0-based dentro do processor** — verificado
 * empiricamente em `bullmq@5.81.2`: vale 0 na primeira execução, 1 na segunda e
 * 2 na terceira, e só depois da falha definitiva passa a 3. Por isso a
 * comparação soma 1. Presumir a ordem do incremento é o erro que faz `FAILED`
 * ser gravado cedo demais — exatamente o que ADR-005 proíbe —, e é por isso que
 * existe um teste dedicado a esta função.
 */
export function isLastAttempt(job: Pick<Job, 'attemptsMade' | 'opts'>): boolean {
  const total = job.opts.attempts ?? 1;
  return job.attemptsMade + 1 >= total;
}

export function createContentProcessor(
  deps: ContentProcessorDeps,
): (job: Job<ContentJobData>) => Promise<void> {
  return async (job: Job<ContentJobData>): Promise<void> => {
    const { contentId } = job.data;
    const attempt = job.attemptsMade + 1;
    const context = { jobId: job.id, contentId, attempt };

    const content = await deps.contents.findById(deps.db, contentId);

    if (content === null) {
      // Nenhuma tentativa futura fará esta linha existir. Retentar seria queimar
      // as três tentativas para chegar ao mesmo lugar.
      throw new UnrecoverableError(`Conteúdo ${contentId} não existe.`);
    }

    // Guarda de idempotência: reprocessar um conteúdo já resolvido é no-op, e o
    // job termina com **sucesso** — não há o que retentar. Vale tanto para a
    // entrega duplicada quanto para o job tardio de um conteúdo compensado por
    // `QUEUE_UNAVAILABLE`.
    if (isTerminal(content.status)) {
      deps.logger.info(
        { ...context, status: content.status },
        'conteúdo em estado terminal; no-op',
      );
      return;
    }

    const claimed = await deps.contents.claimForProcessing(deps.db, contentId);

    if (!claimed) {
      // Alguém mudou o estado entre a leitura e o claim. O `count = 0` é
      // informação, não erro: outro ator venceu a corrida.
      deps.logger.info(context, 'claim recusado pelo banco; outra transição venceu');
      return;
    }

    deps.logger.info(context, 'processando conteúdo');

    let text: string;

    try {
      text = await deps.generate(content.topic);
    } catch (error) {
      await handleGenerationFailure(deps, job, context, error);
      // Relançar é o que faz o BullMQ contabilizar a tentativa e agendar o
      // retry (ou encerrar o job como falho, na última).
      throw error;
    }

    // Guarda pré-finalização: barata e evita trabalho inútil. **Não** é a
    // garantia — entre esta leitura e o UPDATE ainda cabe um cancelamento. A
    // garantia é o predicado do passo seguinte.
    const current = await deps.contents.findById(deps.db, contentId);

    if (current === null || current.status !== ContentStatus.PROCESSING) {
      deps.logger.info(
        { ...context, status: current?.status ?? 'ausente' },
        'conteúdo saiu de PROCESSING durante a geração; abortando sem finalizar',
      );
      return;
    }

    // Fase 5 encerra aqui, sem arquivo: o upload e o preenchimento de
    // `fileUrl`/`fileKey` pertencem à Fase 6. O texto gerado é descartado de
    // propósito — o banco guarda estado, não conteúdo.
    void text;

    const completed = await deps.contents.completeIfProcessing(deps.db, contentId);

    if (!completed) {
      // O `WHERE status = PROCESSING` não encontrou linha: o usuário cancelou
      // enquanto a IA rodava. O trabalho é descartado e o job encerra como
      // sucesso — o cancelamento é um desfecho legítimo, não uma falha.
      deps.logger.info(context, 'finalização recusada pelo banco; cancelamento venceu');
      return;
    }

    deps.logger.info(context, 'conteúdo concluído');
  };
}

/**
 * Decide o que persistir quando a IA falha.
 *
 * `FAILED` **só** na última tentativa (ADR-005). Nas anteriores o conteúdo
 * permanece em `PROCESSING`: marcar e desmarcar faria o cliente ver o status
 * piscar e violaria a imutabilidade dos terminais. E mesmo na última, a escrita
 * é condicional — um cancelamento que tenha chegado no meio continua vencendo.
 */
async function handleGenerationFailure(
  deps: ContentProcessorDeps,
  job: Job<ContentJobData>,
  context: Record<string, unknown>,
  error: unknown,
): Promise<void> {
  const expected = isAiGenerationError(error);

  if (!expected) {
    // Falha não prevista: o detalhe vai para o log, nunca para o banco nem para
    // o cliente (ADR-010). O retry do BullMQ ainda se aplica.
    deps.logger.error({ ...context, err: error }, 'falha inesperada durante a geração');
  }

  if (!isLastAttempt(job)) {
    deps.logger.warn(
      context,
      'geração falhou; conteúdo permanece em PROCESSING para nova tentativa',
    );
    return;
  }

  const failed = await deps.contents.failIfProcessing(
    deps.db,
    job.data.contentId,
    AI_GENERATION_FAILED,
  );

  deps.logger.error(
    { ...context, persisted: failed },
    'tentativas esgotadas; conteúdo marcado como FAILED',
  );
}
