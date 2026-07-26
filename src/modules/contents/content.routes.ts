import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';

import { errorResponseSchema } from '../../shared/http/error-handler.js';
import {
  cancelContentResponseSchema,
  contentIdParamsSchema,
  contentResponseSchema,
  generateContentBodySchema,
  generateContentResponseSchema,
} from './content.schemas.js';
import type { ContentService } from './content.service.js';

/**
 * Rotas de conteúdo.
 *
 * Cada handler faz exatamente duas coisas: chamar o service e escolher o status
 * de sucesso. Nenhuma regra de negócio aqui — é exigência explícita do enunciado
 * ("não escreva regras de negócio complexas soltas no arquivo de rotas"), e os
 * erros de domínio viram resposta HTTP no handler global, não em `try/catch`
 * repetido rota a rota.
 *
 * O `schema` de cada rota é o mesmo objeto que gera o OpenAPI — a documentação
 * não pode divergir do que é validado porque é a mesma fonte.
 */
export function contentRoutes(service: ContentService): FastifyPluginAsyncZod {
  return async (app) => {
    app.post(
      '/api/content/generate',
      {
        schema: {
          summary: 'Solicita a geração de um conteúdo',
          description:
            'Debita 1 crédito do usuário, cria o conteúdo em PENDING e publica o job ' +
            'de processamento. O débito é um UPDATE condicional atômico: sob ' +
            'concorrência, apenas uma requisição consome o último crédito. Retorna ' +
            'imediatamente, sem aguardar a IA — acompanhe por GET /api/content/{id}.',
          tags: ['contents'],
          body: generateContentBodySchema,
          response: {
            201: generateContentResponseSchema.describe('Conteúdo criado e enfileirado.'),
            400: errorResponseSchema.describe('Body fora do schema.'),
            402: errorResponseSchema.describe('Usuário existe, mas está sem créditos.'),
            404: errorResponseSchema.describe('userId não corresponde a nenhum usuário.'),
            500: errorResponseSchema.describe('Erro interno.'),
            503: errorResponseSchema.describe(
              'QUEUE_UNAVAILABLE — o conteúdo foi criado, mas o job não pôde ser ' +
                'publicado. A compensação já rodou: o conteúdo fica FAILED e o crédito ' +
                'é devolvido. A requisição pode ser repetida.',
            ),
          },
        },
      },
      async (request, reply) => {
        const content = await service.generate(request.body);
        return reply.status(201).send(content);
      },
    );

    app.get(
      '/api/content/:id',
      {
        schema: {
          summary: 'Consulta um conteúdo',
          description:
            'Retorna os dados originais, o status atual e — quando COMPLETED — a URL ' +
            'pública do arquivo no S3.',
          tags: ['contents'],
          params: contentIdParamsSchema,
          response: {
            200: contentResponseSchema,
            400: errorResponseSchema.describe('id não é um UUID.'),
            404: errorResponseSchema.describe('Conteúdo inexistente.'),
            500: errorResponseSchema.describe('Erro interno.'),
          },
        },
      },
      async (request) => service.getById(request.params.id),
    );

    app.post(
      '/api/content/:id/cancel',
      {
        schema: {
          summary: 'Cancela a geração de um conteúdo',
          description:
            'Move o conteúdo para CANCELED se ele ainda estiver em PENDING ou ' +
            'PROCESSING. Estados terminais são imutáveis: cancelar um conteúdo já ' +
            'concluído, cancelado ou falho responde 409. O crédito não é devolvido ' +
            '(ADR-003).',
          tags: ['contents'],
          params: contentIdParamsSchema,
          response: {
            200: cancelContentResponseSchema.describe('Conteúdo cancelado.'),
            400: errorResponseSchema.describe('id não é um UUID.'),
            404: errorResponseSchema.describe('Conteúdo inexistente.'),
            409: errorResponseSchema.describe(
              'Conteúdo em estado terminal: CONTENT_ALREADY_COMPLETED, ' +
                'CONTENT_ALREADY_CANCELED ou CONTENT_ALREADY_FAILED.',
            ),
            500: errorResponseSchema.describe('Erro interno.'),
          },
        },
      },
      async (request) => service.cancel(request.params.id),
    );
  };
}
