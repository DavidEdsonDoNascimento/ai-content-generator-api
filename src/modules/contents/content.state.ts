import { ContentStatus } from '../../generated/prisma/enums.js';
import {
  ContentNotCancelableError,
  ERROR_CODES,
  type ErrorCode,
} from '../../shared/errors/domain-errors.js';

/**
 * Máquina de estados do conteúdo — **pura**, sem Prisma e sem HTTP.
 *
 * Este módulo descreve a máquina de estados; ele **não** a impõe. A imposição
 * real está no `WHERE` de cada `updateMany` do repositório, avaliado
 * atomicamente pelo PostgreSQL (ADR-004/ADR-006). Um `if` na aplicação nunca
 * fecha a janela entre a leitura e a escrita — por isso o que está aqui serve
 * para decidir *qual erro devolver* depois que o banco já respondeu `count = 0`,
 * e para ser testado isoladamente.
 */

/** Estados imutáveis: nenhuma transição sai deles (RN-07). */
export const TERMINAL_STATUSES = [
  ContentStatus.COMPLETED,
  ContentStatus.CANCELED,
  ContentStatus.FAILED,
] as const;

export type TerminalStatus = (typeof TERMINAL_STATUSES)[number];

/**
 * Estados a partir dos quais o cancelamento é possível. É exatamente o conjunto
 * usado no predicado do `UPDATE` de cancelamento — manter os dois em sincronia é
 * o motivo de a lista viver aqui, e não solta no repositório.
 */
export const CANCELABLE_STATUSES = [ContentStatus.PENDING, ContentStatus.PROCESSING] as const;

export type CancelableStatus = (typeof CANCELABLE_STATUSES)[number];

/**
 * Estados a partir dos quais o Worker pode assumir o conteúdo: `PENDING` na
 * primeira execução e `PROCESSING` no retry — entre as tentativas o conteúdo
 * permanece em `PROCESSING`, porque voltar para `PENDING` seria transição
 * proibida (ADR-005).
 *
 * Hoje o conjunto **coincide** com `CANCELABLE_STATUSES`, e é justamente por
 * isso que ele existe separado: "de onde se pode cancelar" e "de onde o Worker
 * pode assumir" são duas políticas independentes que por ora dão no mesmo. Com
 * uma constante só, acrescentar um estado cancelável-mas-não-assumível mudaria
 * o predicado do claim em silêncio, sem ninguém tocar no Worker.
 */
export const CLAIMABLE_STATUSES = [ContentStatus.PENDING, ContentStatus.PROCESSING] as const;

export type ClaimableStatus = (typeof CLAIMABLE_STATUSES)[number];

/** Transições permitidas, na forma origem → destinos possíveis (0002 §7). */
const ALLOWED_TRANSITIONS: Readonly<Record<ContentStatus, readonly ContentStatus[]>> = {
  [ContentStatus.PENDING]: [ContentStatus.PROCESSING, ContentStatus.CANCELED],
  [ContentStatus.PROCESSING]: [
    ContentStatus.COMPLETED,
    ContentStatus.FAILED,
    ContentStatus.CANCELED,
    // Retry: o conteúdo permanece em PROCESSING entre as tentativas, só
    // incrementando `attempts` (ADR-005).
    ContentStatus.PROCESSING,
  ],
  [ContentStatus.COMPLETED]: [],
  [ContentStatus.CANCELED]: [],
  [ContentStatus.FAILED]: [],
};

export function isTerminal(status: ContentStatus): status is TerminalStatus {
  return TERMINAL_STATUSES.some((terminal) => terminal === status);
}

export function canCancel(status: ContentStatus): status is CancelableStatus {
  return CANCELABLE_STATUSES.some((cancelable) => cancelable === status);
}

export function canTransition(from: ContentStatus, to: ContentStatus): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}

/** Terminal → código de erro específico, para o `409` de `/cancel` (ADR-004). */
const TERMINAL_ERROR: Readonly<Record<TerminalStatus, ErrorCode>> = {
  [ContentStatus.COMPLETED]: ERROR_CODES.CONTENT_ALREADY_COMPLETED,
  [ContentStatus.CANCELED]: ERROR_CODES.CONTENT_ALREADY_CANCELED,
  [ContentStatus.FAILED]: ERROR_CODES.CONTENT_ALREADY_FAILED,
};

const TERMINAL_MESSAGE: Readonly<Record<TerminalStatus, string>> = {
  [ContentStatus.COMPLETED]: 'Content has already been completed and cannot be canceled.',
  [ContentStatus.CANCELED]: 'Content has already been canceled.',
  [ContentStatus.FAILED]: 'Content has already failed and cannot be canceled.',
};

/**
 * Traduz o estado encontrado no erro de cancelamento correspondente.
 *
 * Só é chamado quando o `updateMany` condicional já retornou `count = 0` e a
 * releitura mostrou um estado não cancelável — ou seja, no caminho de erro, com
 * o banco já tendo dado a palavra final.
 */
export function cancelRejectionFor(status: ContentStatus): ContentNotCancelableError {
  if (!isTerminal(status)) {
    // Inalcançável pela máquina de estados atual: os cinco estados são
    // exatamente CANCELABLE ∪ TERMINAL. Existe para que um estado novo no enum
    // falhe de forma explícita, em vez de virar um 409 com código errado.
    throw new Error(`Estado não cancelável e não terminal: ${status}`);
  }

  return new ContentNotCancelableError(TERMINAL_ERROR[status], TERMINAL_MESSAGE[status]);
}
