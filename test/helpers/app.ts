import type { InjectOptions, LightMyRequestResponse } from 'fastify';

import { buildApp, type AppInstance } from '../../src/app.js';
import { prisma } from '../../src/infra/db/prisma.js';
import type { ContentQueuePublisher } from '../../src/infra/queue/content-queue.js';
import { buildContentService } from '../../src/modules/contents/content.service.js';
import { createRecordingQueue } from './fake-queue.js';

/**
 * A aplicação **real** — `buildApp()`, com o mesmo handler de erros, os mesmos
 * compiladores Zod e as mesmas rotas que sobem em produção. Substituir qualquer
 * peça aqui esvaziaria os testes: o que se quer provar inclui a integração entre
 * validação, serialização e tratamento de erro.
 *
 * A única peça injetada é a fila, porque a Fase 5 tornou o `ContentService`
 * dependente dela. Por padrão entra o duplo que registra publicações: mantém
 * Redis-free os testes cuja invariante é do PostgreSQL. Quem precisa da fila de
 * verdade passa a sua.
 *
 * `app.inject()` em vez de porta aberta: mesma pilha HTTP, sem rede, e sem
 * concorrer por porta com o container que já roda em 3000.
 */
export interface TestAppOptions {
  readonly queue?: ContentQueuePublisher;
}

export async function buildTestApp(options: TestAppOptions = {}): Promise<AppInstance> {
  const contentService = buildContentService({
    db: prisma,
    transaction: (fn) => prisma.$transaction(fn),
    queue: options.queue ?? createRecordingQueue(),
    logger: silentLogger,
  });

  return buildApp({ contentService });
}

/** O service loga avisos de operação best-effort; no teste isso é só ruído. */
const silentLogger = {
  warn: (): void => undefined,
  error: (): void => undefined,
};

/** `await` explícito: sem ele o tipo encadeável do `inject` não colapsa em Promise. */
async function request(app: AppInstance, options: InjectOptions): Promise<LightMyRequestResponse> {
  return await app.inject(options);
}

export async function postGenerate(
  app: AppInstance,
  body: Record<string, unknown>,
): Promise<LightMyRequestResponse> {
  return request(app, { method: 'POST', url: '/api/content/generate', payload: body });
}

export async function getContent(app: AppInstance, id: string): Promise<LightMyRequestResponse> {
  return request(app, { method: 'GET', url: `/api/content/${id}` });
}

export async function postCancel(app: AppInstance, id: string): Promise<LightMyRequestResponse> {
  return request(app, { method: 'POST', url: `/api/content/${id}/cancel` });
}
