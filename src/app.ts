import { randomUUID } from 'node:crypto';

import Fastify, {
  type FastifyBaseLogger,
  type FastifyInstance,
  type RawReplyDefaultExpression,
  type RawRequestDefaultExpression,
  type RawServerDefault,
} from 'fastify';
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';

import { loggerOptions } from './config/logger.js';
import { contentRoutes } from './modules/contents/content.routes.js';
import type { ContentService } from './modules/contents/content.service.js';
import { healthRoutes } from './modules/health/health.routes.js';
import { registerSwagger } from './plugins/swagger.js';
import { registerErrorHandler } from './shared/http/error-handler.js';

/** Instância do Fastify com os schemas Zod como fonte de tipos das rotas. */
export type AppInstance = FastifyInstance<
  RawServerDefault,
  RawRequestDefaultExpression,
  RawReplyDefaultExpression,
  FastifyBaseLogger,
  ZodTypeProvider
>;

/**
 * Dependências montadas fora daqui.
 *
 * `buildApp` deixou de construir o `ContentService` sozinho na Fase 5: o service
 * passou a depender da fila, e a fila abre conexão com o Redis. Se a construção
 * acontecesse no import ou dentro do `buildApp`, subir a aplicação — ou importar
 * o módulo num teste — passaria a exigir Redis de pé. Com a montagem explícita,
 * quem decide o ciclo de vida das conexões é o *composition root*: `main.ts` em
 * produção, o helper de teste na suíte.
 */
export interface AppDeps {
  readonly contentService: ContentService;
}

/**
 * Monta a aplicação sem abrir porta — o `listen` fica em `main.ts`. Assim os
 * testes podem usar `app.inject()` sem subir um servidor de verdade.
 */
export async function buildApp(deps: AppDeps): Promise<AppInstance> {
  const app = Fastify({
    logger: loggerOptions,
    requestIdHeader: 'x-request-id',
    genReqId: () => randomUUID(),
  }).withTypeProvider<ZodTypeProvider>();

  // Zod passa a ser a fonte única de validação (entrada) e serialização (saída).
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  registerErrorHandler(app);

  // Antes das rotas: o `@fastify/swagger` coleta os schemas no hook `onRoute`, e
  // rota registrada antes dele ficaria fora do documento OpenAPI.
  await registerSwagger(app);

  await app.register(healthRoutes());
  await app.register(contentRoutes(deps.contentService));

  return app;
}
