import { describe, expect, it } from 'vitest';

import { ContentStatus } from '../../src/generated/prisma/enums.js';
import {
  CANCELABLE_STATUSES,
  cancelRejectionFor,
  canCancel,
  canTransition,
  CLAIMABLE_STATUSES,
  isTerminal,
  TERMINAL_STATUSES,
} from '../../src/modules/contents/content.state.js';
import { ERROR_CODES } from '../../src/shared/errors/domain-errors.js';

/**
 * U-01 / U-02 / U-03 — máquina de estados.
 *
 * A invariante protegida aqui é a regra eliminatória do desafio: **estado
 * terminal é imutável**. Quem a impõe em produção é o `WHERE` de cada
 * `updateMany`; este arquivo trava a *descrição* da máquina, para que uma
 * alteração descuidada (incluir `CANCELED` entre os canceláveis, abrir uma
 * transição saindo de `COMPLETED`) quebre o teste antes de virar um `WHERE`
 * permissivo no repositório.
 */

const ALL_STATUSES = [
  ContentStatus.PENDING,
  ContentStatus.PROCESSING,
  ContentStatus.COMPLETED,
  ContentStatus.CANCELED,
  ContentStatus.FAILED,
] as const;

describe('conjuntos de estados', () => {
  it('cobre os cinco estados sem sobreposição entre canceláveis e terminais', () => {
    const cancelable = new Set<string>(CANCELABLE_STATUSES);
    const terminal = new Set<string>(TERMINAL_STATUSES);

    expect([...cancelable].filter((status) => terminal.has(status))).toEqual([]);
    expect(new Set([...cancelable, ...terminal])).toEqual(new Set(ALL_STATUSES));
  });

  it('o claim do Worker parte de PENDING ou PROCESSING, e de nenhum terminal', () => {
    // Fixado literalmente, e não derivado de `CANCELABLE_STATUSES`: derivar de
    // outro conjunto é exatamente o acoplamento que esta constante existe para
    // desfazer. Se um estado terminal entrar aqui, o Worker passa a poder
    // ressuscitar conteúdo concluído ou cancelado — e este teste cai primeiro.
    expect([...CLAIMABLE_STATUSES]).toEqual([ContentStatus.PENDING, ContentStatus.PROCESSING]);
    expect([...CLAIMABLE_STATUSES].filter(isTerminal)).toEqual([]);
  });
});

describe('isTerminal', () => {
  it.each([
    [ContentStatus.PENDING, false],
    [ContentStatus.PROCESSING, false],
    [ContentStatus.COMPLETED, true],
    [ContentStatus.CANCELED, true],
    [ContentStatus.FAILED, true],
  ])('%s → %s', (status, expected) => {
    expect(isTerminal(status)).toBe(expected);
  });
});

describe('canCancel', () => {
  it.each([
    [ContentStatus.PENDING, true],
    [ContentStatus.PROCESSING, true],
    [ContentStatus.COMPLETED, false],
    [ContentStatus.CANCELED, false],
    [ContentStatus.FAILED, false],
  ])('%s → %s', (status, expected) => {
    expect(canCancel(status)).toBe(expected);
  });
});

describe('canTransition', () => {
  /** Tabela completa origem → destinos permitidos (0002 §7). */
  const ALLOWED: Readonly<Record<ContentStatus, readonly ContentStatus[]>> = {
    [ContentStatus.PENDING]: [ContentStatus.PROCESSING, ContentStatus.CANCELED],
    // PROCESSING → PROCESSING é o retry: entre tentativas o conteúdo permanece
    // no mesmo estado, só `attempts` avança (ADR-005).
    [ContentStatus.PROCESSING]: [
      ContentStatus.PROCESSING,
      ContentStatus.COMPLETED,
      ContentStatus.CANCELED,
      ContentStatus.FAILED,
    ],
    [ContentStatus.COMPLETED]: [],
    [ContentStatus.CANCELED]: [],
    [ContentStatus.FAILED]: [],
  };

  it.each(ALL_STATUSES.flatMap((from) => ALL_STATUSES.map((to) => [from, to] as const)))(
    '%s → %s',
    (from, to) => {
      expect(canTransition(from, to)).toBe(ALLOWED[from].includes(to));
    },
  );

  it('não permite nenhuma transição saindo de estado terminal', () => {
    for (const from of TERMINAL_STATUSES) {
      for (const to of ALL_STATUSES) {
        expect(canTransition(from, to)).toBe(false);
      }
    }
  });
});

describe('cancelRejectionFor', () => {
  it.each([
    [ContentStatus.COMPLETED, ERROR_CODES.CONTENT_ALREADY_COMPLETED],
    [ContentStatus.CANCELED, ERROR_CODES.CONTENT_ALREADY_CANCELED],
    [ContentStatus.FAILED, ERROR_CODES.CONTENT_ALREADY_FAILED],
  ])('%s → 409 %s', (status, code) => {
    const error = cancelRejectionFor(status);

    expect(error.statusCode).toBe(409);
    expect(error.code).toBe(code);
    expect(error.message).not.toBe('');
  });

  it('falha alto para estado não terminal, em vez de devolver um 409 errado', () => {
    expect(() => cancelRejectionFor(ContentStatus.PENDING)).toThrow(/não cancelável/i);
  });
});
