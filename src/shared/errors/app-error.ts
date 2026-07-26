/**
 * Erro de domínio: uma falha **esperada** de regra de negócio, com resposta HTTP
 * já decidida na origem.
 *
 * A distinção que importa para o handler global (`shared/http/error-handler.ts`):
 * um `AppError` é seguro para o cliente — `code` e `message` foram escritos por
 * nós, para serem lidos. Qualquer outro erro é tratado como desconhecido e vira
 * um `500` genérico, porque a mensagem dele pode carregar caminho de arquivo,
 * host do banco ou detalhe de biblioteca (RNF-05 / ADR-010).
 */
export class AppError extends Error {
  readonly statusCode: number;
  readonly code: string;

  constructor(code: string, message: string, statusCode: number) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

/** Narrowing sem `instanceof` frágil entre múltiplas cópias do módulo. */
export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError;
}
