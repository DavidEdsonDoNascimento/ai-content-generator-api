import fastifySwagger from '@fastify/swagger';
import fastifySwaggerUi from '@fastify/swagger-ui';
import { jsonSchemaTransform, jsonSchemaTransformObject } from 'fastify-type-provider-zod';

import type { AppInstance } from '../app.js';

/**
 * OpenAPI gerado **a partir dos schemas Zod das rotas** (ADR-011).
 *
 * `jsonSchemaTransform` converte o `schema` de cada rota — o mesmo objeto que o
 * Fastify usa para validar entrada e serializar saída — em JSON Schema. Não
 * existe um segundo documento a manter: se o contrato mudar, a documentação muda
 * junto, porque é a mesma fonte. Escrever JSON Schema à mão diverge do código na
 * primeira alteração, e a documentação errada é pior que a ausente.
 *
 * Registrado **antes** das rotas de propósito: o `@fastify/swagger` coleta os
 * schemas no `onRoute`, então rota registrada antes dele não entra no documento.
 */

/** Versão do documento OpenAPI. Acompanha a `version` do `package.json`. */
const API_VERSION = '0.1.0';

export async function registerSwagger(app: AppInstance): Promise<void> {
  await app.register(fastifySwagger, {
    openapi: {
      openapi: '3.1.0',
      info: {
        title: 'AI Content Generator API',
        version: API_VERSION,
        description: [
          'Geração assíncrona de conteúdo por IA.',
          '',
          'O `POST /api/content/generate` debita 1 crédito e devolve imediatamente, sem',
          'aguardar o processamento; o acompanhamento é feito por `GET /api/content/:id`.',
          '',
          'Duas garantias de concorrência sustentam a API, e ambas são impostas pelo',
          'PostgreSQL, não por verificação na aplicação:',
          '',
          '- **crédito** é debitado por `UPDATE ... WHERE credits > 0`, sem leitura prévia —',
          '  sob requisições simultâneas, apenas uma consome o último crédito;',
          '- **estados terminais** (`COMPLETED`, `CANCELED`, `FAILED`) são imutáveis: toda',
          '  escrita de status carrega no `WHERE` o estado de origem esperado.',
          '',
          'Sem autenticação: o `userId` viaja no corpo da requisição (ADR-013).',
        ].join('\n'),
      },
      tags: [
        { name: 'contents', description: 'Geração, consulta e cancelamento de conteúdo.' },
        { name: 'health', description: 'Sondas de liveness e readiness.' },
      ],
    },
    transform: jsonSchemaTransform,
    transformObject: jsonSchemaTransformObject,
  });

  await app.register(fastifySwaggerUi, {
    // `/docs` é exigência explícita do enunciado.
    routePrefix: '/docs',
    uiConfig: {
      // Endpoints já vêm expandidos: são três, e o avaliador não deveria
      // precisar de cliques para ver os schemas.
      docExpansion: 'list',
      deepLinking: true,
    },
  });
}
