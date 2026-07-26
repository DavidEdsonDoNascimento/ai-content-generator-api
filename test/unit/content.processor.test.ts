import { UnrecoverableError, type Job } from 'bullmq';
import { describe, expect, it, vi } from 'vitest';

import type { Content } from '../../src/generated/prisma/client.js';
import { ContentStatus } from '../../src/generated/prisma/enums.js';
import type { DbClient } from '../../src/infra/db/prisma.js';
import type { ContentJobData } from '../../src/infra/queue/job.types.js';
import {
  createContentProcessor,
  isLastAttempt,
  type ContentProcessorDeps,
} from '../../src/worker/content.processor.js';
import { AI_GENERATION_FAILED, AiGenerationError } from '../../src/worker/ai/generate-content.js';

/**
 * Decisões do processor, isoladas da fila e do banco.
 *
 * A garantia de concorrência é do PostgreSQL e está provada em
 * `test/integration/worker.test.ts`. O que se prova **aqui** é a lógica que
 * decide *se* cada `UPDATE` chega a ser tentado — e, sobretudo, que `FAILED` só
 * é gravado quando as tentativas se esgotam (ADR-005). Um erro nessa decisão
 * grava um terminal cedo demais, e terminal é imutável: não há como desfazer.
 */

const DB = { marker: 'db' } as unknown as DbClient;
const CONTENT_ID = '11111111-1111-4111-8111-111111111111';

function contentFixture(overrides: Partial<Content> = {}): Content {
  return {
    id: CONTENT_ID,
    userId: '00000000-0000-4000-8000-000000000001',
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

/**
 * Job mínimo. Só `data`, `id`, `attemptsMade` e `opts` são lidos pelo processor —
 * construir um `Job` real exigiria uma fila, que é o que este arquivo evita.
 */
function jobFixture(attemptsMade: number, attempts = 3): Job<ContentJobData> {
  return {
    id: CONTENT_ID,
    data: { contentId: CONTENT_ID },
    attemptsMade,
    opts: { attempts },
  } as unknown as Job<ContentJobData>;
}

interface Overrides {
  findById?: (db: DbClient, id: string) => Promise<Content | null>;
  claimForProcessing?: (db: DbClient, id: string) => Promise<boolean>;
  completeIfProcessing?: (db: DbClient, id: string) => Promise<boolean>;
  failIfProcessing?: (db: DbClient, id: string, code: string) => Promise<boolean>;
  generate?: (topic: string) => Promise<string>;
}

function buildProcessor(overrides: Overrides = {}) {
  const findById = vi.fn(overrides.findById ?? (async () => contentFixture()));
  const claimForProcessing = vi.fn(overrides.claimForProcessing ?? (async () => true));
  const completeIfProcessing = vi.fn(overrides.completeIfProcessing ?? (async () => true));
  const failIfProcessing = vi.fn(overrides.failIfProcessing ?? (async () => true));
  const generate = vi.fn(overrides.generate ?? (async () => 'texto gerado'));

  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

  const deps: ContentProcessorDeps = {
    db: DB,
    contents: { findById, claimForProcessing, completeIfProcessing, failIfProcessing },
    generate,
    logger,
  };

  return {
    process: createContentProcessor(deps),
    deps: { findById, claimForProcessing, completeIfProcessing, failIfProcessing, generate },
    logger,
  };
}

describe('isLastAttempt', () => {
  // `attemptsMade` é 0-based dentro do processor — comprovado contra
  // `bullmq@5.81.2`, não presumido. Se uma atualização do BullMQ mudar essa
  // semântica, este é o teste que quebra primeiro.
  it.each([
    [0, 3, false],
    [1, 3, false],
    [2, 3, true],
    [0, 1, true],
    [3, 3, true],
  ])('attemptsMade=%i de %i tentativas → última? %s', (attemptsMade, attempts, expected) => {
    expect(isLastAttempt(jobFixture(attemptsMade, attempts))).toBe(expected);
  });

  it('trata job sem `attempts` configurado como tentativa única', () => {
    const job = { attemptsMade: 0, opts: {} } as unknown as Job;
    expect(isLastAttempt(job)).toBe(true);
  });
});

describe('guardas de entrada', () => {
  it('conteúdo inexistente → UnrecoverableError, sem queimar tentativas', async () => {
    const harness = buildProcessor({ findById: async () => null });

    await expect(harness.process(jobFixture(0))).rejects.toBeInstanceOf(UnrecoverableError);
    expect(harness.deps.claimForProcessing).not.toHaveBeenCalled();
  });

  it.each([ContentStatus.COMPLETED, ContentStatus.CANCELED, ContentStatus.FAILED])(
    'conteúdo em %s → no-op silencioso, sem claim e sem IA',
    async (status) => {
      const harness = buildProcessor({ findById: async () => contentFixture({ status }) });

      await expect(harness.process(jobFixture(0))).resolves.toBeUndefined();

      expect(harness.deps.claimForProcessing).not.toHaveBeenCalled();
      expect(harness.deps.generate).not.toHaveBeenCalled();
      expect(harness.deps.completeIfProcessing).not.toHaveBeenCalled();
    },
  );

  it('claim recusado pelo banco → aborta sem chamar a IA', async () => {
    const harness = buildProcessor({ claimForProcessing: async () => false });

    await expect(harness.process(jobFixture(0))).resolves.toBeUndefined();

    expect(harness.deps.generate).not.toHaveBeenCalled();
    expect(harness.deps.completeIfProcessing).not.toHaveBeenCalled();
  });
});

describe('caminho de sucesso', () => {
  it('reclama, gera com o topic do banco e finaliza condicionalmente', async () => {
    const harness = buildProcessor({
      findById: vi
        .fn<(db: DbClient, id: string) => Promise<Content | null>>()
        .mockResolvedValueOnce(contentFixture({ topic: 'Tópico do banco' }))
        .mockResolvedValueOnce(contentFixture({ status: ContentStatus.PROCESSING })),
    });

    await harness.process(jobFixture(0));

    expect(harness.deps.claimForProcessing).toHaveBeenCalledExactlyOnceWith(DB, CONTENT_ID);
    // O `topic` vem do banco, não do payload do job (ADR-007).
    expect(harness.deps.generate).toHaveBeenCalledExactlyOnceWith('Tópico do banco');
    expect(harness.deps.completeIfProcessing).toHaveBeenCalledExactlyOnceWith(DB, CONTENT_ID);
  });

  it('conteúdo cancelado durante a IA → não tenta finalizar', async () => {
    const harness = buildProcessor({
      findById: vi
        .fn<(db: DbClient, id: string) => Promise<Content | null>>()
        .mockResolvedValueOnce(contentFixture())
        .mockResolvedValueOnce(contentFixture({ status: ContentStatus.CANCELED })),
    });

    await expect(harness.process(jobFixture(0))).resolves.toBeUndefined();

    // A guarda pré-finalização economizou o UPDATE. Mesmo que não economizasse,
    // o predicado do `completeIfProcessing` recusaria a escrita.
    expect(harness.deps.completeIfProcessing).not.toHaveBeenCalled();
  });

  it('finalização recusada pelo banco → job encerra em sucesso, sem sobrescrever nada', async () => {
    // A corrida real: o cancelamento chegou entre a guarda e o UPDATE final.
    const harness = buildProcessor({
      findById: vi
        .fn<(db: DbClient, id: string) => Promise<Content | null>>()
        .mockResolvedValueOnce(contentFixture())
        .mockResolvedValueOnce(contentFixture({ status: ContentStatus.PROCESSING })),
      completeIfProcessing: async () => false,
    });

    await expect(harness.process(jobFixture(0))).resolves.toBeUndefined();
    expect(harness.deps.failIfProcessing).not.toHaveBeenCalled();
  });
});

describe('falha da IA e política de retry', () => {
  const failing = async (): Promise<string> => {
    throw new AiGenerationError();
  };

  it.each([0, 1])(
    'tentativa %i de 3: mantém PROCESSING, não grava FAILED e relança para o BullMQ',
    async (attemptsMade) => {
      const harness = buildProcessor({ generate: failing });

      await expect(harness.process(jobFixture(attemptsMade))).rejects.toBeInstanceOf(
        AiGenerationError,
      );

      // Gravar FAILED aqui seria irreversível: terminal é imutável, e a segunda
      // tentativa nem chegaria a rodar, porque o claim não aceita FAILED.
      expect(harness.deps.failIfProcessing).not.toHaveBeenCalled();
      expect(harness.deps.completeIfProcessing).not.toHaveBeenCalled();
    },
  );

  it('última tentativa: grava FAILED condicionalmente com código sanitizado', async () => {
    const harness = buildProcessor({ generate: failing });

    await expect(harness.process(jobFixture(2))).rejects.toBeInstanceOf(AiGenerationError);

    expect(harness.deps.failIfProcessing).toHaveBeenCalledExactlyOnceWith(
      DB,
      CONTENT_ID,
      AI_GENERATION_FAILED,
    );
  });

  it('última tentativa com conteúdo já cancelado: o UPDATE não afeta linha e o CANCELED sobrevive', async () => {
    const harness = buildProcessor({ generate: failing, failIfProcessing: async () => false });

    await expect(harness.process(jobFixture(2))).rejects.toBeInstanceOf(AiGenerationError);

    expect(harness.deps.failIfProcessing).toHaveBeenCalledOnce();
  });

  it('erro inesperado é logado, nunca persistido como mensagem crua', async () => {
    const harness = buildProcessor({
      generate: async () => {
        throw new Error('ECONNREFUSED 10.0.0.5:443 chave=segredo');
      },
    });

    await expect(harness.process(jobFixture(2))).rejects.toThrow('ECONNREFUSED');

    // O que vai para o banco é o código do catálogo, não a mensagem original.
    expect(harness.deps.failIfProcessing).toHaveBeenCalledExactlyOnceWith(
      DB,
      CONTENT_ID,
      AI_GENERATION_FAILED,
    );
    expect(harness.logger.error).toHaveBeenCalled();
  });
});
