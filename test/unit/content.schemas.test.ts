import { describe, expect, it } from 'vitest';

import {
  contentIdParamsSchema,
  generateContentBodySchema,
} from '../../src/modules/contents/content.schemas.js';

/**
 * U-10 — fronteiras do contrato de entrada.
 *
 * Só as bordas que têm consequência: o `max(200)` espelha o `@db.VarChar(200)`
 * do Prisma, e desalinhar os dois transformaria um erro de validação (400,
 * culpa do cliente) num erro de banco disfarçado de 500. O `trim` importa pelo
 * mesmo motivo — `"   "` precisa ser rejeitado como vazio, não gravado como
 * tópico.
 */

describe('generateContentBodySchema', () => {
  const userId = '00000000-0000-4000-8000-000000000001';

  it('aceita um corpo válido e devolve o topic trimado', () => {
    const result = generateContentBodySchema.parse({ topic: '  Filas no Node  ', userId });

    expect(result).toEqual({ topic: 'Filas no Node', userId });
  });

  it('rejeita topic com menos de 3 caracteres', () => {
    expect(generateContentBodySchema.safeParse({ topic: 'ab', userId }).success).toBe(false);
  });

  it('rejeita topic só com espaços, porque o trim vem antes do min', () => {
    expect(generateContentBodySchema.safeParse({ topic: '      ', userId }).success).toBe(false);
  });

  it('aceita topic com exatamente 200 caracteres e rejeita com 201', () => {
    expect(generateContentBodySchema.safeParse({ topic: 'a'.repeat(200), userId }).success).toBe(
      true,
    );
    expect(generateContentBodySchema.safeParse({ topic: 'a'.repeat(201), userId }).success).toBe(
      false,
    );
  });

  it('rejeita userId que não é UUID', () => {
    const result = generateContentBodySchema.safeParse({ topic: 'Tópico válido', userId: '42' });

    expect(result.success).toBe(false);
  });

  it('rejeita corpo sem os campos obrigatórios', () => {
    expect(generateContentBodySchema.safeParse({}).success).toBe(false);
    expect(generateContentBodySchema.safeParse({ topic: 'Tópico válido' }).success).toBe(false);
  });
});

describe('contentIdParamsSchema', () => {
  it('aceita UUID e rejeita qualquer outra coisa', () => {
    expect(
      contentIdParamsSchema.safeParse({ id: '11111111-1111-4111-8111-111111111111' }).success,
    ).toBe(true);
    expect(contentIdParamsSchema.safeParse({ id: 'nao-e-uuid' }).success).toBe(false);
  });
});
