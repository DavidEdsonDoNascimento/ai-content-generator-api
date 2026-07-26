import { Redis } from 'ioredis';
import { afterAll, beforeEach } from 'vitest';

import { disconnectPrisma, prisma } from '../../src/infra/db/prisma.js';
import { assertTestDatabaseName } from './test-database.js';
import { assertTestRedisDatabase } from './test-redis.js';

/**
 * Isolamento entre testes de integração.
 *
 * `TRUNCATE` — e não transação com rollback: os testes de concorrência precisam
 * que as escritas realmente comitem, em conexões distintas, senão não existe
 * corrida nenhuma para observar (0005 §5). `CASCADE` cobre a FK de `contents`
 * para `users`. Do lado do Redis, `FLUSHDB` limpa jobs que tenham sobrado de um
 * caso anterior e poderiam ser consumidos pelo Worker do caso seguinte.
 *
 * As duas guardas rodam **a cada limpeza**, contra as URLs efetivas do processo:
 * quem decide onde estes comandos caem é a variável de ambiente, então validar
 * só uma vez na configuração seria validar a intenção, não o alvo.
 */

let redis: Redis | undefined;

function testRedis(): Redis {
  const redisUrl = process.env['REDIS_URL'];

  if (redisUrl === undefined || redisUrl === '') {
    throw new Error('REDIS_URL ausente no ambiente de teste.');
  }

  assertTestRedisDatabase(redisUrl);

  redis ??= new Redis(redisUrl, { maxRetriesPerRequest: 2, lazyConnect: true });
  return redis;
}

beforeEach(async () => {
  const databaseUrl = process.env['DATABASE_URL'];

  if (databaseUrl === undefined || databaseUrl === '') {
    throw new Error('DATABASE_URL ausente no ambiente de teste.');
  }

  assertTestDatabaseName(databaseUrl);

  await prisma.$executeRawUnsafe('TRUNCATE TABLE "contents", "users" RESTART IDENTITY CASCADE');
  await testRedis().flushdb();
});

// Sem isto o pool e o socket seguram o processo e o Vitest não encerra.
afterAll(async () => {
  await disconnectPrisma();

  if (redis !== undefined) {
    await redis.quit();
    redis = undefined;
  }
});
