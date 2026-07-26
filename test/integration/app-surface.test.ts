import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildApp, type AppInstance } from '../../src/app.js';

/**
 * I-14 e superfície pública da aplicação montada de verdade.
 *
 * Diferente de `error-handler.test.ts`, que monta um Fastify mínimo para isolar
 * o handler, aqui o alvo é a aplicação inteira: `buildApp()` com Swagger, sondas
 * e rotas de conteúdo registrados na ordem real. É o teste que pegaria uma
 * regressão de montagem — rota registrada antes do Swagger, por exemplo, some do
 * OpenAPI sem que nenhum teste de unidade perceba.
 */

let app: AppInstance;

const SECRET = 'postgresql://ai_content:senha-secreta@postgres:5432/ai_content';

beforeAll(async () => {
  app = await buildApp();

  // Rota só deste teste, registrada antes do `ready()`: o handler global precisa
  // de um erro inesperado de verdade para ser exercido ponta a ponta. `hide`
  // mantém a asserção do documento OpenAPI honesta — ela continua listando
  // exatamente as rotas da aplicação.
  app.get('/__boom', { schema: { hide: true } }, async () => {
    throw new Error(`falha ao conectar em ${SECRET}`);
  });

  await app.ready();
});

afterAll(async () => {
  await app.close();
});

describe('sondas', () => {
  it('GET /health responde 200 sem tocar o banco', async () => {
    const response = await app.inject({ method: 'GET', url: '/health' });

    expect(response.statusCode).toBe(200);
    expect(response.json<{ status: string }>().status).toBe('ok');
  });

  it('GET /ready confirma o PostgreSQL com SELECT 1', async () => {
    const response = await app.inject({ method: 'GET', url: '/ready' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ready', checks: { database: 'up' } });
  });
});

describe('OpenAPI em /docs', () => {
  it('documenta os três endpoints do enunciado mais as sondas', async () => {
    const response = await app.inject({ method: 'GET', url: '/docs/json' });

    expect(response.statusCode).toBe(200);

    const document = response.json<{ paths: Record<string, Record<string, unknown>> }>();

    expect(Object.keys(document.paths).sort()).toEqual([
      '/api/content/generate',
      '/api/content/{id}',
      '/api/content/{id}/cancel',
      '/health',
      '/ready',
    ]);
  });

  it('gera os schemas a partir do Zod, e não de JSON Schema escrito à mão', async () => {
    const response = await app.inject({ method: 'GET', url: '/docs/json' });
    const document = response.json<{
      paths: {
        '/api/content/generate': {
          post: {
            requestBody: {
              content: { 'application/json': { schema: { properties: Record<string, unknown> } } };
            };
            responses: Record<string, unknown>;
          };
        };
      };
    }>();

    const generate = document.paths['/api/content/generate'].post;
    const bodySchema = generate.requestBody.content['application/json'].schema;

    // Os campos vêm do `generateContentBodySchema`: se o schema Zod mudar, o
    // documento muda junto, porque é a mesma fonte (ADR-011).
    expect(Object.keys(bodySchema.properties).sort()).toEqual(['topic', 'userId']);
    // Os códigos de erro do catálogo estão documentados, não só o caminho feliz.
    expect(Object.keys(generate.responses).sort()).toEqual(['201', '400', '402', '404', '500']);
  });

  it('serve a UI do Swagger em /docs', async () => {
    const response = await app.inject({ method: 'GET', url: '/docs' });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/html');
  });
});

describe('I-14 — erro inesperado', () => {
  it('responde 500 genérico e não vaza a mensagem original nem o stack', async () => {
    const response = await app.inject({ method: 'GET', url: '/__boom' });

    expect(response.statusCode).toBe(500);

    const body = response.json<{ error: Record<string, unknown> }>();
    expect(Object.keys(body.error).sort()).toEqual(['code', 'message', 'requestId']);
    expect(body.error['code']).toBe('INTERNAL_ERROR');
    expect(body.error['message']).toBe('Internal server error.');

    const raw = response.body;
    expect(raw).not.toContain('senha-secreta');
    expect(raw).not.toContain(SECRET);
    expect(raw).not.toContain('postgresql://');
    expect(raw).not.toContain('.ts:');
    expect(raw).not.toMatch(/\bat\s+\w+/);
  });
});
