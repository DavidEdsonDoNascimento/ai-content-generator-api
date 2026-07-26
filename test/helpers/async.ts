import { setTimeout as delay } from 'node:timers/promises';

/**
 * Sincronização dos testes assíncronos **sem `sleep` fixo**.
 *
 * Um `sleep` arbitrário é a fonte clássica de teste instável: curto demais falha
 * na máquina lenta, longo demais transforma a suíte em espera. `waitFor` espera
 * pela **condição**, com teto; `deferred` deixa o teste decidir o instante exato
 * em que a IA falsa devolve o controle, o que torna a corrida do cancelamento
 * reproduzível em vez de cronometrada.
 */

export interface WaitForOptions {
  readonly timeoutMs?: number;
  readonly intervalMs?: number;
  /** Aparece na mensagem de erro quando o tempo esgota. */
  readonly description?: string;
}

export async function waitFor(
  predicate: () => Promise<boolean> | boolean,
  options: WaitForOptions = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 10_000;
  const intervalMs = options.intervalMs ?? 20;
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    if (await predicate()) {
      return;
    }

    if (Date.now() >= deadline) {
      throw new Error(
        `Condição não satisfeita em ${String(timeoutMs)} ms: ${options.description ?? 'sem descrição'}`,
      );
    }

    await delay(intervalMs);
  }
}

export interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: Error): void;
}

export function deferred<T = void>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;

  const promise = new Promise<T>((resolveFn, rejectFn) => {
    resolve = resolveFn;
    reject = rejectFn;
  });

  return { promise, resolve, reject };
}
