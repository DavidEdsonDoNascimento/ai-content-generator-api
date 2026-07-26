import { setTimeout as delay } from 'node:timers/promises';

import { CONTENT_FAILURE_CODES } from '../../modules/contents/content.failure.js';

/**
 * Simulação da IA, exatamente como o enunciado descreve: espera 5 segundos e
 * falha intencionalmente em 20 % das vezes.
 *
 * Duas escolhas de implementação carregam significado:
 *
 * 1. **a espera vem antes do sorteio.** Falhar imediatamente seria mais rápido,
 *    mas apagaria o cenário que o desafio quer ver — o cancelamento chegando
 *    *durante* os cinco segundos. Uma falha instantânea nunca disputaria nada;
 * 2. **delay, taxa e fonte de aleatoriedade são injetáveis.** É o que permite
 *    aos testes forçarem `failureRate = 0` ou `1` e reduzirem o delay, sem tocar
 *    no comportamento de produção — os 20 % continuam sendo o padrão real.
 */

/** Código sanitizado gravado em `Content.errorMessage` (ADR-010). */
export const AI_GENERATION_FAILED = CONTENT_FAILURE_CODES.AI_GENERATION_FAILED;

/**
 * Falha da IA. Existe como classe própria para o processor distinguir "a IA
 * falhou, isso é esperado e retentável" de um defeito de programação, que não
 * deve virar `FAILED` com código de negócio.
 */
export class AiGenerationError extends Error {
  readonly code = AI_GENERATION_FAILED;

  constructor() {
    super('AI generation failed.');
    this.name = 'AiGenerationError';
  }
}

export function isAiGenerationError(error: unknown): error is AiGenerationError {
  return error instanceof AiGenerationError;
}

/** Assinatura que o processor conhece. O `topic` vem do banco, não do job. */
export type GenerateWithAi = (topic: string) => Promise<string>;

export interface AiGeneratorOptions {
  /** Espera antes de decidir o resultado. Produção: 5000. */
  readonly delayMs: number;
  /** Probabilidade de falha, de 0 a 1. Produção: 0.2. */
  readonly failureRate: number;
  /** Fonte de aleatoriedade; substituível para tornar o teste determinístico. */
  readonly random?: () => number;
}

function fictionalText(topic: string): string {
  return [
    `# ${topic}`,
    '',
    `Este texto foi gerado automaticamente sobre "${topic}".`,
    '',
    'A geração é assíncrona: a requisição HTTP retorna imediatamente e o',
    'processamento acontece em background, com retry em caso de falha.',
    '',
    `Gerado em ${new Date().toISOString()}.`,
  ].join('\n');
}

export function createAiGenerator(options: AiGeneratorOptions): GenerateWithAi {
  const random = options.random ?? Math.random;

  return async (topic: string): Promise<string> => {
    await delay(options.delayMs);

    // O sorteio depois da espera: é durante ela que o `/cancel` do usuário
    // compete com o Worker.
    if (random() < options.failureRate) {
      throw new AiGenerationError();
    }

    return fictionalText(topic);
  };
}
