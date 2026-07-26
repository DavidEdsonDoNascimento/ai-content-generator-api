import type { DbClient } from '../../infra/db/prisma.js';
import { prisma } from '../../infra/db/prisma.js';
import {
  ContentNotFoundError,
  InsufficientCreditsError,
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
  readonly users: Pick<typeof userRepository, 'debitCredit' | 'exists'>;
  readonly contents: Pick<typeof contentRepository, 'create' | 'findById' | 'cancelIfCancelable'>;
}

export interface ContentService {
  generate(input: GenerateContentBody): Promise<GenerateContentResponse>;
  getById(id: string): Promise<ContentResponse>;
  cancel(id: string): Promise<CancelContentResponse>;
}

export function createContentService(deps: ContentServiceDeps): ContentService {
  return {
    /**
     * Cobra 1 crédito e registra o conteúdo em `PENDING`.
     *
     * As duas escritas ficam na **mesma transação** de propósito: debitar e
     * depois falhar ao inserir cobraria o usuário por nada. O débito é um
     * `UPDATE` condicional único, sem leitura prévia — ver `debitCredit`.
     *
     * A consulta que separa "usuário não existe" de "usuário sem saldo" só roda
     * quando o débito falhou (ADR-002): no caminho feliz é uma ida ao banco a
     * menos.
     *
     * Nesta fase o conteúdo permanece em `PENDING` indefinidamente — o enqueue
     * no BullMQ e o Worker chegam na Fase 5. Não é bug.
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
     * A releitura só acontece **depois** de o banco ter recusado, e é estável:
     * se a linha existe e não foi cancelada, ela está num estado terminal — e
     * terminais são imutáveis, então o estado lido não muda mais (ADR-004).
     */
    async cancel(id: string): Promise<CancelContentResponse> {
      const canceled = await deps.contents.cancelIfCancelable(deps.db, id);

      if (canceled !== null) {
        const { canceledAt } = canceled;

        if (canceledAt === null) {
          // Inalcançável: o mesmo UPDATE que gravou CANCELED gravou canceledAt.
          throw new Error(`Conteúdo ${id} cancelado sem canceledAt.`);
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

/** Instância usada pela aplicação. Os testes montam a sua com fakes. */
export const contentService: ContentService = createContentService({
  db: prisma,
  transaction: (fn) => prisma.$transaction(fn),
  users: userRepository,
  contents: contentRepository,
});
