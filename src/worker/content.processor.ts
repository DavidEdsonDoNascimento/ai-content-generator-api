import { UnrecoverableError, type Job } from 'bullmq';

import { ContentStatus } from '../generated/prisma/enums.js';
import type { DbClient } from '../infra/db/prisma.js';
import type { ContentJobData } from '../infra/queue/job.types.js';
import { buildContentKey } from '../infra/storage/storage.service.js';
import type { StorageService } from '../infra/storage/storage.types.js';
import type * as contentRepository from '../modules/contents/content.repository.js';
import {
  CONTENT_FAILURE_CODES,
  type ContentFailureCode,
} from '../modules/contents/content.failure.js';
import { isTerminal } from '../modules/contents/content.state.js';
import type { GenerateWithAi } from './ai/generate-content.js';

/**
 * O job de geração.
 *
 * Três propriedades sustentam este arquivo, e nenhuma delas depende de o Worker
 * "se comportar bem":
 *
 * - **idempotência** — entregar de fila é *at-least-once*, então reprocessar o
 *   mesmo `contentId` precisa ser inofensivo. A guarda de estado terminal, o
 *   claim condicional e a chave determinística garantem isso (ADR-007);
 * - **o cancelamento sempre vence** — toda escrita de status carrega o estado de
 *   origem no `WHERE`. Como `CANCELED` não pertence a nenhum desses conjuntos, é
 *   fisicamente impossível este código ressuscitar um conteúdo cancelado; não é
 *   uma questão de checar antes, é a cláusula que o PostgreSQL avalia sob lock
 *   (ADR-006);
 * - **nunca apagar o arquivo de um `COMPLETED`** — a chave é determinística, o
 *   que torna retry seguro mas também faz duas execuções concorrentes gravarem
 *   no mesmo lugar. A limpeza de órfão por isso **não** é cega; ver
 *   `resolveLostFinalization`.
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

export const TEXT_CONTENT_TYPE = 'text/plain; charset=utf-8';

export interface ContentProcessorDeps {
  readonly db: DbClient;
  readonly contents: Pick<
    typeof contentRepository,
    'findById' | 'claimForProcessing' | 'completeIfProcessing' | 'failIfProcessing'
  >;
  readonly generate: GenerateWithAi;
  readonly storage: Pick<StorageService, 'upload' | 'remove' | 'buildPublicUrl'>;
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

/** O que fazer depois de tratar uma falha: devolver ao BullMQ ou encerrar em paz. */
type FailureOutcome = 'rethrow' | 'noop';

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
    // job termina com **sucesso** — não há o que retentar. Nenhuma chamada ao
    // storage acontece por este caminho.
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
      // Classificação **posicional**: só o que sai da IA vira
      // `AI_GENERATION_FAILED`. Um `catch` único em volta do processor inteiro
      // rotularia falha de upload como falha de IA, e o cliente veria o motivo
      // errado.
      const outcome = await handleFailure(
        deps,
        job,
        context,
        CONTENT_FAILURE_CODES.AI_GENERATION_FAILED,
        error,
      );

      if (outcome === 'rethrow') {
        // Relançar é o que faz o BullMQ contabilizar a tentativa e agendar o
        // retry (ou encerrar o job como falho, na última).
        throw error;
      }
      return;
    }

    // Guarda pré-upload: barata e evita mandar bytes para o S3 à toa. **Não** é
    // a garantia — entre esta leitura e o UPDATE final ainda cabe um
    // cancelamento. A garantia é o predicado da finalização.
    const beforeUpload = await deps.contents.findById(deps.db, contentId);

    if (beforeUpload === null || beforeUpload.status !== ContentStatus.PROCESSING) {
      deps.logger.info(
        { ...context, status: beforeUpload?.status ?? 'ausente' },
        'conteúdo saiu de PROCESSING durante a geração; abortando antes do upload',
      );
      return;
    }

    const key = buildContentKey(contentId);

    try {
      await deps.storage.upload({
        key,
        body: Buffer.from(text, 'utf8'),
        contentType: TEXT_CONTENT_TYPE,
      });
    } catch (error) {
      const outcome = await handleFailure(
        deps,
        job,
        context,
        CONTENT_FAILURE_CODES.UPLOAD_FAILED,
        error,
      );

      if (outcome === 'rethrow') {
        throw error;
      }
      return;
    }

    const fileUrl = deps.storage.buildPublicUrl(key);

    // `status`, `fileKey`, `fileUrl` e `completedAt` numa instrução só: nunca
    // existe um instante em que o conteúdo está COMPLETED sem arquivo.
    const completed = await deps.contents.completeIfProcessing(deps.db, contentId, {
      fileKey: key,
      fileUrl,
    });

    if (!completed) {
      // O `WHERE status = PROCESSING` não encontrou linha. O objeto já subiu, e
      // decidir o que fazer com ele exige olhar quem venceu.
      await resolveLostFinalization(deps, contentId, key, context);
      return;
    }

    deps.logger.info({ ...context, fileKey: key }, 'conteúdo concluído');
  };
}

/**
 * Decide o destino do objeto quando a finalização condicional não afeta linha.
 *
 * **Aqui mora o risco mais sutil desta fase.** A limpeza ingênua seria
 * `if (!completed) remove(key)` — e ela apaga arquivo bom. Como a chave é
 * determinística, duas execuções do mesmo `contentId` gravam no **mesmo**
 * objeto; se uma vence a finalização e a outra perde, a perdedora estaria
 * removendo justamente o arquivo que o `COMPLETED` da vencedora referencia.
 *
 * A regra que ordena todos os casos: **nunca apagar objeto referenciado por um
 * conteúdo `COMPLETED`.** Na dúvida, preserva-se — um órfão custa alguns
 * kilobytes, um `COMPLETED` apontando para arquivo inexistente é dado corrompido.
 */
async function resolveLostFinalization(
  deps: ContentProcessorDeps,
  contentId: string,
  key: string,
  context: Record<string, unknown>,
): Promise<void> {
  const current = await deps.contents.findById(deps.db, contentId);

  if (current === null) {
    // A linha sumiu (cascade de usuário removido). Nada referencia o objeto.
    await removeBestEffort(deps, key, context, 'conteúdo inexistente');
    return;
  }

  if (current.status === ContentStatus.COMPLETED) {
    if (current.fileKey === key) {
      // Outra execução venceu **apontando para esta mesma chave**: o objeto que
      // acabamos de gravar é exatamente o que o vencedor promete ao cliente.
      deps.logger.warn(
        { ...context, status: current.status, fileKey: key },
        'finalização perdida para outra execução com a mesma chave; objeto preservado',
      );
      return;
    }

    // COMPLETED apontando para outra chave: a nossa não é referenciada.
    await removeBestEffort(deps, key, context, 'conteúdo concluído com outra chave');
    return;
  }

  if (isTerminal(current.status)) {
    // CANCELED ou FAILED: ninguém vai referenciar este objeto.
    await removeBestEffort(deps, key, context, `conteúdo em ${current.status}`);
    return;
  }

  // PENDING/PROCESSING inesperado — outra execução reclamou o conteúdo e vai
  // gravar nesta mesma chave determinística. Remover agora apagaria o arquivo
  // dela. Preservar é a escolha que não corrompe nada.
  deps.logger.warn(
    { ...context, status: current.status, fileKey: key },
    'finalização perdida com o conteúdo ainda ativo; objeto preservado por segurança',
  );
}

/**
 * Remoção que **nunca** lança. O cancelamento já está commitado e o job já é um
 * sucesso: falhar aqui não pode alterar o estado nem disparar retry — retentar a
 * IA inteira só para limpar um arquivo de conteúdo cancelado seria trocar alguns
 * kilobytes por 15 segundos de trabalho.
 */
async function removeBestEffort(
  deps: ContentProcessorDeps,
  key: string,
  context: Record<string, unknown>,
  reason: string,
): Promise<void> {
  try {
    await deps.storage.remove(key);
    deps.logger.info({ ...context, fileKey: key, reason }, 'objeto órfão removido');
  } catch (error) {
    deps.logger.warn(
      { ...context, fileKey: key, reason, err: error },
      'falha ao remover objeto órfão; o estado do conteúdo permanece correto',
    );
  }
}

/**
 * Persiste (ou não) a falha e decide se ela volta para o BullMQ.
 *
 * `FAILED` **só** na última tentativa (ADR-005). Nas anteriores o conteúdo
 * permanece em `PROCESSING`: marcar e desmarcar faria o cliente ver o status
 * piscar e violaria a imutabilidade dos terminais. E mesmo na última, a escrita
 * é condicional — um cancelamento que tenha chegado no meio continua vencendo.
 *
 * Quando o conteúdo já está terminal, o resultado é `noop`: o job encerra como
 * **sucesso**, porque cancelamento não é falha de domínio do conteúdo (ADR-005)
 * e retentar não levaria a lugar nenhum.
 */
async function handleFailure(
  deps: ContentProcessorDeps,
  job: Job<ContentJobData>,
  context: Record<string, unknown>,
  code: ContentFailureCode,
  error: unknown,
): Promise<FailureOutcome> {
  // O erro completo vai **só** para o log: stack, endpoint, host e credencial
  // nunca chegam ao banco nem ao cliente (ADR-010).
  deps.logger.error({ ...context, code, err: error }, 'falha durante o processamento');

  if (!isLastAttempt(job)) {
    const current = await deps.contents.findById(deps.db, job.data.contentId);

    if (current === null || isTerminal(current.status)) {
      deps.logger.info(
        { ...context, status: current?.status ?? 'ausente' },
        'conteúdo já resolvido por outro ator; falha não será retentada',
      );
      return 'noop';
    }

    deps.logger.warn(
      { ...context, code },
      'falhou; conteúdo permanece em PROCESSING para nova tentativa',
    );
    return 'rethrow';
  }

  const persisted = await deps.contents.failIfProcessing(deps.db, job.data.contentId, code);

  if (!persisted) {
    // O predicado não encontrou `PROCESSING`: o usuário cancelou durante a
    // falha. O `CANCELED` sobrevive e o job encerra em paz.
    deps.logger.info(context, 'falha definitiva descartada; o conteúdo já saiu de PROCESSING');
    return 'noop';
  }

  deps.logger.error({ ...context, code }, 'tentativas esgotadas; conteúdo marcado como FAILED');
  return 'rethrow';
}
