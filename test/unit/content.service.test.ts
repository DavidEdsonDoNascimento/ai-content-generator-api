import { describe, expect, it, vi } from 'vitest';

import type { Content } from '../../src/generated/prisma/client.js';
import { ContentStatus } from '../../src/generated/prisma/enums.js';
import type { DbClient } from '../../src/infra/db/prisma.js';
import {
  createContentService,
  type ContentServiceDeps,
} from '../../src/modules/contents/content.service.js';
import { AppError } from '../../src/shared/errors/app-error.js';
import { ERROR_CODES } from '../../src/shared/errors/domain-errors.js';

/**
 * U-08 — regra de negócio do service, com repositórios falsos.
 *
 * O que estes testes protegem não é o SQL (isso é integração, contra o
 * PostgreSQL de verdade), e sim o **desenho** que torna o SQL suficiente:
 *
 * - o débito acontece dentro da transação, e a criação do conteúdo também;
 * - a consulta que separa 404 de 402 **não** roda no caminho feliz — se ela
 *   virasse uma leitura prévia, o débito atômico deixaria de ser atômico;
 * - o cancelamento não lê antes de escrever;
 * - falha de qualquer passo estoura de dentro do escopo transacional.
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

interface Harness {
  service: ReturnType<typeof createContentService>;
  deps: {
    debitCredit: ReturnType<typeof vi.fn>;
    exists: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
    findById: ReturnType<typeof vi.fn>;
    cancelIfCancelable: ReturnType<typeof vi.fn>;
  };
  /** `true` quando o callback da transação estourou — ou seja, houve rollback. */
  rolledBack: () => boolean;
}

function buildService(overrides: {
  debitCredit?: (db: DbClient, userId: string) => Promise<boolean>;
  exists?: (db: DbClient, userId: string) => Promise<boolean>;
  create?: (db: DbClient, input: { userId: string; topic: string }) => Promise<Content>;
  findById?: (db: DbClient, id: string) => Promise<Content | null>;
  cancelIfCancelable?: (db: DbClient, id: string) => Promise<Content | null>;
}): Harness {
  let rolledBack = false;

  const debitCredit = vi.fn(overrides.debitCredit ?? (async () => true));
  const exists = vi.fn(overrides.exists ?? (async () => true));
  const create = vi.fn(overrides.create ?? (async () => contentFixture()));
  const findById = vi.fn(overrides.findById ?? (async () => null));
  const cancelIfCancelable = vi.fn(overrides.cancelIfCancelable ?? (async () => null));

  const deps: ContentServiceDeps = {
    db: BASE_DB,
    // Fake fiel ao que o Prisma faz: entrega um client de transação distinto e
    // propaga a exceção — que é o que dispara o rollback de verdade.
    transaction: async (fn) => {
      try {
        return await fn(TX_DB);
      } catch (error) {
        rolledBack = true;
        throw error;
      }
    },
    users: { debitCredit, exists },
    contents: { create, findById, cancelIfCancelable },
  };

  return {
    service: createContentService(deps),
    deps: { debitCredit, exists, create, findById, cancelIfCancelable },
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

  it('sem saldo e usuário existente → 402, sem criar conteúdo, com rollback', async () => {
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
    expect(harness.rolledBack()).toBe(true);
  });

  it('usuário inexistente → 404, distinguido do 402 só no caminho de erro', async () => {
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
  it('cancela sem leitura prévia — o UPDATE condicional é a decisão', async () => {
    const canceledAt = new Date('2026-07-26T10:00:02.000Z');
    const harness = buildService({
      cancelIfCancelable: async () =>
        contentFixture({ status: ContentStatus.CANCELED, canceledAt }),
    });

    const result = await harness.service.cancel(CONTENT_ID);

    expect(harness.deps.cancelIfCancelable).toHaveBeenCalledExactlyOnceWith(BASE_DB, CONTENT_ID);
    // Um `findById` aqui seria o `SELECT` + `if` que perde a corrida com o Worker.
    expect(harness.deps.findById).not.toHaveBeenCalled();
    expect(result).toEqual({
      id: CONTENT_ID,
      status: ContentStatus.CANCELED,
      canceledAt: '2026-07-26T10:00:02.000Z',
    });
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
