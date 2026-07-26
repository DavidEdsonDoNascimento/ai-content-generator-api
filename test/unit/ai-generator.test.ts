import { describe, expect, it } from 'vitest';

import {
  AI_GENERATION_FAILED,
  AiGenerationError,
  createAiGenerator,
  isAiGenerationError,
} from '../../src/worker/ai/generate-content.js';

/**
 * U-04 — simulação da IA.
 *
 * A distribuição dos 20 % **não** é testada: seria testar `Math.random`, e o
 * teste ficaria estatístico e instável. O que importa é o contrato que torna o
 * resto determinístico — taxa 0 sempre sucede, taxa 1 sempre falha, o delay é
 * respeitado, e a espera vem **antes** da decisão.
 */

describe('createAiGenerator', () => {
  it('com failureRate 0 sucede e devolve texto contendo o tópico', async () => {
    const generate = createAiGenerator({ delayMs: 0, failureRate: 0 });

    const text = await generate('Backpressure em filas');

    expect(text).toContain('Backpressure em filas');
    expect(text.length).toBeGreaterThan(0);
  });

  it('com failureRate 1 falha com o erro classificável da IA', async () => {
    const generate = createAiGenerator({ delayMs: 0, failureRate: 1 });

    const error = await generate('Qualquer tópico').catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(AiGenerationError);
    expect(isAiGenerationError(error)).toBe(true);
    expect((error as AiGenerationError).code).toBe(AI_GENERATION_FAILED);
  });

  it('respeita o delay configurado antes de decidir', async () => {
    const generate = createAiGenerator({ delayMs: 60, failureRate: 1 });

    const started = Date.now();
    await generate('Tópico').catch(() => undefined);
    const elapsed = Date.now() - started;

    // A espera acontece mesmo no caminho de falha: é durante ela que o
    // cancelamento do usuário compete com o Worker. Falhar antes de esperar
    // apagaria justamente o cenário que o enunciado cobra.
    expect(elapsed).toBeGreaterThanOrEqual(50);
  });

  it('usa a fonte de aleatoriedade injetada, e o limiar é estrito', async () => {
    const atThreshold = createAiGenerator({ delayMs: 0, failureRate: 0.2, random: () => 0.2 });
    const belowThreshold = createAiGenerator({ delayMs: 0, failureRate: 0.2, random: () => 0.19 });

    // `random() < failureRate`: exatamente no limiar, sucede.
    await expect(atThreshold('Tópico')).resolves.toContain('Tópico');
    await expect(belowThreshold('Tópico')).rejects.toBeInstanceOf(AiGenerationError);
  });
});
