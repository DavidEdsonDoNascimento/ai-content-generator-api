import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { AppInstance } from '../../src/app.js';
import { ContentStatus } from '../../src/generated/prisma/enums.js';
import { prisma } from '../../src/infra/db/prisma.js';
import { buildTestApp, getContent, postCancel } from '../helpers/app.js';
import { createContent, createUser } from '../helpers/factories.js';

/**
 * I-04 / I-07 / I-15 — consulta e cancelamento contra PostgreSQL real.
 *
 * A invariante central é a imutabilidade dos estados terminais: um `CANCELED`
 * que voltasse a `COMPLETED`, ou um `COMPLETED` que aceitasse cancelamento,
 * seria falha eliminatória. Aqui ela é exercida pelo caminho do cliente; na
 * Fase 5 o mesmo predicado passa a ser disputado com o Worker.
 */

let app: AppInstance;

beforeAll(async () => {
  app = await buildTestApp();
});

afterAll(async () => {
  await app.close();
});

describe('GET /api/content/:id', () => {
  it('devolve os dados originais, com fileUrl nulo fora de COMPLETED', async () => {
    const user = await createUser(1);
    const content = await createContent({ userId: user.id, topic: 'Backpressure em filas' });

    const response = await getContent(app, content.id);

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      id: content.id,
      userId: user.id,
      topic: 'Backpressure em filas',
      status: ContentStatus.PENDING,
      fileUrl: null,
      errorMessage: null,
      attempts: 0,
      createdAt: content.createdAt.toISOString(),
      completedAt: null,
      canceledAt: null,
    });
  });

  it('em COMPLETED devolve a URL do arquivo e não expõe a chave interna', async () => {
    const user = await createUser(1);
    const content = await createContent({ userId: user.id, status: ContentStatus.COMPLETED });
    await prisma.content.update({
      where: { id: content.id },
      data: {
        fileUrl: 'http://localhost:9000/ai-content/contents/exemplo.txt',
        fileKey: 'contents/exemplo.txt',
      },
    });

    const response = await getContent(app, content.id);
    const body = response.json<Record<string, unknown>>();

    expect(response.statusCode).toBe(200);
    expect(body['fileUrl']).toBe('http://localhost:9000/ai-content/contents/exemplo.txt');
    // `fileKey`, `updatedAt` e `creditRefundedAt` são internos (ADR-010) e o
    // schema de resposta é o filtro que garante isso ponta a ponta.
    expect(body).not.toHaveProperty('fileKey');
    expect(body).not.toHaveProperty('updatedAt');
    expect(body).not.toHaveProperty('creditRefundedAt');
  });

  it('id inexistente → 404 CONTENT_NOT_FOUND', async () => {
    const response = await getContent(app, '11111111-1111-4111-8111-111111111111');

    expect(response.statusCode).toBe(404);
    expect(response.json<{ error: { code: string } }>().error.code).toBe('CONTENT_NOT_FOUND');
  });

  it('id que não é UUID → 400 antes de tocar o banco', async () => {
    const response = await getContent(app, 'nao-e-uuid');

    expect(response.statusCode).toBe(400);
    expect(response.json<{ error: { code: string } }>().error.code).toBe('VALIDATION_ERROR');
  });
});

describe('POST /api/content/:id/cancel', () => {
  it('PENDING → CANCELED, com canceledAt persistido', async () => {
    const user = await createUser(1);
    const content = await createContent({ userId: user.id });

    const response = await postCancel(app, content.id);

    expect(response.statusCode).toBe(200);
    expect(response.json<{ status: string }>().status).toBe(ContentStatus.CANCELED);

    const persisted = await prisma.content.findUniqueOrThrow({ where: { id: content.id } });
    expect(persisted.status).toBe(ContentStatus.CANCELED);
    expect(persisted.canceledAt).not.toBeNull();
  });

  it('PROCESSING → CANCELED: o predicado do UPDATE inclui os dois estados', async () => {
    const user = await createUser(1);
    const content = await createContent({ userId: user.id, status: ContentStatus.PROCESSING });

    const response = await postCancel(app, content.id);

    expect(response.statusCode).toBe(200);
    expect((await prisma.content.findUniqueOrThrow({ where: { id: content.id } })).status).toBe(
      ContentStatus.CANCELED,
    );
  });

  it.each([
    [ContentStatus.COMPLETED, 'CONTENT_ALREADY_COMPLETED'],
    [ContentStatus.CANCELED, 'CONTENT_ALREADY_CANCELED'],
    [ContentStatus.FAILED, 'CONTENT_ALREADY_FAILED'],
  ])('%s → 409 %s, sem alterar a linha', async (status, code) => {
    const user = await createUser(1);
    const content = await createContent({ userId: user.id, status });
    const before = await prisma.content.findUniqueOrThrow({ where: { id: content.id } });

    const response = await postCancel(app, content.id);

    expect(response.statusCode).toBe(409);
    expect(response.json<{ error: { code: string } }>().error.code).toBe(code);

    // Estado terminal é imutável: nem o status nem o `updatedAt` podem ter se mexido.
    const after = await prisma.content.findUniqueOrThrow({ where: { id: content.id } });
    expect(after.status).toBe(status);
    expect(after.updatedAt.getTime()).toBe(before.updatedAt.getTime());
  });

  it('id inexistente → 404 CONTENT_NOT_FOUND', async () => {
    const response = await postCancel(app, '11111111-1111-4111-8111-111111111111');

    expect(response.statusCode).toBe(404);
    expect(response.json<{ error: { code: string } }>().error.code).toBe('CONTENT_NOT_FOUND');
  });

  it('dois cancelamentos simultâneos: um 200 e um 409, um único canceledAt', async () => {
    const user = await createUser(1);
    const content = await createContent({ userId: user.id });

    const responses = await Promise.all([postCancel(app, content.id), postCancel(app, content.id)]);
    const statuses = responses.map((response) => response.statusCode).sort((a, b) => a - b);

    // O `updateMany` condicional é quem decide: o segundo não encontra linha em
    // estado cancelável, porque o primeiro já a moveu para CANCELED.
    expect(statuses).toEqual([200, 409]);

    const persisted = await prisma.content.findUniqueOrThrow({ where: { id: content.id } });
    expect(persisted.status).toBe(ContentStatus.CANCELED);
  });
});
