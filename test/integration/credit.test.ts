import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { AppInstance } from '../../src/app.js';
import { ContentStatus } from '../../src/generated/prisma/enums.js';
import { prisma } from '../../src/infra/db/prisma.js';
import { buildTestApp, postGenerate } from '../helpers/app.js';
import { countContents, createUser, creditsOf } from '../helpers/factories.js';

/**
 * I-01 / I-02 / I-03 / I-16 — sistema de créditos contra PostgreSQL real.
 *
 * **I-03 é o teste mais importante do projeto.** É a corrida que o enunciado
 * descreve, e a implementação ingênua (`findUnique` → `if (credits > 0)` →
 * `update`) falha nele quase sempre: as duas requisições leem `credits = 1`,
 * ambas passam no `if` e o saldo termina em `-1` com dois conteúdos criados.
 *
 * Nada aqui pode ser provado com Prisma mockado: a garantia é do banco —
 * `UPDATE ... WHERE credits > 0` sob lock de linha, reavaliado pela segunda
 * transação depois que a primeira comita.
 */

let app: AppInstance;

const TOPIC = 'Concorrência em sistemas distribuídos';

beforeAll(async () => {
  app = await buildTestApp();
});

afterAll(async () => {
  await app.close();
});

describe('POST /api/content/generate', () => {
  it('com saldo disponível: 201, conteúdo em PENDING e um crédito a menos', async () => {
    const user = await createUser(3);

    const response = await postGenerate(app, { topic: TOPIC, userId: user.id });

    expect(response.statusCode).toBe(201);

    const body = response.json<{ id: string; status: string; topic: string; userId: string }>();
    expect(body).toMatchObject({
      status: ContentStatus.PENDING,
      topic: TOPIC,
      userId: user.id,
    });

    expect(await creditsOf(user.id)).toBe(2);
    expect(await countContents(user.id)).toBe(1);

    const persisted = await prisma.content.findUniqueOrThrow({ where: { id: body.id } });
    expect(persisted.status).toBe(ContentStatus.PENDING);
    // Sem Worker nesta fase: PENDING sem arquivo é o estado correto, não um bug.
    expect(persisted.fileUrl).toBeNull();
    expect(persisted.attempts).toBe(0);
  });

  it('sem saldo: 402, nenhum conteúdo criado e saldo intacto', async () => {
    const user = await createUser(0);

    const response = await postGenerate(app, { topic: TOPIC, userId: user.id });

    expect(response.statusCode).toBe(402);
    expect(response.json<{ error: { code: string } }>().error.code).toBe('INSUFFICIENT_CREDITS');
    expect(await creditsOf(user.id)).toBe(0);
    expect(await countContents(user.id)).toBe(0);
  });

  it('usuário inexistente: 404, sem escrever nada', async () => {
    const response = await postGenerate(app, {
      topic: TOPIC,
      userId: '11111111-1111-4111-8111-111111111111',
    });

    expect(response.statusCode).toBe(404);
    expect(response.json<{ error: { code: string } }>().error.code).toBe('USER_NOT_FOUND');
    expect(await prisma.content.count()).toBe(0);
  });

  it('gasta o saldo até o fim e então recusa', async () => {
    const user = await createUser(2);

    const first = await postGenerate(app, { topic: TOPIC, userId: user.id });
    const second = await postGenerate(app, { topic: TOPIC, userId: user.id });
    const third = await postGenerate(app, { topic: TOPIC, userId: user.id });

    expect([first.statusCode, second.statusCode, third.statusCode]).toEqual([201, 201, 402]);
    expect(await creditsOf(user.id)).toBe(0);
    expect(await countContents(user.id)).toBe(2);
  });
});

describe('C-01 — corrida de crédito', () => {
  it('duas requisições simultâneas com 1 crédito: exatamente um 201 e um 402', async () => {
    // Dez rodadas: uma implementação com read-then-write pode vencer uma
    // execução por sorte de escalonamento, não dez seguidas.
    for (let round = 0; round < 10; round += 1) {
      const user = await createUser(1);

      const responses = await Promise.all([
        postGenerate(app, { topic: TOPIC, userId: user.id }),
        postGenerate(app, { topic: TOPIC, userId: user.id }),
      ]);

      const statuses = responses.map((response) => response.statusCode).sort((a, b) => a - b);

      expect(statuses, `rodada ${String(round)}`).toEqual([201, 402]);
      expect(await creditsOf(user.id), `saldo na rodada ${String(round)}`).toBe(0);
      expect(await countContents(user.id), `conteúdos na rodada ${String(round)}`).toBe(1);
    }
  });

  it('cinco requisições simultâneas com 2 créditos: exatamente dois 201', async () => {
    const user = await createUser(2);

    const responses = await Promise.all(
      Array.from({ length: 5 }, () => postGenerate(app, { topic: TOPIC, userId: user.id })),
    );

    const created = responses.filter((response) => response.statusCode === 201);
    const rejected = responses.filter((response) => response.statusCode === 402);

    expect(created).toHaveLength(2);
    expect(rejected).toHaveLength(3);
    expect(await creditsOf(user.id)).toBe(0);
    expect(await countContents(user.id)).toBe(2);
  });
});

describe('defesa em profundidade no banco', () => {
  it('o CHECK rejeita saldo negativo mesmo por escrita direta', async () => {
    const user = await createUser(0);

    await expect(
      prisma.user.update({ where: { id: user.id }, data: { credits: -1 } }),
    ).rejects.toThrow();

    // A conexão continua utilizável depois do erro da constraint.
    expect(await creditsOf(user.id)).toBe(0);
  });
});
