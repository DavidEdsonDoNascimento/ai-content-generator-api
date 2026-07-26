import { AppError } from './app-error.js';

/**
 * Catálogo fechado de erros de domínio (docs/0003_Implementation_Plan.md, Fase 4).
 *
 * Manter os códigos em um único lugar é o que permite documentá-los no Swagger e
 * mantê-los estáveis para o cliente (ADR-010). `VALIDATION_ERROR` e
 * `INTERNAL_ERROR` não aparecem aqui porque nascem no handler global, não em
 * regra de negócio.
 */
export const ERROR_CODES = {
  USER_NOT_FOUND: 'USER_NOT_FOUND',
  INSUFFICIENT_CREDITS: 'INSUFFICIENT_CREDITS',
  CONTENT_NOT_FOUND: 'CONTENT_NOT_FOUND',
  CONTENT_ALREADY_COMPLETED: 'CONTENT_ALREADY_COMPLETED',
  CONTENT_ALREADY_CANCELED: 'CONTENT_ALREADY_CANCELED',
  CONTENT_ALREADY_FAILED: 'CONTENT_ALREADY_FAILED',
  QUEUE_UNAVAILABLE: 'QUEUE_UNAVAILABLE',
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

/** `userId` informado em `/generate` não existe na tabela de usuários. */
export class UserNotFoundError extends AppError {
  constructor() {
    super(ERROR_CODES.USER_NOT_FOUND, 'User not found.', 404);
  }
}

/**
 * Usuário existe, mas está sem saldo. `402` em vez de `409` por ser exatamente a
 * semântica do caso: requisição válida, recurso existente, falta crédito (ADR-002).
 */
export class InsufficientCreditsError extends AppError {
  constructor() {
    super(ERROR_CODES.INSUFFICIENT_CREDITS, 'User has no credits available.', 402);
  }
}

export class ContentNotFoundError extends AppError {
  constructor() {
    super(ERROR_CODES.CONTENT_NOT_FOUND, 'Content not found.', 404);
  }
}

/**
 * Cancelamento recusado porque o conteúdo já está num estado terminal.
 *
 * Responder `409` (e não `200` idempotente) é decisão explícita da ADR-004: o
 * cliente fica sabendo que nada mudou, em vez de receber um sucesso que mascara
 * erro de fluxo. O código diz **qual** terminal bloqueou.
 */
export class ContentNotCancelableError extends AppError {
  constructor(code: ErrorCode, message: string) {
    super(code, message, 409);
  }
}

/**
 * O conteúdo foi criado e o crédito debitado, mas o job não pôde ser publicado.
 *
 * `503` e não `500` porque a causa é uma dependência indisponível, não um defeito
 * do código: a requisição é legítima e vale a pena repetir. Quando este erro sai,
 * a compensação já rodou — o conteúdo está `FAILED` e o crédito voltou (ADR-008).
 * A mensagem é escrita para o cliente; o erro cru do Redis fica só no log.
 */
export class QueueUnavailableError extends AppError {
  constructor() {
    super(
      ERROR_CODES.QUEUE_UNAVAILABLE,
      'Content generation is temporarily unavailable. The credit was refunded; please try again.',
      503,
    );
  }
}
