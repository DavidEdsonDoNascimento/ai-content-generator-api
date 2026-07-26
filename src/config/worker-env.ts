import { z } from 'zod';

import { loadEnvOrExit, redisUrlSchema } from './env.js';

/**
 * Ambiente do **Worker**: Redis, IA simulada e S3 — além do base.
 *
 * É o único processo que fala com o storage. A API não declara nada de S3, e o
 * container de migrations não declara nem Redis nem S3 (ADR-029/ADR-030).
 *
 * **Os dois endereços do mesmo Minio não são intercambiáveis** e é por isso que
 * existem como variáveis separadas:
 *
 * - `S3_ENDPOINT` é por onde o Worker fala com o storage. Dentro do Compose é o
 *   host interno da rede (`http://minio:9000`), que **não resolve** fora dela;
 * - `S3_PUBLIC_BASE_URL` é o que vai para o banco, em `Content.fileUrl`, e
 *   precisa abrir no navegador de quem avalia (`http://localhost:9000`).
 *
 * Persistir o endpoint interno como URL pública é o erro clássico desta
 * integração: tudo funciona nos testes de dentro da rede, e o link entregue ao
 * cliente não abre em lugar nenhum (ADR-009).
 */
const httpUrlSchema = z
  .string()
  .min(1)
  .refine((value) => value.startsWith('http://') || value.startsWith('https://'), {
    message: 'deve ser uma URL http:// ou https://',
  });

const workerEnvSchema = z.object({
  REDIS_URL: redisUrlSchema,

  // Simulação da IA. Os padrões são os do enunciado — 5 s de espera e 20 % de
  // falha; os testes reduzem o delay e forçam a taxa para 0 ou 1, o que remove a
  // aleatoriedade sem alterar o comportamento de produção.
  AI_DELAY_MS: z.coerce.number().int().nonnegative().default(5000),
  AI_FAILURE_RATE: z.coerce.number().min(0).max(1).default(0.2),

  /** Endereço **interno**, usado só para falar com o storage. */
  S3_ENDPOINT: httpUrlSchema,
  /** Endereço **externo**, usado para montar a URL persistida em `fileUrl`. */
  S3_PUBLIC_BASE_URL: httpUrlSchema,
  S3_REGION: z.string().min(1).default('us-east-1'),
  S3_BUCKET: z.string().min(1),

  // Credenciais: sem valor padrão e nunca ecoadas. A mensagem de erro cita só o
  // nome da variável.
  S3_ACCESS_KEY_ID: z.string().min(1),
  S3_SECRET_ACCESS_KEY: z.string().min(1),
});

export type WorkerEnv = z.infer<typeof workerEnvSchema>;

/** Chamada pelo composition root do Worker, nunca no import de um módulo. */
export function loadWorkerEnv(): WorkerEnv {
  return loadEnvOrExit(workerEnvSchema);
}
