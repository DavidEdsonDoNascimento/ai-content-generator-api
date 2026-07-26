import { UnrecoverableError, type Job } from 'bullmq';
import { describe, expect, it, vi } from 'vitest';

import type { Content } from '../../src/generated/prisma/client.js';
import { ContentStatus } from '../../src/generated/prisma/enums.js';
import type { DbClient } from '../../src/infra/db/prisma.js';
import type { ContentJobData } from '../../src/infra/queue/job.types.js';
import { CONTENT_FAILURE_CODES } from '../../src/modules/contents/content.failure.js';
import { AiGenerationError } from '../../src/worker/ai/generate-content.js';
import {
  createContentProcessor,
  isLastAttempt,
  TEXT_CONTENT_TYPE,
  type ContentProcessorDeps,
} from '../../src/worker/content.processor.js';
import { createFakeStorage, type FakeStorage } from '../helpers/fake-storage.js';

/**
 * Decisões do processor, isoladas da fila, do banco e do S3.
 *
 * A garantia de concorrência é do PostgreSQL e está provada em
 * `test/integration/worker.test.ts`. O que se prova **aqui** é a lógica que
 * decide *se* cada `UPDATE` e cada chamada ao storage chegam a acontecer — e,
 * sobretudo, que `FAILED` só é gravado quando as tentativas se esgotam
 * (ADR-005). Um erro nessa decisão grava um terminal cedo demais, e terminal é
 * imutável: não há como desfazer.
 */

const DB = { marker: 'db' } as unknown as DbClient;
const CONTENT_ID = '11111111-1111-4111-8111-111111111111';
const KEY = `contents/${CONTENT_ID}.txt`;

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
  completeIfProcessing?: (
    db: DbClient,
    id: string,
    file: { fileKey: string; fileUrl: string },
  ) => Promise<boolean>;
  failIfProcessing?: (db: DbClient, id: string, code: string) => Promise<boolean>;
  generate?: (topic: string) => Promise<string>;
  storage?: FakeStorage;
}

function buildProcessor(overrides: Overrides = {}) {
  const findById = vi.fn(overrides.findById ?? (async () => contentFixture()));
  const claimForProcessing = vi.fn(overrides.claimForProcessing ?? (async () => true));
  const completeIfProcessing = vi.fn(overrides.completeIfProcessing ?? (async () => true));
  const failIfProcessing = vi.fn(overrides.failIfProcessing ?? (async () => true));
  const generate = vi.fn(overrides.generate ?? (async (topic: string) => `texto sobre ${topic}`));
  const storage = overrides.storage ?? createFakeStorage();

  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

  const deps: ContentProcessorDeps = {
    db: DB,
    contents: { findById, claimForProcessing, completeIfProcessing, failIfProcessing },
    generate,
    storage,
    logger,
  };

  return {
    process: createContentProcessor(deps),
    deps: { findById, claimForProcessing, completeIfProcessing, failIfProcessing, generate },
    storage,
    logger,
  };
}

/** `findById` que devolve estados diferentes em cada chamada do fluxo. */
function sequencedFindById(...results: (Content | null)[]) {
  const mock = vi.fn<(db: DbClient, id: string) => Promise<Content | null>>();
  for (const result of results) {
    mock.mockResolvedValueOnce(result);
  }
  // Depois da sequência, repete o último — cobre releituras extras.
  mock.mockResolvedValue(results.at(-1) ?? null);
  return mock;
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
    expect(harness.storage.history).toEqual([]);
  });

  it.each([ContentStatus.COMPLETED, ContentStatus.CANCELED, ContentStatus.FAILED])(
    'conteúdo em %s → no-op, sem claim, sem IA e **sem tocar no storage**',
    async (status) => {
      const harness = buildProcessor({ findById: async () => contentFixture({ status }) });

      await expect(harness.process(jobFixture(0))).resolves.toBeUndefined();

      expect(harness.deps.claimForProcessing).not.toHaveBeenCalled();
      expect(harness.deps.generate).not.toHaveBeenCalled();
      expect(harness.deps.completeIfProcessing).not.toHaveBeenCalled();
      expect(harness.storage.history).toEqual([]);
    },
  );

  it('claim recusado pelo banco → aborta sem chamar IA nem storage', async () => {
    const harness = buildProcessor({ claimForProcessing: async () => false });

    await expect(harness.process(jobFixture(0))).resolves.toBeUndefined();

    expect(harness.deps.generate).not.toHaveBeenCalled();
    expect(harness.storage.history).toEqual([]);
  });
});

describe('caminho de sucesso', () => {
  it('grava o objeto e finaliza com fileKey e fileUrl na mesma escrita', async () => {
    const harness = buildProcessor({
      findById: sequencedFindById(
        contentFixture({ topic: 'Tópico do banco' }),
        contentFixture({ status: ContentStatus.PROCESSING }),
      ),
    });

    await harness.process(jobFixture(0));

    // O `topic` vem do banco, não do payload do job (ADR-007).
    expect(harness.deps.generate).toHaveBeenCalledExactlyOnceWith('Tópico do banco');

    // Chave determinística, corpo UTF-8 e Content-Type de texto.
    expect(harness.storage.uploadCount()).toBe(1);
    expect(harness.storage.text(KEY)).toBe('texto sobre Tópico do banco');
    expect(harness.storage.objects.get(KEY)?.contentType).toBe(TEXT_CONTENT_TYPE);

    // Uma única finalização, carregando arquivo e status juntos: nunca existe um
    // instante em que o conteúdo esteja COMPLETED sem URL.
    expect(harness.deps.completeIfProcessing).toHaveBeenCalledExactlyOnceWith(DB, CONTENT_ID, {
      fileKey: KEY,
      fileUrl: `http://localhost:9000/ai-content/${KEY}`,
    });
    expect(harness.storage.removed).toEqual([]);
  });

  it('preserva acentuação no corpo gravado', async () => {
    const harness = buildProcessor({
      generate: async () => 'Conteúdo com acentuação: ção, ãé',
      findById: sequencedFindById(
        contentFixture(),
        contentFixture({ status: ContentStatus.PROCESSING }),
      ),
    });

    await harness.process(jobFixture(0));

    expect(harness.storage.text(KEY)).toBe('Conteúdo com acentuação: ção, ãé');
  });

  it('cancelado durante a IA → não faz upload nem finaliza', async () => {
    const harness = buildProcessor({
      findById: sequencedFindById(
        contentFixture(),
        contentFixture({ status: ContentStatus.CANCELED }),
      ),
    });

    await expect(harness.process(jobFixture(0))).resolves.toBeUndefined();

    // A guarda pré-upload economizou os bytes. Mesmo que não economizasse, o
    // predicado da finalização recusaria a escrita.
    expect(harness.storage.history).toEqual([]);
    expect(harness.deps.completeIfProcessing).not.toHaveBeenCalled();
  });
});

describe('falha de upload', () => {
  it('tentativa intermediária: mantém PROCESSING, não grava FAILED e relança', async () => {
    const harness = buildProcessor({
      storage: createFakeStorage({ failUploads: 'always' }),
      findById: sequencedFindById(
        contentFixture(),
        contentFixture({ status: ContentStatus.PROCESSING }),
        contentFixture({ status: ContentStatus.PROCESSING }),
      ),
    });

    await expect(harness.process(jobFixture(0))).rejects.toThrow(/NoSuchBucket/);

    expect(harness.deps.failIfProcessing).not.toHaveBeenCalled();
    expect(harness.deps.completeIfProcessing).not.toHaveBeenCalled();
  });

  it('última tentativa: grava UPLOAD_FAILED, e não AI_GENERATION_FAILED', async () => {
    const harness = buildProcessor({
      storage: createFakeStorage({ failUploads: 'always' }),
      findById: sequencedFindById(
        contentFixture(),
        contentFixture({ status: ContentStatus.PROCESSING }),
      ),
    });

    await expect(harness.process(jobFixture(2))).rejects.toThrow(/NoSuchBucket/);

    // A classificação é posicional: só o que sai da IA vira AI_GENERATION_FAILED.
    expect(harness.deps.failIfProcessing).toHaveBeenCalledExactlyOnceWith(
      DB,
      CONTENT_ID,
      CONTENT_FAILURE_CODES.UPLOAD_FAILED,
    );
    expect(harness.deps.completeIfProcessing).not.toHaveBeenCalled();
  });

  it('a mensagem do SDK não é persistida — só o código do catálogo', async () => {
    const harness = buildProcessor({
      storage: createFakeStorage({ failUploads: 'always' }),
      findById: sequencedFindById(
        contentFixture(),
        contentFixture({ status: ContentStatus.PROCESSING }),
      ),
    });

    await expect(harness.process(jobFixture(2))).rejects.toThrow();

    const persistedCode = harness.deps.failIfProcessing.mock.calls[0]?.[2];
    expect(persistedCode).toBe('UPLOAD_FAILED');
    expect(persistedCode).not.toContain('NoSuchBucket');
    expect(persistedCode).not.toContain('minio:9000');
    // O detalhe existe — no log (ADR-010).
    expect(harness.logger.error).toHaveBeenCalled();
  });
});

describe('falha da IA', () => {
  const failing = async (): Promise<string> => {
    throw new AiGenerationError();
  };

  it.each([0, 1])(
    'tentativa %i de 3: mantém PROCESSING, não grava FAILED e relança',
    async (attemptsMade) => {
      const harness = buildProcessor({ generate: failing });

      await expect(harness.process(jobFixture(attemptsMade))).rejects.toBeInstanceOf(
        AiGenerationError,
      );

      // Gravar FAILED aqui seria irreversível: terminal é imutável, e a segunda
      // tentativa nem chegaria a rodar, porque o claim não aceita FAILED.
      expect(harness.deps.failIfProcessing).not.toHaveBeenCalled();
      expect(harness.storage.history).toEqual([]);
    },
  );

  it('última tentativa: grava AI_GENERATION_FAILED', async () => {
    const harness = buildProcessor({ generate: failing });

    await expect(harness.process(jobFixture(2))).rejects.toBeInstanceOf(AiGenerationError);

    expect(harness.deps.failIfProcessing).toHaveBeenCalledExactlyOnceWith(
      DB,
      CONTENT_ID,
      CONTENT_FAILURE_CODES.AI_GENERATION_FAILED,
    );
  });

  it('conteúdo cancelado no meio: o job encerra em paz, sem sobrescrever nada', async () => {
    // `failIfProcessing` não encontra `PROCESSING` porque o cancelamento venceu.
    // Cancelamento não é falha de domínio do conteúdo (ADR-005): o job termina
    // como sucesso, em vez de gastar retries num destino já decidido.
    const harness = buildProcessor({ generate: failing, failIfProcessing: async () => false });

    await expect(harness.process(jobFixture(2))).resolves.toBeUndefined();
    expect(harness.deps.failIfProcessing).toHaveBeenCalledOnce();
  });

  it('falha intermediária com conteúdo já terminal não é retentada', async () => {
    const harness = buildProcessor({
      generate: failing,
      findById: sequencedFindById(
        contentFixture(),
        contentFixture({ status: ContentStatus.CANCELED }),
      ),
    });

    await expect(harness.process(jobFixture(0))).resolves.toBeUndefined();
    expect(harness.deps.failIfProcessing).not.toHaveBeenCalled();
  });

  it('erro inesperado é logado, nunca persistido como mensagem crua', async () => {
    const harness = buildProcessor({
      generate: async () => {
        throw new Error('ECONNREFUSED 10.0.0.5:443 chave=segredo');
      },
    });

    await expect(harness.process(jobFixture(2))).rejects.toThrow('ECONNREFUSED');

    expect(harness.deps.failIfProcessing).toHaveBeenCalledExactlyOnceWith(
      DB,
      CONTENT_ID,
      CONTENT_FAILURE_CODES.AI_GENERATION_FAILED,
    );
    expect(harness.logger.error).toHaveBeenCalled();
  });
});

describe('finalização perdida — limpeza de órfão', () => {
  /** Monta um processor cujo `completeIfProcessing` sempre perde a corrida. */
  function lostFinalization(afterLoss: Content | null, storage?: FakeStorage) {
    return buildProcessor({
      completeIfProcessing: async () => false,
      storage: storage ?? createFakeStorage(),
      findById: sequencedFindById(
        contentFixture(),
        contentFixture({ status: ContentStatus.PROCESSING }),
        afterLoss,
      ),
    });
  }

  it('perdeu para CANCELED → remove o objeto órfão', async () => {
    const harness = lostFinalization(
      contentFixture({ status: ContentStatus.CANCELED, canceledAt: new Date() }),
    );

    await harness.process(jobFixture(0));

    expect(harness.storage.removed).toEqual([KEY]);
    expect(harness.storage.objects.has(KEY)).toBe(false);
  });

  it('perdeu para FAILED → remove o objeto órfão', async () => {
    const harness = lostFinalization(contentFixture({ status: ContentStatus.FAILED }));

    await harness.process(jobFixture(0));

    expect(harness.storage.removed).toEqual([KEY]);
  });

  it('conteúdo sumiu → remove o objeto órfão', async () => {
    const harness = lostFinalization(null);

    await harness.process(jobFixture(0));

    expect(harness.storage.removed).toEqual([KEY]);
  });

  it('**perdeu para COMPLETED com a MESMA chave → NÃO remove**', async () => {
    const harness = lostFinalization(
      contentFixture({
        status: ContentStatus.COMPLETED,
        fileKey: KEY,
        fileUrl: `http://localhost:9000/ai-content/${KEY}`,
      }),
    );

    await harness.process(jobFixture(0));

    // Esta é a invariante que a limpeza cega quebraria: o objeto que acabamos de
    // gravar é exatamente o que o vencedor promete ao cliente. Apagá-lo deixaria
    // um COMPLETED apontando para arquivo inexistente.
    expect(harness.storage.removed).toEqual([]);
    expect(harness.storage.objects.has(KEY)).toBe(true);
    expect(harness.logger.warn).toHaveBeenCalled();
  });

  it('perdeu para COMPLETED com OUTRA chave → remove só a órfã desta tentativa', async () => {
    const harness = lostFinalization(
      contentFixture({ status: ContentStatus.COMPLETED, fileKey: 'contents/outra.txt' }),
    );

    await harness.process(jobFixture(0));

    expect(harness.storage.removed).toEqual([KEY]);
  });

  it('conteúdo ainda ativo → preserva o objeto, porque outra execução vai referenciá-lo', async () => {
    const harness = lostFinalization(contentFixture({ status: ContentStatus.PROCESSING }));

    await harness.process(jobFixture(0));

    expect(harness.storage.removed).toEqual([]);
    expect(harness.logger.warn).toHaveBeenCalled();
  });

  it('falha ao remover o órfão não derruba o job nem altera o estado', async () => {
    const harness = lostFinalization(
      contentFixture({ status: ContentStatus.CANCELED }),
      createFakeStorage({ removeError: new Error('AccessDenied') }),
    );

    await expect(harness.process(jobFixture(0))).resolves.toBeUndefined();

    expect(harness.deps.failIfProcessing).not.toHaveBeenCalled();
    expect(harness.logger.warn).toHaveBeenCalled();
  });
});
