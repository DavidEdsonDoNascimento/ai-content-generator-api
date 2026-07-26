import { afterEach, describe, expect, it } from 'vitest';

import {
  adminDatabaseUrl,
  assertTestDatabaseName,
  resolveTestDatabaseUrl,
} from '../setup/test-database.js';

/**
 * A guarda que separa o banco de testes do banco de trabalho.
 *
 * Testar a própria infraestrutura de testes normalmente é ruído — este caso é a
 * exceção porque a invariante é destrutiva: os testes de integração rodam
 * `TRUNCATE`, e um erro de regex aqui apagaria o banco de desenvolvimento.
 */

const ORIGINAL = {
  DATABASE_URL: process.env['DATABASE_URL'],
  TEST_DATABASE_URL: process.env['TEST_DATABASE_URL'],
};

afterEach(() => {
  for (const [key, value] of Object.entries(ORIGINAL)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
});

describe('assertTestDatabaseName', () => {
  it.each([
    'postgresql://u:p@localhost:5432/ai_content_test',
    'postgresql://u:p@localhost:5432/x_test',
  ])('aceita %s', (url) => {
    expect(assertTestDatabaseName(url)).toMatch(/_test$/);
  });

  it.each([
    ['banco de trabalho', 'postgresql://u:p@localhost:5432/ai_content'],
    ['banco de manutenção', 'postgresql://u:p@localhost:5432/postgres'],
    ['sufixo só parecido', 'postgresql://u:p@localhost:5432/ai_content_testing'],
    ['nome com aspas', 'postgresql://u:p@localhost:5432/a";DROP DATABASE x_test'],
    ['sem banco no caminho', 'postgresql://u:p@localhost:5432/'],
  ])('recusa %s', (_caso, url) => {
    expect(() => assertTestDatabaseName(url)).toThrow(/Recusando operar/);
  });
});

describe('resolveTestDatabaseUrl', () => {
  it('deriva o banco de teste da DATABASE_URL acrescentando o sufixo', () => {
    delete process.env['TEST_DATABASE_URL'];
    process.env['DATABASE_URL'] = 'postgresql://u:p@localhost:5432/ai_content';

    const url = resolveTestDatabaseUrl();

    expect(new URL(url).pathname).toBe('/ai_content_test');
    expect(assertTestDatabaseName(url)).toBe('ai_content_test');
  });

  it('TEST_DATABASE_URL, quando definida, tem precedência', () => {
    process.env['DATABASE_URL'] = 'postgresql://u:p@localhost:5432/ai_content';
    process.env['TEST_DATABASE_URL'] = 'postgresql://u:p@outro:5432/outro_test';

    expect(resolveTestDatabaseUrl()).toBe('postgresql://u:p@outro:5432/outro_test');
  });

  it('sem nenhuma das duas, falha com instrução em vez de adivinhar um destino', () => {
    delete process.env['TEST_DATABASE_URL'];
    delete process.env['DATABASE_URL'];

    expect(() => resolveTestDatabaseUrl()).toThrow(/\.env\.example/);
  });
});

describe('adminDatabaseUrl', () => {
  it('aponta para o banco de manutenção preservando credenciais e host', () => {
    const admin = adminDatabaseUrl('postgresql://u:p@localhost:5432/ai_content_test');

    const url = new URL(admin);
    expect(url.pathname).toBe('/postgres');
    expect(url.host).toBe('localhost:5432');
  });
});
