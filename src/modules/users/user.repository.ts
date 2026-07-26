import type { DbClient } from '../../infra/db/prisma.js';

/**
 * Acesso ao usuário. Expõe **operações condicionais**, não getters e setters:
 * quem decide se o débito pode acontecer é o PostgreSQL, dentro do próprio
 * `UPDATE`, e não um `if` na aplicação.
 */

/**
 * Debita 1 crédito **se, e somente se,** houver saldo — em uma única instrução.
 *
 * Esta é a operação mais importante do projeto (RN-01/RN-02, ADR-001). Não
 * existe leitura antes da escrita: a implementação ingênua
 * (`findUnique` → `if (credits > 0)` → `update`) deixa uma janela em que duas
 * requisições simultâneas leem `credits = 1`, ambas passam no `if` e o saldo
 * termina negativo.
 *
 * Com o predicado dentro do `UPDATE`, o PostgreSQL serializa o acesso à linha:
 * a segunda transação bloqueia no lock e, ao obtê-lo, **reavalia** `credits > 0`
 * contra a versão já atualizada (`credits = 0`), não afetando linha alguma. O
 * `count` é a resposta autoritativa — e vale para N réplicas da API, sem
 * coordenação externa.
 *
 * @returns `true` se o crédito foi debitado; `false` se não havia saldo **ou** o
 * usuário não existe. Distinguir os dois casos exige uma consulta extra e é
 * responsabilidade do service, apenas no caminho de erro.
 */
export async function debitCredit(db: DbClient, userId: string): Promise<boolean> {
  const { count } = await db.user.updateMany({
    where: { id: userId, credits: { gt: 0 } },
    data: { credits: { decrement: 1 } },
  });

  return count === 1;
}

/**
 * Existência do usuário. Usada **somente** quando `debitCredit` devolveu
 * `false`, para separar `404 USER_NOT_FOUND` de `402 INSUFFICIENT_CREDITS`
 * (ADR-002). Fora do caminho quente, por construção.
 */
export async function exists(db: DbClient, userId: string): Promise<boolean> {
  const user = await db.user.findUnique({
    where: { id: userId },
    select: { id: true },
  });

  return user !== null;
}
