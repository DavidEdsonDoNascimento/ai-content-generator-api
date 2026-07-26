import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';

import { pingDatabase } from '../../infra/db/prisma.js';

/**
 * Sondas do processo. **Liveness e readiness respondem perguntas diferentes** e
 * por isso são rotas separadas:
 *
 * - `/health` (liveness): "o processo está vivo?" Não toca em dependência
 *   alguma. Um liveness que consulta o banco derruba a API quando o banco cai —
 *   o orquestrador reinicia um processo saudável e o problema só piora.
 * - `/ready` (readiness): "dá para mandar tráfego?" Agora que **todas** as rotas
 *   de conteúdo dependem do PostgreSQL, uma API sem banco não tem o que
 *   responder, e essa é exatamente a condição que tira uma réplica do
 *   balanceador sem reiniciá-la.
 */

const healthResponseSchema = z.object({
  status: z.literal('ok'),
  uptime: z.number().nonnegative().describe('Segundos desde o start do processo.'),
  timestamp: z.iso.datetime().describe('Instante da resposta, em UTC.'),
});

const dependencyStatusSchema = z.enum(['up', 'down']);

const readyResponseSchema = z.object({
  status: z.literal('ready'),
  checks: z.object({ database: dependencyStatusSchema }),
});

const notReadyResponseSchema = z.object({
  status: z.literal('degraded'),
  checks: z.object({ database: dependencyStatusSchema }),
});

/**
 * `checkDatabase` é injetável para que o caminho de indisponibilidade seja
 * testável sem derrubar o PostgreSQL. O padrão é a verificação real.
 */
export function healthRoutes(
  checkDatabase: () => Promise<boolean> = pingDatabase,
): FastifyPluginAsyncZod {
  return async (app) => {
    app.get(
      '/health',
      {
        schema: {
          summary: 'Liveness do processo HTTP',
          description:
            'Prova apenas que o processo responde. Não consulta banco nem qualquer ' +
            'outra dependência, de propósito: é a sonda usada para decidir reinício.',
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

    app.get(
      '/ready',
      {
        schema: {
          summary: 'Readiness das dependências',
          description:
            'Verifica a conexão com o PostgreSQL (`SELECT 1`). Responde 503 quando o ' +
            'banco não responde — a API está viva, mas não tem como atender as rotas ' +
            'de conteúdo.',
          tags: ['health'],
          response: {
            200: readyResponseSchema.describe('Dependências disponíveis.'),
            503: notReadyResponseSchema.describe('Alguma dependência indisponível.'),
          },
        },
      },
      async (_request, reply) => {
        const databaseUp = await checkDatabase();

        // Envelope próprio, e não o de erro da API: readiness é um relatório de
        // estado para o orquestrador, não uma falha de requisição do cliente —
        // e dizer *qual* dependência caiu é a única informação útil aqui.
        if (!databaseUp) {
          return reply.status(503).send({
            status: 'degraded' as const,
            checks: { database: 'down' as const },
          });
        }

        return reply.status(200).send({
          status: 'ready' as const,
          checks: { database: 'up' as const },
        });
      },
    );
  };
}
