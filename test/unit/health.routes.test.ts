import Fastify from 'fastify';
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import { describe, expect, it } from 'vitest';

import { healthRoutes } from '../../src/modules/health/health.routes.js';
import { registerErrorHandler } from '../../src/shared/http/error-handler.js';

/**
 * Sondas. O caso que importa é o **banco fora do ar**: readiness precisa
 * responder 503 sem que o processo caia, e liveness precisa continuar 200 —
 * um `/health` que também falhasse faria o orquestrador reiniciar uma API
 * saudável cujo único problema é o banco estar indisponível.
 *
 * A verificação é injetada; derrubar o PostgreSQL para testar isto seria caro e
 * não provaria nada a mais.
 */

async function buildProbeApp(databaseUp: boolean) {
  const app = Fastify({ logger: false }).withTypeProvider<ZodTypeProvider>();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  registerErrorHandler(app);
  await app.register(healthRoutes(async () => databaseUp));
  await app.ready();
  return app;
}

describe('GET /health', () => {
  it('responde 200 mesmo com o banco indisponível', async () => {
    const app = await buildProbeApp(false);

    try {
      const response = await app.inject({ method: 'GET', url: '/health' });

      expect(response.statusCode).toBe(200);
      expect(response.json<{ status: string }>().status).toBe('ok');
    } finally {
      await app.close();
    }
  });
});

describe('GET /ready', () => {
  it('banco disponível → 200 e database "up"', async () => {
    const app = await buildProbeApp(true);

    try {
      const response = await app.inject({ method: 'GET', url: '/ready' });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ status: 'ready', checks: { database: 'up' } });
    } finally {
      await app.close();
    }
  });

  it('banco indisponível → 503 dizendo qual dependência caiu', async () => {
    const app = await buildProbeApp(false);

    try {
      const response = await app.inject({ method: 'GET', url: '/ready' });

      expect(response.statusCode).toBe(503);
      expect(response.json()).toEqual({ status: 'degraded', checks: { database: 'down' } });
    } finally {
      await app.close();
    }
  });
});
