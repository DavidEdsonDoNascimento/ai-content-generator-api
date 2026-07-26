import { afterAll, beforeEach } from 'vitest';

import { disconnectPrisma, prisma } from '../../src/infra/db/prisma.js';
import { assertTestDatabaseName } from './test-database.js';

/**
 * Isolamento entre testes de integração.
 *
 * `TRUNCATE` — e não transação com rollback: os testes de concorrência precisam
 * que as escritas realmente comitem, em conexões distintas, senão não existe
 * corrida nenhuma para observar (0005 §5). `CASCADE` cobre a FK de `contents`
 * para `users`.
 *
 * A guarda roda **a cada limpeza**, contra a URL efetiva do processo: quem
 * decide onde este comando cai é a variável de ambiente, então validar só uma
 * vez na configuração seria validar a intenção, não o alvo.
 */
beforeEach(async () => {
  const databaseUrl = process.env['DATABASE_URL'];

  if (databaseUrl === undefined || databaseUrl === '') {
    throw new Error('DATABASE_URL ausente no ambiente de teste.');
  }

  assertTestDatabaseName(databaseUrl);

  await prisma.$executeRawUnsafe('TRUNCATE TABLE "contents", "users" RESTART IDENTITY CASCADE');
});

// Sem isto o pool segura o processo e o Vitest não encerra.
afterAll(async () => {
  await disconnectPrisma();
});
