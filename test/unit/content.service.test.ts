import { describe, expect, it, vi } from 'vitest';

import type { Content } from '../../src/generated/prisma/client.js';
import { ContentStatus } from '../../src/generated/prisma/enums.js';
import type { DbClient } from '../../src/infra/db/prisma.js';
import type { JobRemovalOutcome } from '../../src/infra/queue/content-queue.js';
import {
  createContentService,
  type ContentServiceDeps,
} from '../../src/modules/contents/content.service.js';
import { AppError } from '../../src/shared/errors/app-error.js';
import { ERROR_CODES } from '../../src/shared/errors/domain-errors.js';
import { createRecordingQueue, type RecordingQueue } from '../helpers/fake-queue.js';

/**
 * U-08 / U-09 — regra de negócio do service, com repositórios e fila falsos.
 *
 * O que estes testes protegem não é o SQL (isso é integração, contra o
 * PostgreSQL de verdade), e sim o **desenho** que torna o SQL suficiente:
 *
 * - o débito acontece dentro da transação, e a criação do conteúdo também;
 * - a publicação do job acontece **depois do commit**, nunca dentro dele;
 * - a consulta que separa 404 de 402 **não** roda no caminho feliz — se ela
 *   virasse uma leitura prévia, o débito atômico deixaria de ser atômico;
 * - a compensação de `QUEUE_UNAVAILABLE` devolve exatamente um crédito, mesmo
 *   chamada duas vezes;
 * - o cancelamento não lê antes de escrever, e a limpeza da fila não pode
 *   desfazer um cancelamento que o banco já confirmou.
 */

/** Dois clientes distintos: é assim que se prova em qual deles cada escrita caiu. */
const BASE_DB = { marker: 'base' } as unknown as DbClient;
const TX_DB = { marker: 'transaction' } as unknown as DbClient;

const USER_ID = '00000000-0000-4000-8000-000000000001';
const CONTENT_ID = '11111111-1111-4111-8111-111111111111';

function contentFixture(overrides: Partial<Content> = {}): Content {
  return {
    id: CONTENT_ID,
    userId: USER_ID,
    topic: 'Filas resilientes',
    status: ContentStatus.PENDING,
    fileUrl: null,
    fileKey: null,
    errorMessage: null,
    attempts: 0,
    createdAt: new Date('2026-07-26T10:00:00.000Z'),
    updatedAt: new Date('2026-07-26T10:00:00.000Z'),
    completedAt: null,
    canceledAt: null,
    creditRefundedAt: null,
    ...overrides,
  };
}

interface Overrides {
  debitCredit?: (db: DbClient, userId: string) => Promise<boolean>;
  exists?: (db: DbClient, userId: string) => Promise<boolean>;
  refundCredit?: (db: DbClient, userId: string) => Promise<boolean>;
  create?: (db: DbClient, input: { userId: string; topic: string }) => Promise<Content>;
  findById?: (db: DbClient, id: string) => Promise<Content | null>;
  cancelIfCancelable?: (db: DbClient, id: string) => Promise<Content | null>;
  failForQueueUnavailable?: (db: DbClient, id: string) => Promise<boolean>;
  queue?: RecordingQueue;
}

function buildService(overrides: Overrides) {
  let rolledBack = false;
  /** Sequência de eventos observados — é o que prova a **ordem** das operações. */
  const events: string[] = [];

  const debitCredit = vi.fn(
    overrides.debitCredit ??
      (async () => {
        events.push('debit');
        return true;
      }),
  );
  const exists = vi.fn(overrides.exists ?? (async () => true));
  const refundCredit = vi.fn(
    overrides.refundCredit ??
      (async () => {
        events.push('refund');
        return true;
      }),
  );
  const create = vi.fn(
    overrides.create ??
      (async () => {
        events.push('create');
        return contentFixture();
      }),
  );
  const findById = vi.fn(overrides.findById ?? (async () => null));
  const cancelIfCancelable = vi.fn(overrides.cancelIfCancelable ?? (async () => null));
  const failForQueueUnavailable = vi.fn(
    overrides.failForQueueUnavailable ??
      (async () => {
        events.push('compensate');
        return true;
      }),
  );

  const baseQueue = overrides.queue ?? createRecordingQueue();
  const queue: RecordingQueue = {
    enqueued: baseQueue.enqueued,
    removed: baseQueue.removed,
    enqueue: async (contentId) => {
      events.push('enqueue');
      await baseQueue.enqueue(contentId);
    },
    removeIfPending: async (contentId) => {
      events.push('remove');
      return baseQueue.removeIfPending(contentId);
    },
  };

  const logger = { warn: vi.fn(), error: vi.fn() };

  const deps: ContentServiceDeps = {
    db: BASE_DB,
    // Fake fiel ao que o Prisma faz: entrega um client de transação distinto e
    // propaga a exceção — que é o que dispara o rollback de verdade.
    transaction: async (fn) => {
      events.push('tx:begin');
      try {
        const result = await fn(TX_DB);
        events.push('tx:commit');
        return result;
      } catch (error) {
        rolledBack = true;
        events.push('tx:rollback');
        throw error;
      }
    },
    users: { debitCredit, exists, refundCredit },
    contents: { create, findById, cancelIfCancelable, failForQueueUnavailable },
    queue,
    logger,
  };

  return {
    service: createContentService(deps),
    deps: {
      debitCredit,
      exists,
      refundCredit,
      create,
      findById,
      cancelIfCancelable,
      failForQueueUnavailable,
    },
    queue,
    logger,
    events,
    rolledBack: () => rolledBack,
  };
}

describe('generate', () => {
  it('debita e cria dentro da mesma transação, sem ler o saldo antes', async () => {
    const harness = buildService({});

    const result = await harness.service.generate({ topic: 'Filas resilientes', userId: USER_ID });

    expect(harness.deps.debitCredit).toHaveBeenCalledExactlyOnceWith(TX_DB, USER_ID);
    expect(harness.deps.create).toHaveBeenCalledExactlyOnceWith(TX_DB, {
      userId: USER_ID,
      topic: 'Filas resilientes',
    });
    // A consulta de existência é o caminho de erro. Vê-la aqui significaria que
    // voltou a haver leitura antes da escrita (ADR-001/ADR-002).
    expect(harness.deps.exists).not.toHaveBeenCalled();
    expect(harness.rolledBack()).toBe(false);

    expect(result).toEqual({
      id: CONTENT_ID,
      userId: USER_ID,
      topic: 'Filas resilientes',
      status: ContentStatus.PENDING,
      createdAt: '2026-07-26T10:00:00.000Z',
    });
  });

  it('publica o job **depois** do commit, nunca dentro da transação', async () => {
    const harness = buildService({});

    await harness.service.generate({ topic: 'Filas resilientes', userId: USER_ID });

    // A ordem é a invariante (ADR-008). Publicar dentro da transação permitiria
    // ao Worker consumir o job antes de a linha existir no banco.
    expect(harness.events).toEqual(['tx:begin', 'debit', 'create', 'tx:commit', 'enqueue']);
    expect(harness.queue.enqueued).toEqual([CONTENT_ID]);
  });

  it('sem saldo e usuário existente → 402, sem criar conteúdo, sem publicar job', async () => {
    const harness = buildService({
      debitCredit: async () => false,
      exists: async () => true,
    });

    await expect(
      harness.service.generate({ topic: 'Sem saldo', userId: USER_ID }),
    ).rejects.toMatchObject({
      statusCode: 402,
      code: ERROR_CODES.INSUFFICIENT_CREDITS,
    });

    expect(harness.deps.create).not.toHaveBeenCalled();
    expect(harness.queue.enqueued).toEqual([]);
    expect(harness.rolledBack()).toBe(true);
  });

  it('usuário inexistente → 404, sem publicar job', async () => {
    const harness = buildService({
      debitCredit: async () => false,
      exists: async () => false,
    });

    await expect(
      harness.service.generate({ topic: 'Fantasma', userId: USER_ID }),
    ).rejects.toMatchObject({
      statusCode: 404,
      code: ERROR_CODES.USER_NOT_FOUND,
    });

    expect(harness.deps.exists).toHaveBeenCalledExactlyOnceWith(TX_DB, USER_ID);
    expect(harness.deps.create).not.toHaveBeenCalled();
    expect(harness.queue.enqueued).toEqual([]);
  });

  it('falha ao criar o conteúdo desfaz o débito, em vez de cobrar por nada', async () => {
    const harness = buildService({
      create: async () => {
        throw new Error('insert falhou');
      },
    });

    await expect(
      harness.service.generate({ topic: 'Insert quebrado', userId: USER_ID }),
    ).rejects.toThrow('insert falhou');

    expect(harness.deps.debitCredit).toHaveBeenCalledOnce();
    // O débito e o insert estavam na mesma transação: o erro propagou de dentro
    // dela, então o PostgreSQL descarta as duas escritas.
    expect(harness.rolledBack()).toBe(true);
    expect(harness.queue.enqueued).toEqual([]);
  });
});

describe('U-09 — compensação de QUEUE_UNAVAILABLE', () => {
  const redisDown = new Error('Connection is closed');

  it('falha ao publicar → 503, conteúdo compensado e crédito devolvido uma vez', async () => {
    const harness = buildService({ queue: createRecordingQueue({ enqueueError: redisDown }) });

    const error = await harness.service
      .generate({ topic: 'Redis fora do ar', userId: USER_ID })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(AppError);
    expect(error).toMatchObject({ statusCode: 503, code: ERROR_CODES.QUEUE_UNAVAILABLE });

    expect(harness.deps.failForQueueUnavailable).toHaveBeenCalledExactlyOnceWith(TX_DB, CONTENT_ID);
    expect(harness.deps.refundCredit).toHaveBeenCalledExactlyOnceWith(TX_DB, USER_ID);
    // Conteúdo e estorno na mesma transação de compensação.
    expect(harness.events).toEqual([
      'tx:begin',
      'debit',
      'create',
      'tx:commit',
      'enqueue',
      'tx:begin',
      'compensate',
      'refund',
      'tx:commit',
    ]);
  });

  it('não devolve crédito quando o UPDATE condicional não encontra linha', async () => {
    // O conteúdo já saiu de PENDING (o job chegou a ser aceito, a resposta é que
    // se perdeu) ou já foi compensado antes: em nenhum dos dois o crédito volta.
    const harness = buildService({
      queue: createRecordingQueue({ enqueueError: redisDown }),
      failForQueueUnavailable: async () => false,
    });

    await expect(
      harness.service.generate({ topic: 'Já compensado', userId: USER_ID }),
    ).rejects.toMatchObject({ code: ERROR_CODES.QUEUE_UNAVAILABLE });

    expect(harness.deps.failForQueueUnavailable).toHaveBeenCalledOnce();
    expect(harness.deps.refundCredit).not.toHaveBeenCalled();
  });

  it('duas compensações do mesmo conteúdo devolvem crédito uma única vez', async () => {
    // Reproduz a guarda `creditRefundedAt IS NULL`: a primeira chamada afeta a
    // linha, a segunda não.
    let alreadyCompensated = false;
    const harness = buildService({
      queue: createRecordingQueue({ enqueueError: redisDown }),
      failForQueueUnavailable: async () => {
        if (alreadyCompensated) {
          return false;
        }
        alreadyCompensated = true;
        return true;
      },
    });

    const attempt = async (): Promise<unknown> =>
      harness.service
        .generate({ topic: 'Dupla compensação', userId: USER_ID })
        .catch((error: unknown) => error);

    await attempt();
    await attempt();

    expect(harness.deps.failForQueueUnavailable).toHaveBeenCalledTimes(2);
    expect(harness.deps.refundCredit).toHaveBeenCalledOnce();
  });

  it('não vaza a mensagem do Redis para o cliente', async () => {
    const harness = buildService({ queue: createRecordingQueue({ enqueueError: redisDown }) });

    const error = await harness.service
      .generate({ topic: 'Redis fora do ar', userId: USER_ID })
      .catch((caught: unknown) => caught);

    expect((error as AppError).message).not.toContain('Connection is closed');
    // O detalhe existe — no log do servidor (ADR-010).
    expect(harness.logger.error).toHaveBeenCalledOnce();
  });
});

describe('getById', () => {
  it('devolve os dados públicos e nenhum campo interno', async () => {
    const harness = buildService({
      findById: async () =>
        contentFixture({
          status: ContentStatus.COMPLETED,
          fileUrl: 'http://localhost:9000/ai-content/contents/x.txt',
          fileKey: 'contents/x.txt',
          completedAt: new Date('2026-07-26T10:00:05.000Z'),
          attempts: 2,
        }),
    });

    const result = await harness.service.getById(CONTENT_ID);

    expect(harness.deps.findById).toHaveBeenCalledExactlyOnceWith(BASE_DB, CONTENT_ID);
    expect(Object.keys(result).sort()).toEqual([
      'attempts',
      'canceledAt',
      'completedAt',
      'createdAt',
      'errorMessage',
      'fileUrl',
      'id',
      'status',
      'topic',
      'userId',
    ]);
    // `fileKey`, `updatedAt` e `creditRefundedAt` são internos e não saem por
    // nenhum caminho (ADR-010).
    expect(result).not.toHaveProperty('fileKey');
    expect(result).not.toHaveProperty('updatedAt');
    expect(result).not.toHaveProperty('creditRefundedAt');
    expect(result.completedAt).toBe('2026-07-26T10:00:05.000Z');
  });

  it('id inexistente → 404', async () => {
    const harness = buildService({ findById: async () => null });

    await expect(harness.service.getById(CONTENT_ID)).rejects.toMatchObject({
      statusCode: 404,
      code: ERROR_CODES.CONTENT_NOT_FOUND,
    });
  });
});

describe('cancel', () => {
  const canceledFixture = (): Content =>
    contentFixture({
      status: ContentStatus.CANCELED,
      canceledAt: new Date('2026-07-26T10:00:02.000Z'),
    });

  it('cancela sem leitura prévia e só então retira o job da fila', async () => {
    const harness = buildService({ cancelIfCancelable: async () => canceledFixture() });

    const result = await harness.service.cancel(CONTENT_ID);

    expect(harness.deps.cancelIfCancelable).toHaveBeenCalledExactlyOnceWith(BASE_DB, CONTENT_ID);
    // Um `findById` aqui seria o `SELECT` + `if` que perde a corrida com o Worker.
    expect(harness.deps.findById).not.toHaveBeenCalled();
    // A ordem importa: remover o job antes de o banco confirmar tiraria da fila
    // um cancelamento que ainda podia ser recusado.
    expect(harness.events).toEqual(['remove']);
    expect(harness.queue.removed).toEqual([CONTENT_ID]);
    expect(result).toEqual({
      id: CONTENT_ID,
      status: ContentStatus.CANCELED,
      canceledAt: '2026-07-26T10:00:02.000Z',
    });
  });

  it.each<JobRemovalOutcome>(['not-removable', 'unavailable'])(
    'continua respondendo sucesso quando a remoção da fila resulta em %s',
    async (outcome) => {
      const harness = buildService({
        cancelIfCancelable: async () => canceledFixture(),
        queue: createRecordingQueue({ removalOutcome: outcome }),
      });

      const result = await harness.service.cancel(CONTENT_ID);

      // O cancelamento já está commitado no banco; a limpeza da fila é
      // best-effort e não pode desfazê-lo. O Worker que pegar o job encontra
      // CANCELED e termina em no-op.
      expect(result.status).toBe(ContentStatus.CANCELED);
      expect(harness.logger.warn).toHaveBeenCalledOnce();
    },
  );

  it('não tenta remover o job quando o banco recusa o cancelamento', async () => {
    const harness = buildService({
      cancelIfCancelable: async () => null,
      findById: async () => contentFixture({ status: ContentStatus.COMPLETED }),
    });

    await expect(harness.service.cancel(CONTENT_ID)).rejects.toMatchObject({ statusCode: 409 });

    expect(harness.queue.removed).toEqual([]);
  });

  it('nenhuma linha afetada e id inexistente → 404', async () => {
    const harness = buildService({
      cancelIfCancelable: async () => null,
      findById: async () => null,
    });

    await expect(harness.service.cancel(CONTENT_ID)).rejects.toMatchObject({
      statusCode: 404,
      code: ERROR_CODES.CONTENT_NOT_FOUND,
    });
  });

  it.each([
    [ContentStatus.COMPLETED, ERROR_CODES.CONTENT_ALREADY_COMPLETED],
    [ContentStatus.CANCELED, ERROR_CODES.CONTENT_ALREADY_CANCELED],
    [ContentStatus.FAILED, ERROR_CODES.CONTENT_ALREADY_FAILED],
  ])('nenhuma linha afetada e estado %s → 409 %s', async (status, code) => {
    const harness = buildService({
      cancelIfCancelable: async () => null,
      findById: async () => contentFixture({ status }),
    });

    const error = await harness.service.cancel(CONTENT_ID).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(AppError);
    expect(error).toMatchObject({ statusCode: 409, code });
  });
});
