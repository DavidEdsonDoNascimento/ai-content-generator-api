import { z } from 'zod';

import { loadEnvOrExit, redisUrlSchema } from './env.js';

/**
 * Ambiente da **API**: o que o processo HTTP consome, além do base.
 *
 * A API publica jobs, então precisa do Redis. Ela **não** faz upload, e por isso
 * não declara nada de S3 — exigir credenciais de storage de um processo que
 * nunca as usa é o hábito que a ADR-018 proíbe, e que a ADR-030 fecha em
 * definitivo com a divisão por processo.
 */
const apiEnvSchema = z.object({
  REDIS_URL: redisUrlSchema,

  /** Tentativas por job no BullMQ, contando a primeira (ADR-005). */
  JOB_ATTEMPTS: z.coerce.number().int().min(1).default(3),
});

export type ApiEnv = z.infer<typeof apiEnvSchema>;

/** Chamada pelo composition root da API, nunca no import de um módulo. */
export function loadApiEnv(): ApiEnv {
  return loadEnvOrExit(apiEnvSchema);
}
