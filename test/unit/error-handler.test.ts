import Fastify from 'fastify';
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { AppError } from '../../src/shared/errors/app-error.js';
import { InsufficientCreditsError } from '../../src/shared/errors/domain-errors.js';
import { registerErrorHandler } from '../../src/shared/http/error-handler.js';

/**
 * U-05 / U-06 / U-07 — handler global de erros.
 *
 * U-06 é o teste que o enunciado cobra nominalmente ("evite vazar stack traces
 * do Node para o usuário em erros HTTP 500"): a asserção não é só o código de
 * status, é a **ausência** do segredo, do caminho de arquivo e do stack no corpo
 * da resposta.
 *
 * Monta um Fastify próprio, com os mesmos compiladores do `app.ts`, em vez de
 * usar `buildApp()`: o alvo é o handler, e um banco no caminho só adicionaria
 * uma razão de falhar que não tem nada a ver com o que se quer provar.
 */

/** Frases que jamais podem aparecer numa resposta de erro. */
const SECRET_MESSAGE = 'conexão postgresql://ai_content:senha-secreta@postgres:5432 recusada';

const app = Fastify({ logger: false }).withTypeProvider<ZodTypeProvider>();

beforeAll(async () => {
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  registerErrorHandler(app);

  app.get('/boom', async () => {
    throw new Error(SECRET_MESSAGE);
  });

  app.get('/domain', async () => {
    throw new InsufficientCreditsError();
  });

  app.get('/custom', async () => {
    throw new AppError('TEAPOT', 'I am a teapot.', 418);
  });

  app.post(
    '/validated',
    { schema: { body: z.object({ topic: z.string().min(3), userId: z.uuid() }) } },
    async () => ({ ok: true }),
  );

  app.get(
    '/bad-response',
    { schema: { response: { 200: z.object({ id: z.uuid() }) } } },
    // Resposta que não bate com o schema declarado: bug nosso, não erro do cliente.
    async () => ({ id: 'não é um uuid' }),
  );

  await app.ready();
});

afterAll(async () => {
  await app.close();
});

describe('erro desconhecido', () => {
  it('vira 500 genérico e não vaza stack, mensagem original nem caminho de arquivo', async () => {
    const response = await app.inject({ method: 'GET', url: '/boom' });

    expect(response.statusCode).toBe(500);

    const body = response.json<{ error: Record<string, unknown> }>();

    // Nenhum campo além destes três: um `details`, `stack` ou `cause` que
    // aparecesse aqui seria vazamento, e a asserção de chaves é o que pega isso.
    expect(Object.keys(body.error).sort()).toEqual(['code', 'message', 'requestId']);
    expect(body.error['code']).toBe('INTERNAL_ERROR');
    expect(body.error['message']).toBe('Internal server error.');
    expect(typeof body.error['requestId']).toBe('string');

    const raw = response.body;
    expect(raw).not.toContain('senha-secreta');
    expect(raw).not.toContain(SECRET_MESSAGE);
    expect(raw).not.toContain('stack');
    expect(raw).not.toContain('.ts:');
    expect(raw).not.toContain('node_modules');
    // Linha de stack trace (`at Object.<anonymous>`).
    expect(raw).not.toMatch(/\bat\s+\w+/);
  });
});

describe('erro de domínio', () => {
  it('preserva statusCode e code do catálogo', async () => {
    const response = await app.inject({ method: 'GET', url: '/domain' });

    expect(response.statusCode).toBe(402);
    expect(response.json<{ error: { code: string; message: string } }>().error).toMatchObject({
      code: 'INSUFFICIENT_CREDITS',
      message: 'User has no credits available.',
    });
  });

  it('vale para qualquer AppError, não só para os do catálogo', async () => {
    const response = await app.inject({ method: 'GET', url: '/custom' });

    expect(response.statusCode).toBe(418);
    expect(response.json<{ error: { code: string } }>().error.code).toBe('TEAPOT');
  });
});

describe('erro de validação', () => {
  it('vira 400 com o campo e o motivo de cada issue', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/validated',
      payload: { topic: 'ab', userId: 'nao-uuid' },
    });

    expect(response.statusCode).toBe(400);

    const body = response.json<{
      error: { code: string; issues?: { field: string; message: string }[] };
    }>();

    expect(body.error.code).toBe('VALIDATION_ERROR');
    expect(body.error.issues).toBeDefined();
    // `instancePath` (`/topic`) é traduzido para o nome que o cliente enviou.
    expect(body.error.issues?.map((issue) => issue.field)).toContain('topic');
  });
});

describe('erro de serialização da resposta', () => {
  it('vira 500 genérico, sem expor o schema violado', async () => {
    const response = await app.inject({ method: 'GET', url: '/bad-response' });

    expect(response.statusCode).toBe(500);
    expect(response.json<{ error: { code: string } }>().error.code).toBe('INTERNAL_ERROR');
    expect(response.body).not.toContain('uuid');
  });
});

describe('rota inexistente', () => {
  it('responde 404 no mesmo envelope de erro', async () => {
    const response = await app.inject({ method: 'GET', url: '/rota-que-nao-existe' });

    expect(response.statusCode).toBe(404);
    expect(response.json<{ error: { code: string } }>().error.code).toBe('ROUTE_NOT_FOUND');
  });
});
