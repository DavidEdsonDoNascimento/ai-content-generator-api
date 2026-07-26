import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { promisify } from 'node:util';

import { PrismaPg } from '@prisma/adapter-pg';

import { PrismaClient } from '../../src/generated/prisma/client.js';
import {
  adminDatabaseUrl,
  assertTestDatabaseName,
  resolveTestDatabaseUrl,
} from './test-database.js';

/**
 * Preparo do banco de integração, executado **uma vez** antes da suíte.
 *
 * Cria o banco `*_test` se ele não existir e aplica as migrations com o mesmo
 * `prisma migrate deploy` que o serviço `migrate` do Compose usa em produção —
 * assim o schema testado é o schema entregue, e não um `db push` que aceitaria
 * divergências que a migration real rejeitaria.
 */

const execFileAsync = promisify(execFile);

/** Caminho do CLI do Prisma resolvido pelo próprio Node, sem depender de PATH. */
function prismaCliPath(): string {
  return createRequire(import.meta.url).resolve('prisma/build/index.js');
}

async function createDatabaseIfMissing(testUrl: string): Promise<void> {
  const database = assertTestDatabaseName(testUrl);

  // Conexão no banco de manutenção: `CREATE DATABASE` não pode rodar de dentro
  // do banco que está sendo criado.
  const admin = new PrismaClient({
    adapter: new PrismaPg({ connectionString: adminDatabaseUrl(testUrl) }),
    log: ['warn', 'error'],
  });

  try {
    const existing = await admin.$queryRaw<
      { datname: string }[]
    >`SELECT datname FROM pg_database WHERE datname = ${database}`;

    if (existing.length === 0) {
      // PostgreSQL não aceita parâmetro em `CREATE DATABASE`, então o nome é
      // interpolado — e é exatamente por isso que `assertTestDatabaseName` roda
      // antes: só passa `[a-z][a-z0-9_]*_test`.
      await admin.$executeRawUnsafe(`CREATE DATABASE "${database}"`);
    }
  } finally {
    await admin.$disconnect();
  }
}

export default async function setup(): Promise<void> {
  const testUrl = resolveTestDatabaseUrl();
  assertTestDatabaseName(testUrl);

  await createDatabaseIfMissing(testUrl);

  await execFileAsync(process.execPath, [prismaCliPath(), 'migrate', 'deploy'], {
    env: { ...process.env, DATABASE_URL: testUrl },
  });
}
