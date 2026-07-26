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
 * Monta a aplicação sem abrir porta — o `listen` fica em `main.ts`. Assim os
 * testes podem usar `app.inject()` sem subir um servidor de verdade.
 */
export async function buildApp(): Promise<AppInstance> {
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
  await app.register(contentRoutes());

  return app;
}
