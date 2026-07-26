/**
 * Catálogo fechado dos motivos de falha gravados em `Content.errorMessage`.
 *
 * São **códigos sanitizados**, nunca mensagem de biblioteca (ADR-010): o cliente
 * lê o que aconteceu sem ler *como*, e o detalhe original — stack, endpoint,
 * host, credencial — fica só no log estruturado. Mantê-los num único lugar é o
 * que permite documentá-los e mantê-los estáveis para quem consome a API.
 */
export const CONTENT_FAILURE_CODES = {
  /** A IA simulada falhou em todas as tentativas. */
  AI_GENERATION_FAILED: 'AI_GENERATION_FAILED',
  /** O upload do `.txt` para o S3 falhou em todas as tentativas. */
  UPLOAD_FAILED: 'UPLOAD_FAILED',
  /** O job nunca chegou a ser publicado; o crédito foi estornado (ADR-008). */
  QUEUE_UNAVAILABLE: 'QUEUE_UNAVAILABLE',
} as const;

export type ContentFailureCode = (typeof CONTENT_FAILURE_CODES)[keyof typeof CONTENT_FAILURE_CODES];
