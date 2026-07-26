import type { InjectOptions, LightMyRequestResponse } from 'fastify';

import { buildApp, type AppInstance } from '../../src/app.js';

/**
 * A aplicação **real** — `buildApp()`, com o mesmo handler de erros, os mesmos
 * compiladores Zod e as mesmas rotas que sobem em produção. Substituir qualquer
 * peça aqui esvaziaria os testes: o que se quer provar inclui a integração entre
 * validação, serialização e tratamento de erro.
 *
 * `app.inject()` em vez de porta aberta: mesma pilha HTTP, sem rede, e sem
 * concorrer por porta com o container que já roda em 3000.
 */
export async function buildTestApp(): Promise<AppInstance> {
  const app = await buildApp();
  await app.ready();
  return app;
}

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
