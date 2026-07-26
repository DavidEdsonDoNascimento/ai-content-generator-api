import type { Worker } from 'bullmq';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { AppInstance } from '../../src/app.js';
import type { Content } from '../../src/generated/prisma/client.js';
import { ContentStatus } from '../../src/generated/prisma/enums.js';
import { prisma } from '../../src/infra/db/prisma.js';
import type { ContentJobData } from '../../src/infra/queue/job.types.js';
import { CONTENT_FAILURE_CODES } from '../../src/modules/contents/content.failure.js';
import { buildTestApp, getContent, postCancel, postGenerate } from '../helpers/app.js';
import { deferred, waitFor } from '../helpers/async.js';
import { createContent, createUser } from '../helpers/factories.js';
import { createFakeStorage, type FakeStorage } from '../helpers/fake-storage.js';
import {
  buildProcessor,
  createQueueContext,
  fakeJob,
  startWorker,
  type QueueContext,
} from '../helpers/queue.js';

/**
 * I-12, I-13 e a corrida da chave determinística — **PostgreSQL real**, Worker de
 * produção e storage em memória.
 *
 * O storage é o único duplo, e por um motivo preciso: nada do que este arquivo
 * prova é garantia do S3. São decisões do processor — quando enviar, quando
 * **não** enviar, e sobretudo quando remover um objeto sem apagar o arquivo de
 * outra execução. O que é responsabilidade do S3 (round-trip UTF-8,
 * `Content-Type`, URL pública, delete idempotente) foi verificado contra o Minio
 * real antes de a integração ser escrita, e é revalidado manualmente.
 *
 * O teste que mais importa aqui é o da **finalização perdida**: a chave é
 * determinística, então duas execuções do mesmo `contentId` gravam no mesmo
 * objeto. Uma limpeza cega (`if (!completed) remove(key)`) apagaria o arquivo
 * que o vencedor acabou de prometer ao cliente.
 */

const QUEUE_NAME = 'test-queue-storage';
const TOPIC = 'Upload no S3 com Minio';

let app: AppInstance;
let context: QueueContext;
let worker: Worker<ContentJobData> | undefined;
let storage: FakeStorage;

beforeAll(async () => {
  context = createQueueContext({ queueName: QUEUE_NAME, backoffDelayMs: 10 });
  app = await buildTestApp({ queue: context.queue });
});

beforeEach(() => {
  storage = createFakeStorage();
});

afterEach(async () => {
  if (worker !== undefined) {
    await worker.close();
    worker = undefined;
  }
});

afterAll(async () => {
  await app.close();
  await context.close();
});

async function reload(id: string): Promise<Content> {
  return prisma.content.findUniqueOrThrow({ where: { id } });
}

async function generateContent(): Promise<string> {
  const user = await createUser(3);
  const response = await postGenerate(app, { topic: TOPIC, userId: user.id });
  expect(response.statusCode).toBe(201);
  return response.json<{ id: string }>().id;
}

async function waitForStatus(id: string, status: ContentStatus): Promise<void> {
  await waitFor(async () => (await reload(id)).status === status, {
    description: `conteúdo ${id} chegar a ${status}`,
    timeoutMs: 15_000,
  });
}

const keyOf = (contentId: string): string => `contents/${contentId}.txt`;

describe('caminho feliz com upload', () => {
  it('grava um objeto e conclui com fileKey, fileUrl e completedAt juntos', async () => {
    const contentId = await generateContent();

    worker = startWorker({
      context,
      queueName: QUEUE_NAME,
      storage,
      generate: async (topic) => `Texto gerado sobre ${topic}.`,
    });

    await waitForStatus(contentId, ContentStatus.COMPLETED);

    const content = await reload(contentId);
    const key = keyOf(contentId);

    expect(storage.uploadCount()).toBe(1);
    expect(storage.objects.size).toBe(1);
    expect(storage.text(key)).toContain(TOPIC);
    expect(storage.objects.get(key)?.contentType).toBe('text/plain; charset=utf-8');

    expect(content.fileKey).toBe(key);
    expect(content.fileUrl).toBe(`http://localhost:9000/ai-content/${key}`);
    expect(content.completedAt).not.toBeNull();
    expect(content.errorMessage).toBeNull();

    // A URL entregue ao cliente é a externa; o endereço interno da rede do
    // Compose nunca é persistido (ADR-009).
    const response = await getContent(app, contentId);
    expect(response.json<{ fileUrl: string }>().fileUrl).toBe(content.fileUrl);
    expect(content.fileUrl).not.toContain('minio:9000');
  });
});

describe('I-12 — falha de upload', () => {
  it('falha nas duas primeiras e sucede na terceira: COMPLETED sem passar por FAILED', async () => {
    const contentId = await generateContent();
    const statusPerAttempt: string[] = [];

    // O fake falha os dois primeiros uploads; o terceiro grava.
    storage = createFakeStorage({ failUploads: 2 });

    worker = startWorker({
      context,
      queueName: QUEUE_NAME,
      storage,
      generate: async (topic) => {
        statusPerAttempt.push((await reload(contentId)).status);
        return `Texto sobre ${topic}.`;
      },
    });

    await waitForStatus(contentId, ContentStatus.COMPLETED);

    const content = await reload(contentId);
    expect(content.attempts).toBe(3);
    expect(content.errorMessage).toBeNull();
    expect(content.fileKey).toBe(keyOf(contentId));

    // Entre as tentativas o conteúdo permaneceu em PROCESSING: falha de upload
    // segue a mesma política de retry da falha de IA (ADR-005).
    expect(statusPerAttempt).toEqual([
      ContentStatus.PROCESSING,
      ContentStatus.PROCESSING,
      ContentStatus.PROCESSING,
    ]);

    // Chave determinística: três tentativas, um único objeto.
    expect(storage.uploadCount()).toBe(3);
    expect(storage.objects.size).toBe(1);
  });

  it('falha sempre: FAILED com UPLOAD_FAILED e sem arquivo', async () => {
    const contentId = await generateContent();
    storage = createFakeStorage({ failUploads: 'always' });

    worker = startWorker({
      context,
      queueName: QUEUE_NAME,
      storage,
      generate: async (topic) => `Texto sobre ${topic}.`,
    });

    await waitForStatus(contentId, ContentStatus.FAILED);

    const content = await reload(contentId);
    expect(content.attempts).toBe(3);
    // O motivo é o do upload, não o da IA — a classificação é posicional.
    expect(content.errorMessage).toBe(CONTENT_FAILURE_CODES.UPLOAD_FAILED);
    expect(content.fileKey).toBeNull();
    expect(content.fileUrl).toBeNull();
    expect(content.completedAt).toBeNull();
    expect(storage.objects.size).toBe(0);

    // Nada da mensagem do SDK vaza para o banco nem para o HTTP.
    const body = (await getContent(app, contentId)).body;
    expect(body).not.toContain('NoSuchBucket');
    expect(body).not.toContain('minio:9000');
  });
});

describe('I-13 — cancelamento durante o upload', () => {
  it('cancelar com o upload em voo mantém CANCELED e remove o objeto gravado', async () => {
    const contentId = await generateContent();
    const uploadStarted = deferred();
    const releaseUpload = deferred();

    storage = createFakeStorage({
      onUpload: async () => {
        uploadStarted.resolve();
        // Barreira: o upload fica exatamente onde a rede estaria, e é aí que o
        // `/cancel` do usuário entra.
        await releaseUpload.promise;
      },
    });

    worker = startWorker({
      context,
      queueName: QUEUE_NAME,
      storage,
      generate: async (topic) => `Texto sobre ${topic}.`,
    });

    await uploadStarted.promise;

    const cancelResponse = await postCancel(app, contentId);
    expect(cancelResponse.statusCode).toBe(200);

    releaseUpload.resolve();

    await waitFor(
      async () => {
        const counts = await context.raw.getJobCounts('active');
        return (counts['active'] ?? 0) === 0;
      },
      { description: 'o job sair de active' },
    );

    const content = await reload(contentId);
    const key = keyOf(contentId);

    // A finalização condicional não encontrou `PROCESSING`; o cancelamento
    // venceu, e o objeto recém-gravado virou órfão.
    expect(content.status).toBe(ContentStatus.CANCELED);
    expect(content.fileKey).toBeNull();
    expect(content.fileUrl).toBeNull();
    expect(content.completedAt).toBeNull();

    expect(storage.removed).toEqual([key]);
    expect(storage.objects.has(key)).toBe(false);
  });

  it('falha ao remover o órfão não altera o estado final nem derruba o job', async () => {
    const contentId = await generateContent();
    const uploadStarted = deferred();
    const releaseUpload = deferred();

    storage = createFakeStorage({
      removeError: new Error('AccessDenied: policy do bucket'),
      onUpload: async () => {
        uploadStarted.resolve();
        await releaseUpload.promise;
      },
    });

    worker = startWorker({
      context,
      queueName: QUEUE_NAME,
      storage,
      generate: async (topic) => `Texto sobre ${topic}.`,
    });

    await uploadStarted.promise;
    await postCancel(app, contentId);
    releaseUpload.resolve();

    await waitFor(
      async () => {
        const counts = await context.raw.getJobCounts('active');
        return (counts['active'] ?? 0) === 0;
      },
      { description: 'o job sair de active' },
    );

    // O delete falhou, mas o estado do conteúdo é o que importa e continua
    // correto. Retentar a IA inteira só para limpar um arquivo de conteúdo
    // cancelado seria trocar kilobytes por segundos de trabalho.
    const content = await reload(contentId);
    expect(content.status).toBe(ContentStatus.CANCELED);
    expect(content.errorMessage).toBeNull();
    expect(storage.removed).toEqual([keyOf(contentId)]);
  });
});

describe('finalização perdida para outra execução', () => {
  it('**não apaga** o objeto quando o vencedor referencia a mesma chave', async () => {
    const user = await createUser(1);
    const content = await createContent({ userId: user.id, status: ContentStatus.PROCESSING });
    const key = keyOf(content.id);
    const winnerUrl = `http://localhost:9000/ai-content/${key}`;

    const uploadStarted = deferred();
    const releaseUpload = deferred();

    storage = createFakeStorage({
      onUpload: async () => {
        uploadStarted.resolve();
        await releaseUpload.promise;
      },
    });

    // Execução perdedora: sobe o objeto e trava no upload.
    const loser = buildProcessor(async () => 'texto do perdedor', storage)(fakeJob(content.id));

    await uploadStarted.promise;

    // Enquanto o perdedor está travado, "outra execução" vence a finalização —
    // gravando exatamente a MESMA chave determinística.
    await prisma.content.updateMany({
      where: { id: content.id, status: ContentStatus.PROCESSING },
      data: {
        status: ContentStatus.COMPLETED,
        fileKey: key,
        fileUrl: winnerUrl,
        completedAt: new Date(),
      },
    });

    releaseUpload.resolve();
    await loser;

    // O perdedor releu o conteúdo, viu `COMPLETED` apontando para a sua própria
    // chave e **preservou** o objeto. A limpeza cega apagaria aqui o arquivo que
    // o cliente vai baixar.
    expect(storage.removed).toEqual([]);
    expect(storage.objects.has(key)).toBe(true);

    const finalContent = await reload(content.id);
    expect(finalContent.status).toBe(ContentStatus.COMPLETED);
    expect(finalContent.fileKey).toBe(key);
    expect(finalContent.fileUrl).toBe(winnerUrl);
  });

  it('apaga apenas a chave órfã quando o vencedor referencia outra', async () => {
    const user = await createUser(1);
    const content = await createContent({ userId: user.id, status: ContentStatus.PROCESSING });
    const key = keyOf(content.id);
    const uploadStarted = deferred();
    const releaseUpload = deferred();

    storage = createFakeStorage({
      onUpload: async () => {
        uploadStarted.resolve();
        await releaseUpload.promise;
      },
    });

    const loser = buildProcessor(async () => 'texto do perdedor', storage)(fakeJob(content.id));
    await uploadStarted.promise;

    await prisma.content.updateMany({
      where: { id: content.id, status: ContentStatus.PROCESSING },
      data: {
        status: ContentStatus.COMPLETED,
        fileKey: 'contents/chave-de-outra-execucao.txt',
        fileUrl: 'http://localhost:9000/ai-content/contents/chave-de-outra-execucao.txt',
        completedAt: new Date(),
      },
    });

    releaseUpload.resolve();
    await loser;

    // O `COMPLETED` aponta para outro objeto, então o desta tentativa não é
    // referenciado por ninguém e pode ir embora.
    expect(storage.removed).toEqual([key]);
    expect(storage.objects.has(key)).toBe(false);
  });
});

describe('idempotência com storage', () => {
  it.each([ContentStatus.COMPLETED, ContentStatus.CANCELED, ContentStatus.FAILED])(
    'reprocessar conteúdo em %s não chama o storage e não muda nada',
    async (status) => {
      const user = await createUser(1);
      const content = await createContent({ userId: user.id, status });
      const before = await reload(content.id);
      const creditsBefore = (
        await prisma.user.findUniqueOrThrow({ where: { id: user.id }, select: { credits: true } })
      ).credits;

      await buildProcessor(async () => 'não deveria ser chamada', storage)(fakeJob(content.id));

      const after = await reload(content.id);
      expect(storage.history).toEqual([]);
      expect(after.attempts).toBe(before.attempts);
      expect(after.updatedAt.getTime()).toBe(before.updatedAt.getTime());
      expect(after.completedAt?.getTime() ?? null).toBe(before.completedAt?.getTime() ?? null);
      expect(after.canceledAt?.getTime() ?? null).toBe(before.canceledAt?.getTime() ?? null);
      // O Worker nunca mexe em crédito — nem para cobrar, nem para estornar.
      expect(
        (await prisma.user.findUniqueOrThrow({ where: { id: user.id }, select: { credits: true } }))
          .credits,
      ).toBe(creditsBefore);
    },
  );

  it('reprocessar um COMPLETED não gera segundo objeto', async () => {
    const contentId = await generateContent();

    worker = startWorker({
      context,
      queueName: QUEUE_NAME,
      storage,
      generate: async (topic) => `Texto sobre ${topic}.`,
    });
    await waitForStatus(contentId, ContentStatus.COMPLETED);
    await worker.close();
    worker = undefined;

    const completed = await reload(contentId);
    const uploadsAfterFirstRun = storage.uploadCount();

    await buildProcessor(async () => 'segunda passada', storage)(fakeJob(contentId));

    expect(storage.uploadCount()).toBe(uploadsAfterFirstRun);
    expect(storage.objects.size).toBe(1);

    const after = await reload(contentId);
    expect(after.completedAt?.getTime()).toBe(completed.completedAt?.getTime());
    expect(after.fileKey).toBe(completed.fileKey);
    expect(after.attempts).toBe(completed.attempts);
  });
});
