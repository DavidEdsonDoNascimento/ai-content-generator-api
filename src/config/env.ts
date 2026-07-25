import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import { z } from 'zod';

/**
 * Em desenvolvimento as variáveis vêm de um `.env` local; em container elas
 * chegam pelo ambiente e o arquivo não existe. `process.loadEnvFile` (Node >= 20.12)
 * cobre o primeiro caso sem dependência externa.
 */
const envFilePath = resolve(process.cwd(), '.env');
if (existsSync(envFilePath)) {
  process.loadEnvFile(envFilePath);
}

const envSchema = z.object({
  // Sem valor padrão de propósito: o ambiente de execução é uma escolha
  // explícita, não algo a ser adivinhado no boot.
  NODE_ENV: z.enum(['development', 'test', 'production']),
  HOST: z.string().min(1).default('0.0.0.0'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
});

export type Env = z.infer<typeof envSchema>;

export class EnvValidationError extends Error {
  constructor(issues: readonly string[]) {
    super(
      [
        'Configuração de ambiente inválida:',
        ...issues,
        '',
        'Confira o arquivo .env.example e ajuste o seu .env.',
      ].join('\n'),
    );
    this.name = 'EnvValidationError';
  }
}

/**
 * Valida o ambiente. As mensagens citam apenas o **nome** da variável e o motivo
 * da rejeição — nunca o valor recebido —, para que um segredo malformado não
 * acabe em log ou em saída de terminal.
 */
export function parseEnv(source: NodeJS.ProcessEnv): Env {
  const result = envSchema.safeParse(source);

  if (!result.success) {
    const issues = result.error.issues.map((issue) => {
      const variable = issue.path.join('.') || '(desconhecida)';
      const isMissing = source[variable] === undefined;
      return `  - ${variable}: ${isMissing ? 'variável obrigatória ausente' : issue.message}`;
    });
    throw new EnvValidationError(issues);
  }

  return result.data;
}

function loadEnv(): Env {
  try {
    return parseEnv(process.env);
  } catch (error) {
    if (error instanceof EnvValidationError) {
      // Falha rápida e legível: o processo não deve subir com ambiente inválido.
      process.stderr.write(`${error.message}\n`);
      process.exit(1);
    }
    throw error;
  }
}

export const env: Env = loadEnv();
