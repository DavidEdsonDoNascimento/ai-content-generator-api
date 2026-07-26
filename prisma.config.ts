import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import { defineConfig } from 'prisma/config';

/**
 * Configuração da CLI do Prisma (migrations, seed, generate).
 *
 * A aplicação valida o ambiente em `src/config/env.ts`; aqui o carregamento é
 * intencionalmente mais simples, porque a CLI roda em contextos onde nem todas
 * as variáveis da API fazem sentido (por exemplo, `prisma generate` no build da
 * imagem Docker, onde não existe banco algum).
 */
const envFilePath = resolve(process.cwd(), '.env');
if (existsSync(envFilePath)) {
  process.loadEnvFile(envFilePath);
}

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
    seed: 'tsx prisma/seed.ts',
  },
  datasource: {
    // Sem fallback silencioso: um valor ausente faz os comandos que precisam de
    // banco falharem com "Connection url is empty", e não contra um host errado.
    // `generate` não usa a URL e continua funcionando sem ela.
    url: process.env['DATABASE_URL'] ?? '',
  },
});
