import type { Content } from '../../generated/prisma/client.js';
import type {
  CancelContentResponse,
  ContentResponse,
  GenerateContentResponse,
} from './content.schemas.js';

/**
 * Registro do banco → representação pública.
 *
 * O `serializerCompiler` do Zod já descartaria campo fora do schema, mas a
 * filtragem explícita aqui é deliberada: a decisão sobre o que é público fica
 * visível no código, e não como efeito colateral de uma biblioteca. `fileKey`,
 * `creditRefundedAt` e `updatedAt` são internos e não saem por nenhum caminho.
 */

export function toContentResponse(content: Content): ContentResponse {
  return {
    id: content.id,
    userId: content.userId,
    topic: content.topic,
    status: content.status,
    // `fileUrl` só existe em COMPLETED; nos demais estados o contrato é `null`,
    // nunca campo ausente — o cliente não precisa distinguir os dois casos.
    fileUrl: content.fileUrl,
    // Código sanitizado (ADR-010), jamais a mensagem original do erro.
    errorMessage: content.errorMessage,
    attempts: content.attempts,
    createdAt: content.createdAt.toISOString(),
    completedAt: content.completedAt?.toISOString() ?? null,
    canceledAt: content.canceledAt?.toISOString() ?? null,
  };
}

export function toGenerateContentResponse(content: Content): GenerateContentResponse {
  return {
    id: content.id,
    userId: content.userId,
    topic: content.topic,
    status: content.status,
    createdAt: content.createdAt.toISOString(),
  };
}

export function toCancelContentResponse(
  content: Content & { canceledAt: Date },
): CancelContentResponse {
  return {
    id: content.id,
    status: content.status,
    canceledAt: content.canceledAt.toISOString(),
  };
}
