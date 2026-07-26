import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import { z } from 'zod';

/**
 * Ambiente **base**: o que todo processo do repositório precisa, e nada além.
 *
 * A partir da Fase 6 a configuração é dividida por processo. O motivo é
 * concreto, não estético: um schema único cresce com a união de tudo que
 * *algum* processo usa, e como os módulos se alcançam por cadeia de imports,
 * processos que não usam uma integração passam a ser obrigados a declará-la. Foi
 * exatamente o que quebrou o `docker compose up` na Fase 5 — o container de
 * migrations parou de subir por causa de uma `REDIS_URL` que ele nunca leria
 * (ADR-029) — e as credenciais de S3 repetiriam o problema com juros.
 *
 * A divisão fica assim:
 *
 * | Processo | Valida |
 * |---|---|
 * | base (Prisma, logger) | `NODE_ENV`, `HOST`, `PORT`, `LOG_LEVEL`, `DATABASE_URL` |
 * | API (`api-env.ts`) | base + `REDIS_URL` + `JOB_ATTEMPTS` |
 * | Worker (`worker-env.ts`) | base + `REDIS_URL` + IA + S3 |
 * | seed / migrator | só `DATABASE_URL`, lido direto |
 *
 * Nenhum schema tem valor padrão para endereço ou credencial: uma configuração
 * ausente **falha no boot** em vez de cair silenciosamente em `localhost`.
 */

/**
 * Em desenvolvimento as variáveis vêm de um `.env` local; em container elas
 * chegam pelo ambiente e o arquivo não existe. `process.loadEnvFile` (Node >= 20.12)
 * cobre o primeiro caso sem dependência externa — e **não** sobrescreve variável
 * já definida, o que deixa o ambiente real sempre com a última palavra.
 */
const envFilePath = resolve(process.cwd(), '.env');
if (existsSync(envFilePath)) {
  process.loadEnvFile(envFilePath);
}

const baseEnvSchema = z.object({
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
});

export type Env = z.infer<typeof baseEnvSchema>;

/**
 * Conexão com o Redis. Compartilhada por API (publica o job) e Worker (consome),
 * e por isso definida aqui em vez de duplicada nos dois schemas. Pode conter
 * senha, então a mensagem também é estática.
 */
export const redisUrlSchema = z
  .string()
  .min(1)
  .refine((value) => value.startsWith('redis://') || value.startsWith('rediss://'), {
    message: 'deve ser uma URL Redis (redis:// ou rediss://)',
  });

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
 * Valida um schema contra o ambiente. As mensagens citam apenas o **nome** da
 * variável e o motivo da rejeição — nunca o valor recebido —, para que um
 * segredo malformado não acabe em log ou em saída de terminal.
 */
export function parseEnvWith<T extends z.ZodType>(
  schema: T,
  source: NodeJS.ProcessEnv,
): z.infer<T> {
  const result = schema.safeParse(source);

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

/** Compatibilidade com o schema base. */
export function parseEnv(source: NodeJS.ProcessEnv): Env {
  return parseEnvWith(baseEnvSchema, source);
}

/**
 * Carrega e valida, encerrando o processo com mensagem legível se algo faltar.
 * Falhar rápido no boot é preferível a descobrir a configuração errada na
 * primeira requisição.
 */
export function loadEnvOrExit<T extends z.ZodType>(schema: T): z.infer<T> {
  try {
    return parseEnvWith(schema, process.env);
  } catch (error) {
    if (error instanceof EnvValidationError) {
      process.stderr.write(`${error.message}\n`);
      process.exit(1);
    }
    throw error;
  }
}

/**
 * Ambiente base, carregado no import porque `prisma.ts` e `logger.ts` precisam
 * dele em qualquer processo. Os schemas por processo são carregados **sob
 * demanda**, pelo composition root — assim importar um módulo num teste
 * unitário não obriga a declarar credenciais de S3.
 */
export const env: Env = loadEnvOrExit(baseEnvSchema);
