import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  hasZodFastifySchemaValidationErrors,
  isResponseSerializationError,
} from 'fastify-type-provider-zod';
import { z } from 'zod';

/**
 * Formato único de erro da API. Todas as respostas de erro — de validação a 500 —
 * saem com esta forma, e o mesmo schema alimentará o OpenAPI na Fase 4.
 */
export const errorResponseSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    requestId: z.string(),
    issues: z.array(z.object({ field: z.string(), message: z.string() })).optional(),
  }),
});

export type ErrorResponse = z.infer<typeof errorResponseSchema>;

function buildErrorResponse(code: string, message: string, requestId: string): ErrorResponse {
  return { error: { code, message, requestId } };
}

/**
 * Handler global de erros e de rota inexistente.
 *
 * Regra inegociável (RNF-05): **nada** de stack trace, mensagem crua de biblioteca
 * ou detalhe de infraestrutura no corpo de um 500. O erro completo vai só para o
 * log estruturado, correlacionado pelo `requestId` devolvido ao cliente.
 *
 * O catálogo de erros de domínio (`AppError`) entra na Fase 4; aqui ficam apenas
 * os três caminhos que já existem: validação, serialização e erro inesperado.
 */
export function registerErrorHandler(app: FastifyInstance): void {
  app.setNotFoundHandler((request: FastifyRequest, reply: FastifyReply) => {
    void reply
      .status(404)
      .send(buildErrorResponse('ROUTE_NOT_FOUND', 'Route not found.', request.id));
  });

  app.setErrorHandler((error: FastifyError, request: FastifyRequest, reply: FastifyReply) => {
    // Body/params/query fora do schema Zod da rota.
    if (hasZodFastifySchemaValidationErrors(error)) {
      request.log.warn({ err: error }, 'request validation failed');

      // `instancePath` vem no formato JSON Pointer (`/topic`); o cliente lê melhor
      // `topic`. Caminho vazio significa que o erro é do corpo como um todo.
      const issues = error.validation.map((issue) => ({
        field: issue.instancePath.replace(/^\//, '').replace(/\//g, '.') || '(root)',
        message: issue.message ?? 'Invalid value.',
      }));

      void reply.status(400).send({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Request validation failed.',
          requestId: request.id,
          issues,
        },
      } satisfies ErrorResponse);
      return;
    }

    // Resposta que não bate com o schema declarado é bug nosso, não erro do cliente.
    if (isResponseSerializationError(error)) {
      request.log.error({ err: error }, 'response serialization failed');
      void reply
        .status(500)
        .send(buildErrorResponse('INTERNAL_ERROR', 'Internal server error.', request.id));
      return;
    }

    const statusCode = error.statusCode ?? 500;

    if (statusCode >= 500) {
      request.log.error({ err: error }, 'unhandled error');
      void reply
        .status(500)
        .send(buildErrorResponse('INTERNAL_ERROR', 'Internal server error.', request.id));
      return;
    }

    // 4xx gerado pelo próprio Fastify (JSON malformado, content-type inválido, ...):
    // código e mensagem são da biblioteca e descrevem o erro do cliente.
    request.log.warn({ err: error }, 'client error');
    void reply
      .status(statusCode)
      .send(buildErrorResponse(error.code ?? 'BAD_REQUEST', error.message, request.id));
  });
}
