import type { ContentQueuePublisher } from '../../infra/queue/content-queue.js';
import type { DbClient } from '../../infra/db/prisma.js';
import {
  ContentNotFoundError,
  InsufficientCreditsError,
  QueueUnavailableError,
  UserNotFoundError,
} from '../../shared/errors/domain-errors.js';
import * as userRepository from '../users/user.repository.js';
import {
  toCancelContentResponse,
  toContentResponse,
  toGenerateContentResponse,
} from './content.mapper.js';
import * as contentRepository from './content.repository.js';
import type {
  CancelContentResponse,
  ContentResponse,
  GenerateContentBody,
  GenerateContentResponse,
} from './content.schemas.js';
import { cancelRejectionFor } from './content.state.js';

/**
 * Regra de negócio do módulo de conteúdo.
 *
 * O service não conhece `FastifyRequest` nem `FastifyReply`: recebe dados
 * validados, devolve dados ou lança erro de domínio. Testar qualquer regra daqui
 * não exige subir o Fastify — é o critério prático que mantém a separação
 * honesta (ADR-011).
 */

/** Só o que o service precisa registrar: avisos de operação best-effort. */
export interface ServiceLogger {
  warn(context: Record<string, unknown>, message: string): void;
  error(context: Record<string, unknown>, message: string): void;
}

/**
 * Dependências injetadas. Os tipos dos repositórios são **derivados dos módulos
 * reais**, não interfaces escritas à mão: não há abstração a manter em
 * sincronia, e ainda assim os testes unitários podem passar fakes (ADR-011).
 *
 * `db` e `transaction` são separados porque as operações têm escopos diferentes:
 * `generate` precisa de duas escritas atômicas, o resto é uma escrita ou uma
 * leitura só — atômicas por si, sem transação.
 */
export interface ContentServiceDeps {
  readonly db: DbClient;
  readonly transaction: <T>(fn: (tx: DbClient) => Promise<T>) => Promise<T>;
  readonly users: Pick<typeof userRepository, 'debitCredit' | 'exists' | 'refundCredit'>;
  readonly contents: Pick<
    typeof contentRepository,
    'create' | 'findById' | 'cancelIfCancelable' | 'failForQueueUnavailable'
  >;
  readonly queue: ContentQueuePublisher;
  readonly logger: ServiceLogger;
}

export interface ContentService {
  generate(input: GenerateContentBody): Promise<GenerateContentResponse>;
  getById(id: string): Promise<ContentResponse>;
  cancel(id: string): Promise<CancelContentResponse>;
}

export function createContentService(deps: ContentServiceDeps): ContentService {
  /**
   * Desfaz a cobrança quando o job não pôde ser publicado (ADR-008).
   *
   * As duas escritas ficam na mesma transação, e o estorno só acontece se o
   * `UPDATE` condicional do conteúdo tiver afetado uma linha — é esse `count`
   * que torna a compensação idempotente: chamada duas vezes, ela devolve
   * crédito uma vez só, porque `creditRefundedAt` já não é mais nulo.
   */
  async function compensate(contentId: string, userId: string): Promise<void> {
    await deps.transaction(async (tx) => {
      const compensated = await deps.contents.failForQueueUnavailable(tx, contentId);

      if (compensated) {
        await deps.users.refundCredit(tx, userId);
      }
    });
  }

  return {
    /**
     * Cobra 1 crédito, registra o conteúdo em `PENDING` e publica o job.
     *
     * A ordem é deliberada e não pode ser trocada:
     *
     * 1. débito + criação na **mesma** transação (debitar e falhar ao inserir
     *    cobraria o usuário por nada);
     * 2. **commit**;
     * 3. só então `queue.add`.
     *
     * Publicar dentro da transação inverteria o risco para o lado pior: o job
     * poderia ser consumido antes do commit, e o Worker encontraria um
     * `contentId` que ainda não existe no banco. Fora da transação, o pior caso
     * é um conteúdo `PENDING` sem job — que é justamente o que a compensação
     * abaixo resolve, de forma visível para o cliente.
     */
    async generate(input: GenerateContentBody): Promise<GenerateContentResponse> {
      const content = await deps.transaction(async (tx) => {
        const debited = await deps.users.debitCredit(tx, input.userId);

        if (!debited) {
          // Lançar aqui desfaz a transação inteira. O débito não afetou linha
          // alguma, então o rollback é no-op — mas manter o `throw` dentro do
          // escopo é o que garante que nenhuma escrita futura escape.
          const userExists = await deps.users.exists(tx, input.userId);
          throw userExists ? new InsufficientCreditsError() : new UserNotFoundError();
        }

        return deps.contents.create(tx, { userId: input.userId, topic: input.topic });
      });

      try {
        await deps.queue.enqueue(content.id);
      } catch (error) {
        // O detalhe do Redis fica no log; o cliente recebe um código estável.
        deps.logger.error(
          { contentId: content.id, userId: content.userId, err: error },
          'falha ao publicar o job de geração; compensando',
        );

        await compensate(content.id, content.userId);
        throw new QueueUnavailableError();
      }

      return toGenerateContentResponse(content);
    },

    async getById(id: string): Promise<ContentResponse> {
      const content = await deps.contents.findById(deps.db, id);

      if (content === null) {
        throw new ContentNotFoundError();
      }

      return toContentResponse(content);
    },

    /**
     * Cancela o conteúdo, resolvendo a corrida com o Worker **no banco**.
     *
     * O `UPDATE` condicional é a decisão: ou ele encontra `PENDING`/`PROCESSING`
     * e cancela, ou não afeta linha alguma. Não há leitura antes — um
     * `SELECT` + `if` + `update` perderia a corrida com o Worker exatamente no
     * cenário que o enunciado cobra (cancelar durante os 5 s da IA).
     *
     * A limpeza da fila vem **depois** da confirmação no banco, e é
     * best-effort: se o job já está `active`, se já saiu da fila ou se o Redis
     * caiu, o cancelamento continua valendo — a guarda de estado no processor
     * faz o Worker terminar em no-op. Inverter a ordem seria pior de um jeito
     * silencioso: removeríamos um job de um cancelamento que o banco ainda pode
     * recusar.
     */
    async cancel(id: string): Promise<CancelContentResponse> {
      const canceled = await deps.contents.cancelIfCancelable(deps.db, id);

      if (canceled !== null) {
        const { canceledAt } = canceled;

        if (canceledAt === null) {
          // Inalcançável: o mesmo UPDATE que gravou CANCELED gravou canceledAt.
          throw new Error(`Conteúdo ${id} cancelado sem canceledAt.`);
        }

        const outcome = await deps.queue.removeIfPending(id);

        if (outcome !== 'removed' && outcome !== 'absent') {
          deps.logger.warn(
            { contentId: id, outcome },
            'cancelamento confirmado no banco, mas o job não pôde ser retirado da fila',
          );
        }

        return toCancelContentResponse({ ...canceled, canceledAt });
      }

      const current = await deps.contents.findById(deps.db, id);

      if (current === null) {
        throw new ContentNotFoundError();
      }

      throw cancelRejectionFor(current.status);
    },
  };
}

/**
 * Monta o service com os repositórios reais. Continua sendo uma função — e não
 * um singleton de módulo — porque a fila abre conexão com o Redis: instanciá-la
 * no import faria qualquer teste unitário que tocasse este arquivo depender de
 * infraestrutura.
 */
export function buildContentService(deps: {
  db: DbClient;
  transaction: <T>(fn: (tx: DbClient) => Promise<T>) => Promise<T>;
  queue: ContentQueuePublisher;
  logger: ServiceLogger;
}): ContentService {
  return createContentService({
    db: deps.db,
    transaction: deps.transaction,
    users: userRepository,
    contents: contentRepository,
    queue: deps.queue,
    logger: deps.logger,
  });
}
