import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import { defineConfig } from 'vitest/config';

/**
 * Configuração **exclusiva** do E2E opt-in.
 *
 * Arquivo separado, e não mais um `project` dentro de `vitest.config.ts`, por um
 * motivo prático: `npm test` roda todos os projects daquele arquivo. Enquanto o
 * E2E morar aqui, é **impossível** que ele entre no caminho rápido por descuido
 * — nem em `npm test`, nem em `npm run validate`. A separação é a garantia; um
 * filtro por nome de project seria só uma convenção.
 *
 * Diferenças de fundo para a suíte de integração:
 *
 * - **não** há `globalSetup` nem `setupFiles`. O E2E fala com o banco de
 *   **trabalho** (`ai_content`), o mesmo que a API do Compose usa, e por isso
 *   nada de `TRUNCATE` ou `FLUSHDB` pode chegar perto dele. A limpeza é
 *   cirúrgica: só as linhas que o próprio teste criou;
 * - as variáveis vêm do `.env` do host, sem sobrescrita de `DATABASE_URL` ou
 *   `REDIS_URL` — o alvo é a stack de verdade, não um ambiente de teste.
 */

const envFilePath = resolve(import.meta.dirname, '.env');
if (existsSync(envFilePath)) {
  process.loadEnvFile(envFilePath);
}

export default defineConfig({
  test: {
    name: 'e2e',
    include: ['test/e2e/**/*.e2e.test.ts'],
    environment: 'node',
    env: {
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
    },
    // Um conteúdo por vez contra uma stack compartilhada; paralelismo aqui só
    // criaria disputa por um recurso que não é do teste.
    fileParallelism: false,
    // O ciclo passa por fila, IA simulada e upload real. O teto é folgado de
    // propósito: quem sincroniza é o polling, não o timeout.
    testTimeout: 90_000,
    hookTimeout: 60_000,
  },
});
