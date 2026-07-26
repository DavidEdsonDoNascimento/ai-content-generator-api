import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { AppInstance } from '../../src/app.js';
import { ContentStatus } from '../../src/generated/prisma/enums.js';
import { prisma } from '../../src/infra/db/prisma.js';
import { CONTENT_FAILURE_CODES } from '../../src/modules/contents/content.failure.js';
import * as contentRepository from '../../src/modules/contents/content.repository.js';
import * as userRepository from '../../src/modules/users/user.repository.js';
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

describe('compensação de QUEUE_UNAVAILABLE sob concorrência', () => {
  /**
   * A compensação da mesma linha, executada em paralelo.
   *
   * O unitário do service já prova que o estorno **segue** o retorno de
   * `failForQueueUnavailable` — mas ele simula a guarda com uma flag em
   * memória. A guarda de verdade é o `WHERE status = 'PENDING' AND
   * "creditRefundedAt" IS NULL` avaliado pelo PostgreSQL sob lock de linha, e é
   * isso que este caso exercita: duas transações concorrentes disputando a
   * mesma linha, com o banco real decidindo quem vence.
   *
   * Sem essa guarda no banco, as duas transações leriam `creditRefundedAt`
   * nulo, as duas compensariam e o usuário terminaria com **dois** créditos de
   * volta por uma cobrança só — dinheiro criado do nada, e o tipo de defeito
   * que nenhum teste sequencial encontra.
   */
  async function compensate(contentId: string, userId: string): Promise<boolean> {
    return prisma.$transaction(async (tx) => {
      const compensated = await contentRepository.failForQueueUnavailable(tx, contentId);

      if (compensated) {
        await userRepository.refundCredit(tx, userId);
      }

      return compensated;
    });
  }

  it('duas compensações concorrentes devolvem no máximo um crédito', async () => {
    for (let round = 0; round < 5; round += 1) {
      const user = await createUser(1);

      // Estado exato deixado por um `POST /generate` cujo `queue.add` falhou:
      // crédito já debitado, conteúdo em PENDING, nada estornado ainda.
      const response = await postGenerate(app, { topic: TOPIC, userId: user.id });
      expect(response.statusCode).toBe(201);
      const contentId = response.json<{ id: string }>().id;
      expect(await creditsOf(user.id), `saldo debitado na rodada ${String(round)}`).toBe(0);

      const results = await Promise.all([
        compensate(contentId, user.id),
        compensate(contentId, user.id),
      ]);

      // Exatamente uma das duas afetou a linha; a outra encontrou
      // `creditRefundedAt` já preenchido e não afetou nada.
      expect(results.filter(Boolean), `vencedores na rodada ${String(round)}`).toHaveLength(1);
      expect(await creditsOf(user.id), `saldo estornado na rodada ${String(round)}`).toBe(1);

      const content = await prisma.content.findUniqueOrThrow({ where: { id: contentId } });
      expect(content.status).toBe(ContentStatus.FAILED);
      expect(content.errorMessage).toBe(CONTENT_FAILURE_CODES.QUEUE_UNAVAILABLE);
      expect(content.creditRefundedAt).not.toBeNull();
    }
  });

  it('compensar um conteúdo que já saiu de PENDING não estorna', async () => {
    const user = await createUser(1);
    const response = await postGenerate(app, { topic: TOPIC, userId: user.id });
    const contentId = response.json<{ id: string }>().id;

    // O Worker pegou o conteúdo antes de a compensação rodar — o job foi
    // publicado e só a resposta se perdeu. Atropelar o processamento em curso
    // seria pior que o 503.
    await contentRepository.claimForProcessing(prisma, contentId);

    expect(await compensate(contentId, user.id)).toBe(false);
    expect(await creditsOf(user.id)).toBe(0);
    expect((await prisma.content.findUniqueOrThrow({ where: { id: contentId } })).status).toBe(
      ContentStatus.PROCESSING,
    );
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
