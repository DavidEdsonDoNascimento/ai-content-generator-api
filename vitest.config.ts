import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import { defineConfig } from 'vitest/config';

import { resolveTestDatabaseUrl } from './test/setup/test-database.js';

/**
 * Dois projetos com naturezas diferentes (0005 §2):
 *
 * - **unit** — lógica pura e HTTP com `app.inject()`. Sem banco, sem I/O.
 * - **integration** — PostgreSQL **real**. As garantias deste projeto são
 *   garantias do banco (`UPDATE` condicional, lock de linha, atomicidade);
 *   testá-las com Prisma mockado testaria o mock, não a garantia.
 */

const envFilePath = resolve(import.meta.dirname, '.env');
if (existsSync(envFilePath)) {
  process.loadEnvFile(envFilePath);
}

/**
 * URL inofensiva para os unitários. `src/config/env.ts` exige `DATABASE_URL` no
 * import, e vários módulos alcançam o client Prisma pela cadeia de imports — mas
 * instanciar o client **não** abre conexão (pool lazy), então nada aqui toca a
 * rede. Um valor obviamente falso torna explícito que um unitário que tentar
 * consultar o banco vai falhar, em vez de silenciosamente usar o banco de dev.
 */
const UNIT_DATABASE_URL = 'postgresql://unit:unit@127.0.0.1:1/unit_tests_never_connect';

const SHARED_ENV = { NODE_ENV: 'test', LOG_LEVEL: 'silent' } as const;

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          include: ['test/unit/**/*.test.ts'],
          environment: 'node',
          env: { ...SHARED_ENV, DATABASE_URL: UNIT_DATABASE_URL },
        },
      },
      {
        test: {
          name: 'integration',
          include: ['test/integration/**/*.test.ts'],
          environment: 'node',
          env: { ...SHARED_ENV, DATABASE_URL: resolveTestDatabaseUrl() },
          globalSetup: ['test/setup/global-setup.ts'],
          setupFiles: ['test/setup/reset-database.ts'],
          // Um banco, um `TRUNCATE` por teste: arquivos em paralelo limpariam a
          // mesa uns dos outros. Serialização aqui é correção, não cautela.
          fileParallelism: false,
          // A prova de corrida roda 10 rodadas de duas requisições concorrentes.
          testTimeout: 30_000,
        },
      },
    ],
  },
});
