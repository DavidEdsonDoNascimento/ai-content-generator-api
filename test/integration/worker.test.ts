import type { Worker } from 'bullmq';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { AppInstance } from '../../src/app.js';
import type { Content } from '../../src/generated/prisma/client.js';
import { ContentStatus } from '../../src/generated/prisma/enums.js';
import { prisma } from '../../src/infra/db/prisma.js';
import type { ContentJobData } from '../../src/infra/queue/job.types.js';
import { AI_GENERATION_FAILED, AiGenerationError } from '../../src/worker/ai/generate-content.js';
import { buildTestApp, getContent, postCancel, postGenerate } from '../helpers/app.js';
import { deferred, waitFor } from '../helpers/async.js';
import { createContent, createUser, creditsOf } from '../helpers/factories.js';
import { createFakeStorage, type FakeStorage } from '../helpers/fake-storage.js';
import {
  buildProcessor,
  createQueueContext,
  fakeJob,
  startWorker,
  type QueueContext,
} from '../helpers/queue.js';

/**
 * I-05, I-06, I-08, I-09, I-10 — ciclo assíncrono com **PostgreSQL e Redis
 * reais**, e o Worker de produção.
 *
 * Só a IA é substituída, porque 5 s de espera e 20 % de aleatoriedade não são
 * invariante — são o que impede um teste determinístico. Tudo o mais é o código
 * que vai para produção: fila, Worker, processor e repositórios.
 *
 * As duas provas que justificam este arquivo:
 *
 * - **o cancelamento sempre vence** a finalização do Worker, mesmo quando chega
 *   no meio da geração (o cenário que o enunciado cobra nominalmente);
 * - **`FAILED` só aparece quando as tentativas se esgotam** — entre elas o
 *   conteúdo permanece em `PROCESSING`, o que é verificado de dentro da própria
 *   IA falsa, no instante de cada tentativa.
 */

const QUEUE_NAME = 'test-queue-worker';
const TOPIC = 'Ciclo assíncrono completo';

let app: AppInstance;
let context: QueueContext;
let worker: Worker<ContentJobData> | undefined;
/** Storage em memória, novo a cada caso — ver `test/helpers/fake-storage.ts`. */
let storage: FakeStorage;

beforeEach(() => {
  storage = createFakeStorage();
});

beforeAll(async () => {
  context = createQueueContext({ queueName: QUEUE_NAME, backoffDelayMs: 10 });
  app = await buildTestApp({ queue: context.queue });
});

afterEach(async () => {
  // Cada caso sobe o seu Worker com a IA que precisa; deixá-lo vivo faria o
  // próximo caso disputar jobs com ele.
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

describe('I-01 estendido — caminho feliz assíncrono', () => {
  it('PENDING → PROCESSING → COMPLETED, com uma tentativa contabilizada', async () => {
    const contentId = await generateContent();

    expect((await reload(contentId)).status).toBe(ContentStatus.PENDING);

    worker = startWorker({
      context,
      queueName: QUEUE_NAME,
      storage,
      generate: async (topic) => `texto sobre ${topic}`,
    });

    await waitForStatus(contentId, ContentStatus.COMPLETED);

    const content = await reload(contentId);
    expect(content.attempts).toBe(1);
    expect(content.completedAt).not.toBeNull();
    expect(content.errorMessage).toBeNull();

    // A Fase 6 fecha o checkpoint transitório da Fase 5: `COMPLETED` agora
    // carrega o arquivo, e os dois campos foram gravados na mesma instrução do
    // status — nunca houve um instante de `COMPLETED` sem URL.
    const key = `contents/${contentId}.txt`;
    expect(content.fileKey).toBe(key);
    expect(content.fileUrl).toBe(`http://localhost:9000/ai-content/${key}`);

    // Um único objeto, com o texto da IA em UTF-8.
    expect(storage.uploadCount()).toBe(1);
    expect(storage.objects.size).toBe(1);
    expect(storage.text(key)).toContain(TOPIC);
    expect(storage.removed).toEqual([]);
  });

  it('GET /api/content/:id devolve a URL pública e nenhum campo interno', async () => {
    const contentId = await generateContent();

    worker = startWorker({
      context,
      queueName: QUEUE_NAME,
      storage,
      generate: async (topic) => `texto sobre ${topic}`,
    });

    await waitForStatus(contentId, ContentStatus.COMPLETED);

    const response = await getContent(app, contentId);
    const body = response.json<Record<string, unknown>>();

    expect(response.statusCode).toBe(200);
    expect(body['fileUrl']).toBe(`http://localhost:9000/ai-content/contents/${contentId}.txt`);
    // O endereço interno da rede do Compose nunca chega ao cliente (ADR-009).
    expect(String(body['fileUrl'])).not.toContain('minio:9000');
    // `fileKey` é interno e continua fora do contrato.
    expect(body).not.toHaveProperty('fileKey');
    expect(body).not.toHaveProperty('creditRefundedAt');
  });

  it('a resposta HTTP não espera a IA', async () => {
    const user = await createUser(1);
    const release = deferred();

    worker = startWorker({
      context,
      queueName: QUEUE_NAME,
      storage,
      generate: async () => {
        await release.promise;
        return 'texto';
      },
    });

    const started = Date.now();
    const response = await postGenerate(app, { topic: TOPIC, userId: user.id });
    const elapsed = Date.now() - started;

    // A IA está travada e a requisição já respondeu: o processamento é
    // assíncrono de verdade, não um `await` disfarçado.
    expect(response.statusCode).toBe(201);
    expect(elapsed).toBeLessThan(2_000);

    release.resolve();
    await waitForStatus(response.json<{ id: string }>().id, ContentStatus.COMPLETED);
  });
});

describe('I-08 — retry: falha na primeira, sucesso na segunda', () => {
  it('termina em COMPLETED com attempts = 2, sem nunca passar por FAILED', async () => {
    const contentId = await generateContent();
    /** Status observado no instante de cada tentativa, lido do banco. */
    const statusPerAttempt: string[] = [];
    let calls = 0;

    worker = startWorker({
      context,
      queueName: QUEUE_NAME,
      storage,
      generate: async (topic) => {
        calls += 1;
        statusPerAttempt.push((await reload(contentId)).status);

        if (calls === 1) {
          throw new AiGenerationError();
        }
        return `texto sobre ${topic}`;
      },
    });

    await waitForStatus(contentId, ContentStatus.COMPLETED);

    const content = await reload(contentId);
    expect(content.attempts).toBe(2);
    expect(content.errorMessage).toBeNull();
    expect(content.completedAt).not.toBeNull();

    // A asserção que prova ADR-005: na segunda tentativa o conteúdo estava em
    // PROCESSING, não em FAILED nem de volta em PENDING.
    expect(statusPerAttempt).toEqual([ContentStatus.PROCESSING, ContentStatus.PROCESSING]);
  });
});

describe('I-09 — falha definitiva', () => {
  it('três falhas → FAILED com attempts = 3 e errorMessage sanitizado', async () => {
    const contentId = await generateContent();
    const statusPerAttempt: string[] = [];

    worker = startWorker({
      context,
      queueName: QUEUE_NAME,
      storage,
      generate: async () => {
        statusPerAttempt.push((await reload(contentId)).status);
        throw new AiGenerationError();
      },
    });

    await waitForStatus(contentId, ContentStatus.FAILED);

    const content = await reload(contentId);
    expect(content.attempts).toBe(3);
    expect(content.errorMessage).toBe(AI_GENERATION_FAILED);
    expect(content.completedAt).toBeNull();

    // Três tentativas, e em **todas** o conteúdo estava em PROCESSING: FAILED só
    // foi gravado depois da última. Um FAILED prematuro apareceria aqui — e a
    // segunda tentativa nem rodaria, porque o claim não aceita estado terminal.
    expect(statusPerAttempt).toEqual([
      ContentStatus.PROCESSING,
      ContentStatus.PROCESSING,
      ContentStatus.PROCESSING,
    ]);
  });

  it('não vaza detalhe interno no errorMessage de uma falha inesperada', async () => {
    const contentId = await generateContent();

    worker = startWorker({
      context,
      queueName: QUEUE_NAME,
      storage,
      generate: async () => {
        throw new Error('ECONNREFUSED 10.0.0.7:443 token=segredo-interno');
      },
    });

    await waitForStatus(contentId, ContentStatus.FAILED);

    const content = await reload(contentId);
    expect(content.errorMessage).toBe(AI_GENERATION_FAILED);
    expect(content.errorMessage).not.toContain('segredo-interno');
    expect(content.errorMessage).not.toContain('ECONNREFUSED');
  });
});

describe('I-06 — cancelamento durante PROCESSING', () => {
  it('cancelar no meio da geração mantém CANCELED, e o Worker não ressuscita', async () => {
    const contentId = await generateContent();
    const aiStarted = deferred();
    const release = deferred();

    worker = startWorker({
      context,
      queueName: QUEUE_NAME,
      storage,
      generate: async () => {
        aiStarted.resolve();
        // A IA fica travada exatamente onde os 5 s de produção estariam: é essa
        // janela que o `/cancel` do usuário disputa.
        await release.promise;
        return 'texto que nunca deveria ser publicado';
      },
    });

    await aiStarted.promise;
    await waitForStatus(contentId, ContentStatus.PROCESSING);

    const cancelResponse = await postCancel(app, contentId);
    expect(cancelResponse.statusCode).toBe(200);

    // Só agora a IA "termina com sucesso" e o Worker tenta finalizar.
    release.resolve();

    await waitFor(
      async () => {
        const jobs = await context.raw.getJobCounts('active');
        return (jobs['active'] ?? 0) === 0;
      },
      { description: 'o job sair de active' },
    );

    const content = await reload(contentId);
    // O `WHERE status = PROCESSING` do UPDATE final não encontrou linha: a
    // garantia é do PostgreSQL, não de um `if` no Worker (ADR-006).
    expect(content.status).toBe(ContentStatus.CANCELED);
    expect(content.completedAt).toBeNull();
    expect(content.canceledAt).not.toBeNull();
    expect(content.fileUrl).toBeNull();
    expect(content.fileKey).toBeNull();

    // O cancelamento chegou **antes** do upload, então a guarda pré-upload
    // economizou os bytes: nada foi gravado, e não há órfão a remover.
    expect(storage.history).toEqual([]);
  });

  it('cancelar durante a última tentativa impede até o FAILED', async () => {
    const contentId = await generateContent();
    const aiStarted = deferred();
    const release = deferred();

    worker = startWorker({
      context,
      queueName: QUEUE_NAME,
      storage,
      generate: async () => {
        aiStarted.resolve();
        await release.promise;
        throw new AiGenerationError();
      },
    });

    await aiStarted.promise;
    await waitForStatus(contentId, ContentStatus.PROCESSING);
    // Cancela com o job na primeira e única tentativa desta fila reduzida.
    await postCancel(app, contentId);
    release.resolve();

    await waitFor(
      async () => {
        const counts = await context.raw.getJobCounts('active');
        return (counts['active'] ?? 0) === 0;
      },
      { description: 'o job sair de active' },
    );

    // `failIfProcessing` também carrega o predicado de status: nem a falha
    // definitiva sobrescreve um cancelamento.
    const content = await reload(contentId);
    expect(content.status).toBe(ContentStatus.CANCELED);
    expect(content.errorMessage).toBeNull();
  });
});

describe('I-10 — idempotência do processor', () => {
  it.each([ContentStatus.COMPLETED, ContentStatus.CANCELED, ContentStatus.FAILED])(
    'reprocessar conteúdo em %s é no-op: nem banco, nem storage, nem crédito',
    async (status) => {
      const user = await createUser(1);
      const content = await createContent({ userId: user.id, status });
      const before = await reload(content.id);
      const creditsBefore = await creditsOf(user.id);

      const process = buildProcessor(async () => 'não deveria ser chamada', storage);
      await process(fakeJob(content.id));

      const after = await reload(content.id);
      expect(after.status).toBe(status);
      expect(after.attempts).toBe(before.attempts);
      expect(after.updatedAt.getTime()).toBe(before.updatedAt.getTime());
      expect(after.completedAt?.getTime() ?? null).toBe(before.completedAt?.getTime() ?? null);
      expect(after.canceledAt?.getTime() ?? null).toBe(before.canceledAt?.getTime() ?? null);
      // A guarda de terminal roda **antes** de qualquer chamada externa: nenhum
      // upload, nenhum remove, nem sequer um `buildPublicUrl`.
      expect(storage.history).toEqual([]);
      // O Worker nunca mexe em crédito — nem para cobrar, nem para estornar.
      expect(await creditsOf(user.id)).toBe(creditsBefore);
    },
  );

  it('reprocessar um COMPLETED não gera segunda conclusão nem crédito extra', async () => {
    const contentId = await generateContent();
    const creditsAfterGenerate = await prisma.user.findFirstOrThrow({
      where: { contents: { some: { id: contentId } } },
      select: { credits: true, id: true },
    });

    worker = startWorker({
      context,
      queueName: QUEUE_NAME,
      storage,
      generate: async () => 'texto',
    });
    await waitForStatus(contentId, ContentStatus.COMPLETED);
    await worker.close();
    worker = undefined;

    const completed = await reload(contentId);

    const process = buildProcessor(async () => 'segunda passada', storage);
    await process(fakeJob(contentId, 0));

    const after = await reload(contentId);
    expect(after.completedAt?.getTime()).toBe(completed.completedAt?.getTime());
    expect(after.attempts).toBe(completed.attempts);
    expect(
      (
        await prisma.user.findUniqueOrThrow({
          where: { id: creditsAfterGenerate.id },
          select: { credits: true },
        })
      ).credits,
    ).toBe(creditsAfterGenerate.credits);
  });

  it('conteúdo inexistente → erro não retentável, sem criar nada', async () => {
    const process = buildProcessor(async () => 'texto', storage);

    await expect(process(fakeJob('11111111-1111-4111-8111-111111111111'))).rejects.toThrow(
      /não existe/,
    );
    expect(await prisma.content.count()).toBe(0);
  });
});

describe('job tardio de conteúdo compensado', () => {
  it('FAILED por QUEUE_UNAVAILABLE torna o job inofensivo', async () => {
    const user = await createUser(1);
    // Estado exato deixado pela compensação (ADR-008): terminal, com o crédito
    // já devolvido. Um job que chegue depois disso precisa ser inerte.
    const content = await createContent({ userId: user.id, status: ContentStatus.FAILED });
    await prisma.content.update({
      where: { id: content.id },
      data: { errorMessage: 'QUEUE_UNAVAILABLE', creditRefundedAt: new Date() },
    });
    const before = await reload(content.id);

    worker = startWorker({
      context,
      queueName: QUEUE_NAME,
      storage,
      generate: async () => 'texto que não deveria ser gerado',
    });
    await context.queue.enqueue(content.id);

    await waitFor(
      async () => {
        const job = await context.raw.getJob(content.id);
        return job !== undefined && (await job.isCompleted());
      },
      { description: 'o job tardio terminar' },
    );

    const after = await reload(content.id);
    // A guarda de estado terminal no início do processor resolve: o job termina
    // como sucesso e nada muda.
    expect(after.status).toBe(ContentStatus.FAILED);
    expect(after.errorMessage).toBe('QUEUE_UNAVAILABLE');
    expect(after.attempts).toBe(before.attempts);
    expect(after.updatedAt.getTime()).toBe(before.updatedAt.getTime());
  });
});

/**
 * C-04 — entrega *at-least-once*.
 *
 * A fila promete entregar **pelo menos** uma vez, não exatamente uma. As duas
 * defesas contra isso são de naturezas diferentes e por isso têm um caso cada:
 *
 * - **enquanto o job existe**, o `jobId = contentId` faz o BullMQ recusar o
 *   segundo `add` — dedupe de graça (ADR-007);
 * - **depois que o job some** (o `removeOnComplete: { count: 100 }` libera o id
 *   para reuso), o dedupe já não protege nada, e quem responde é a guarda de
 *   estado terminal no início do processor.
 *
 * A segunda é a que importa: a primeira é otimização, a segunda é a garantia.
 * Os testes de idempotência acima chamam o processor **direto**; estes passam
 * pela fila real, que é onde a duplicata de verdade nasce.
 */
describe('C-04 — processamento duplicado', () => {
  it('mesmo jobId publicado duas vezes → uma execução, um upload, uma tentativa', async () => {
    const contentId = await generateContent();
    let generateCalls = 0;

    // Segundo `add` com o job da requisição original ainda na fila.
    await context.queue.enqueue(contentId);
    expect(await context.raw.getWaitingCount()).toBe(1);

    worker = startWorker({
      context,
      queueName: QUEUE_NAME,
      storage,
      generate: async (topic) => {
        generateCalls += 1;
        return `texto sobre ${topic}`;
      },
    });

    await waitForStatus(contentId, ContentStatus.COMPLETED);

    const content = await reload(contentId);
    expect(generateCalls).toBe(1);
    expect(content.attempts).toBe(1);
    expect(storage.uploadCount()).toBe(1);
    expect(storage.objects.size).toBe(1);
  });

  it('reenfileirar depois de o job sumir: conteúdo COMPLETED torna a segunda entrega inerte', async () => {
    const contentId = await generateContent();

    worker = startWorker({
      context,
      queueName: QUEUE_NAME,
      storage,
      generate: async (topic) => `texto sobre ${topic}`,
    });
    await waitForStatus(contentId, ContentStatus.COMPLETED);
    await worker.close();
    worker = undefined;

    const completed = await reload(contentId);
    const creditsBefore = await prisma.user.findUniqueOrThrow({
      where: { id: completed.userId },
      select: { credits: true },
    });
    const uploadsBefore = storage.uploadCount();

    // Fecha a janela de dedupe à mão, em vez de publicar 100 jobs para que o
    // `removeOnComplete` a feche sozinho. O efeito no Redis é o mesmo: a chave
    // do job deixa de existir e o `contentId` volta a ser aceito.
    await (await context.raw.getJob(contentId))?.remove();
    await context.queue.enqueue(contentId);

    // O segundo `add` foi aceito — é essa aceitação que prova que o dedupe por
    // `jobId` tem janela finita, e que a guarda de estado é quem protege daqui
    // em diante (ADR-007).
    expect(await context.raw.getWaitingCount()).toBe(1);

    worker = startWorker({
      context,
      queueName: QUEUE_NAME,
      storage,
      generate: async () => {
        throw new Error('a IA não deveria rodar para um conteúdo já concluído');
      },
    });

    await waitFor(
      async () => {
        const job = await context.raw.getJob(contentId);
        return job !== undefined && (await job.isCompleted());
      },
      { description: 'a segunda entrega terminar' },
    );

    const after = await reload(contentId);
    // O job encerra em **sucesso** e nada se move: nem status, nem tentativa,
    // nem timestamp, nem crédito, nem storage.
    expect(after.status).toBe(ContentStatus.COMPLETED);
    expect(after.attempts).toBe(completed.attempts);
    expect(after.completedAt?.getTime()).toBe(completed.completedAt?.getTime());
    expect(after.updatedAt.getTime()).toBe(completed.updatedAt.getTime());
    expect(after.fileKey).toBe(completed.fileKey);
    expect(storage.uploadCount()).toBe(uploadsBefore);
    expect(storage.removed).toEqual([]);
    expect(storage.objects.size).toBe(1);
    expect(
      (
        await prisma.user.findUniqueOrThrow({
          where: { id: completed.userId },
          select: { credits: true },
        })
      ).credits,
    ).toBe(creditsBefore.credits);
  });
});
