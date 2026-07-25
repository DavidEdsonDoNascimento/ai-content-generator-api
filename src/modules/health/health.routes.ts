import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';

/**
 * Resposta do health check. Nesta fase o endpoint prova apenas que o processo
 * HTTP está de pé — não há PostgreSQL, Redis nem S3 para verificar ainda. As
 * checagens de dependência entram junto com cada integração.
 */
const healthResponseSchema = z.object({
  status: z.literal('ok'),
  uptime: z.number().nonnegative().describe('Segundos desde o start do processo.'),
  timestamp: z.iso.datetime().describe('Instante da resposta, em UTC.'),
});

export const healthRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get(
    '/health',
    {
      schema: {
        summary: 'Health check do processo HTTP',
        tags: ['health'],
        response: {
          200: healthResponseSchema,
        },
      },
    },
    async () => ({
      status: 'ok' as const,
      uptime: Math.round(process.uptime() * 1000) / 1000,
      timestamp: new Date().toISOString(),
    }),
  );
};
