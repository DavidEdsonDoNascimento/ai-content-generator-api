import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { AppInstance } from '../../src/app.js';
import { ContentStatus } from '../../src/generated/prisma/enums.js';
import { prisma } from '../../src/infra/db/prisma.js';
import { buildTestApp, postCancel, postGenerate } from '../helpers/app.js';
import { countContents, createContent, createUser, creditsOf } from '../helpers/factories.js';
import { createQueueContext, type QueueContext } from '../helpers/queue.js';

/**
 * Publicação e remoção de jobs, contra **Redis real**.
 *
 * Aqui não há Worker: o alvo é o lado da API. O que se prova é que a fila recebe
 * exatamente um job por conteúdo criado, com `jobId = contentId` (ADR-007), que
 * requisição recusada não publica nada, e que o cancelamento retira da fila o
 * job que ainda não começou — sem que a limpeza possa comprometer o cancelamento
 * já confirmado no banco.
 */

const QUEUE_NAME = 'test-queue-publishing';
const TOPIC = 'Publicação de jobs';

let app: AppInstance;
let context: QueueContext;

beforeAll(async () => {
  context = createQueueContext({ queueName: QUEUE_NAME });
  app = await buildTestApp({ queue: context.queue });
});

afterAll(async () => {
  await app.close();
  await context.close();
});

describe('POST /generate publica o job', () => {
  it('cria o conteúdo, debita o crédito e publica um job com jobId = contentId', async () => {
    const user = await createUser(2);

    const response = await postGenerate(app, { topic: TOPIC, userId: user.id });
    const { id } = response.json<{ id: string }>();

    expect(response.statusCode).toBe(201);
    expect(await creditsOf(user.id)).toBe(1);

    const job = await context.raw.getJob(id);
    expect(job).toBeDefined();
    expect(job?.id).toBe(id);
    expect(job?.data).toEqual({ contentId: id });
    // Exatamente um job — não zero (perdido) nem dois (duplicado).
    expect(await context.raw.getWaitingCount()).toBe(1);
  });

  it('publica com as opções de retry configuradas', async () => {
    const user = await createUser(1);

    const { id } = (await postGenerate(app, { topic: TOPIC, userId: user.id })).json<{
      id: string;
    }>();

    const job = await context.raw.getJob(id);

    expect(job?.opts.attempts).toBe(3);
    expect(job?.opts.backoff).toMatchObject({ type: 'exponential' });
  });

  it('usuário sem crédito → 402 e nenhum job publicado', async () => {
    const user = await createUser(0);

    const response = await postGenerate(app, { topic: TOPIC, userId: user.id });

    expect(response.statusCode).toBe(402);
    expect(await context.raw.getWaitingCount()).toBe(0);
    expect(await countContents(user.id)).toBe(0);
  });

  it('usuário inexistente → 404 e nenhum job publicado', async () => {
    const response = await postGenerate(app, {
      topic: TOPIC,
      userId: '11111111-1111-4111-8111-111111111111',
    });

    expect(response.statusCode).toBe(404);
    expect(await context.raw.getWaitingCount()).toBe(0);
  });

  it('duas requisições simultâneas com 1 crédito → um conteúdo e um job', async () => {
    const user = await createUser(1);

    const responses = await Promise.all([
      postGenerate(app, { topic: TOPIC, userId: user.id }),
      postGenerate(app, { topic: TOPIC, userId: user.id }),
    ]);

    expect(responses.map((r) => r.statusCode).sort((a, b) => a - b)).toEqual([201, 402]);
    expect(await countContents(user.id)).toBe(1);
    // A corrida do crédito é resolvida no PostgreSQL, então a fila herda o
    // resultado: um único job, sem trabalho fantasma.
    expect(await context.raw.getWaitingCount()).toBe(1);
  });
});

describe('deduplicação por jobId', () => {
  it('publicar o mesmo contentId duas vezes resulta em um único job', async () => {
    const user = await createUser(1);
    const content = await createContent({ userId: user.id });

    await context.queue.enqueue(content.id);
    await context.queue.enqueue(content.id);

    // O BullMQ recusa o segundo `add` enquanto o job existir: é o dedupe de
    // graça que o `jobId = contentId` dá (ADR-007).
    expect(await context.raw.getWaitingCount()).toBe(1);
    expect((await context.raw.getJob(content.id))?.id).toBe(content.id);
  });
});

describe('cancelamento e limpeza da fila', () => {
  it('cancelar PENDING remove o job que ainda não começou', async () => {
    const user = await createUser(1);
    const { id } = (await postGenerate(app, { topic: TOPIC, userId: user.id })).json<{
      id: string;
    }>();

    expect(await context.raw.getWaitingCount()).toBe(1);

    const response = await postCancel(app, id);

    expect(response.statusCode).toBe(200);
    expect(await context.raw.getJob(id)).toBeUndefined();
    expect(await context.raw.getWaitingCount()).toBe(0);
    // O que decide o cancelamento é o banco; a fila só foi limpa em seguida.
    expect((await prisma.content.findUniqueOrThrow({ where: { id } })).status).toBe(
      ContentStatus.CANCELED,
    );
  });

  it('cancelar conteúdo sem job na fila continua sendo sucesso', async () => {
    const user = await createUser(1);
    const content = await createContent({ userId: user.id, status: ContentStatus.PROCESSING });

    // Nenhum job foi publicado para este conteúdo: `removeIfPending` devolve
    // `absent`, e isso não é erro — o cancelamento no banco é o que vale.
    const response = await postCancel(app, content.id);

    expect(response.statusCode).toBe(200);
    expect((await prisma.content.findUniqueOrThrow({ where: { id: content.id } })).status).toBe(
      ContentStatus.CANCELED,
    );
  });

  it('cancelar em estado terminal → 409 e o job permanece intocado', async () => {
    const user = await createUser(1);
    const content = await createContent({ userId: user.id, status: ContentStatus.COMPLETED });
    await context.queue.enqueue(content.id);

    const response = await postCancel(app, content.id);

    expect(response.statusCode).toBe(409);
    // A remoção só acontece depois de o banco confirmar. Como ele recusou, a
    // fila não foi tocada.
    expect(await context.raw.getJob(content.id)).toBeDefined();
  });
});
