import { z } from 'zod';

import { ContentStatus } from '../../generated/prisma/enums.js';

/**
 * Contrato HTTP do módulo de conteúdo.
 *
 * Estes schemas são a **fonte única**: validam a entrada, serializam a saída e
 * geram o OpenAPI via `jsonSchemaTransform` (ADR-011). Não existe DTO separado —
 * um tipo espelhando o schema seria duplicação garantida a divergir.
 *
 * Consequência prática do `serializerCompiler`: campo que não estiver no schema
 * de resposta **não sai** no corpo. Isso é usado de propósito como filtro —
 * `fileKey`, `creditRefundedAt` e `updatedAt` existem no banco e nunca vazam.
 */

const contentStatusSchema = z.enum(ContentStatus).describe('Estado atual do conteúdo.');

/** UUID do usuário. Sem autenticação, ele vem no corpo (ADR-013). */
const userIdSchema = z.uuid().describe('UUID do usuário que paga o crédito.');

/**
 * `topic`: 3–200 caracteres, trimado (ADR-014). O máximo espelha o
 * `@db.VarChar(200)` do Prisma — desalinhar os dois transformaria erro de
 * validação em erro de banco disfarçado de 500.
 */
export const generateContentBodySchema = z
  .object({
    topic: z
      .string()
      .trim()
      .min(3, 'topic deve ter ao menos 3 caracteres')
      .max(200, 'topic deve ter no máximo 200 caracteres')
      .describe('Assunto do conteúdo a ser gerado.'),
    userId: userIdSchema,
  })
  .describe('Solicitação de geração de conteúdo. Custa 1 crédito do usuário.');

export type GenerateContentBody = z.infer<typeof generateContentBodySchema>;

export const contentIdParamsSchema = z.object({
  id: z.uuid().describe('UUID do conteúdo.'),
});

export type ContentIdParams = z.infer<typeof contentIdParamsSchema>;

/**
 * Resposta do `POST /generate`: enxuta de propósito. O cliente recebe o
 * `contentId` e o status imediatamente, e consulta o resto pelo `GET /:id`.
 */
export const generateContentResponseSchema = z.object({
  id: z.uuid().describe('Identificador do conteúdo criado.'),
  userId: userIdSchema,
  topic: z.string(),
  status: contentStatusSchema,
  createdAt: z.iso.datetime().describe('Instante da criação, em UTC.'),
});

export type GenerateContentResponse = z.infer<typeof generateContentResponseSchema>;

/**
 * Representação pública completa do conteúdo.
 *
 * `fileUrl` só é preenchido em `COMPLETED`; `errorMessage` carrega um código
 * sanitizado (`AI_GENERATION_FAILED`, `UPLOAD_FAILED`, ...), nunca a mensagem
 * original nem stack trace (ADR-010).
 */
export const contentResponseSchema = z.object({
  id: z.uuid(),
  userId: userIdSchema,
  topic: z.string(),
  status: contentStatusSchema,
  fileUrl: z
    .url()
    .nullable()
    .describe('URL pública do .txt no S3. Preenchida apenas quando COMPLETED.'),
  errorMessage: z
    .string()
    .nullable()
    .describe('Código sanitizado do motivo da falha. Nunca contém detalhe interno.'),
  attempts: z.int().nonnegative().describe('Tentativas de processamento já realizadas.'),
  createdAt: z.iso.datetime(),
  completedAt: z.iso.datetime().nullable(),
  canceledAt: z.iso.datetime().nullable(),
});

export type ContentResponse = z.infer<typeof contentResponseSchema>;

/** Resposta do cancelamento: o estado resultante, para o cliente confirmar. */
export const cancelContentResponseSchema = z.object({
  id: z.uuid(),
  status: contentStatusSchema,
  canceledAt: z.iso.datetime().describe('Instante do cancelamento, em UTC.'),
});

export type CancelContentResponse = z.infer<typeof cancelContentResponseSchema>;
