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

  // Contém senha: a mensagem de erro abaixo é estática de propósito, para que
  // um valor malformado nunca seja ecoado em log ou terminal.
  DATABASE_URL: z
    .string()
    .min(1)
    .refine((value) => value.startsWith('postgresql://') || value.startsWith('postgres://'), {
      message: 'deve ser uma URL PostgreSQL (postgresql:// ou postgres://)',
    }),

  // Conexão com o Redis. Obrigatória a partir da Fase 5: a API publica o job e o
  // Worker o consome — sem ela, `POST /generate` não teria como cumprir o
  // contrato. Pode conter senha, então a mensagem também é estática.
  REDIS_URL: z
    .string()
    .min(1)
    .refine((value) => value.startsWith('redis://') || value.startsWith('rediss://'), {
      message: 'deve ser uma URL Redis (redis:// ou rediss://)',
    }),

  // Simulação da IA. Os padrões são os do enunciado — 5 s de espera e 20 % de
  // falha; os testes reduzem o delay e forçam a taxa para 0 ou 1, o que remove a
  // aleatoriedade sem alterar o comportamento de produção.
  AI_DELAY_MS: z.coerce.number().int().nonnegative().default(5000),
  AI_FAILURE_RATE: z.coerce.number().min(0).max(1).default(0.2),

  // Tentativas por job no BullMQ, contando a primeira (ADR-005).
  JOB_ATTEMPTS: z.coerce.number().int().min(1).default(3),
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
