import type { Content } from '../../generated/prisma/client.js';
import { ContentStatus } from '../../generated/prisma/enums.js';
import type { DbClient } from '../../infra/db/prisma.js';
import { CANCELABLE_STATUSES } from './content.state.js';

/**
 * Acesso ao conteúdo.
 *
 * Regra que vale para todo este arquivo e para as fases seguintes: **nenhuma
 * escrita de status sem predicado do estado de origem.** `updateMany` (ou
 * `updateManyAndReturn`) com verificação de `count` é o mecanismo de exclusão
 * mútua entre API e Worker — nunca `findUnique` seguido de `if` seguido de
 * `update` (ADR-004/ADR-006).
 */

/**
 * Cria o conteúdo em `PENDING`.
 *
 * O `status` vem do default da coluna; passá-lo explicitamente aqui seria
 * duplicar a definição do schema. Chamado dentro da mesma transação do débito,
 * para que "cobrar o crédito" e "registrar o conteúdo" sejam atômicos.
 */
export async function create(
  db: DbClient,
  input: { userId: string; topic: string },
): Promise<Content> {
  return db.content.create({
    data: { userId: input.userId, topic: input.topic },
  });
}

export async function findById(db: DbClient, id: string): Promise<Content | null> {
  return db.content.findUnique({ where: { id } });
}

/**
 * Cancela o conteúdo **se, e somente se,** ele ainda estiver em `PENDING` ou
 * `PROCESSING`.
 *
 * O predicado é o espelho exato das escritas do Worker: como `CANCELED`,
 * `COMPLETED` e `FAILED` não pertencem ao conjunto, é fisicamente impossível
 * este `UPDATE` sobrescrever um estado terminal — a garantia está no `WHERE`
 * avaliado pelo PostgreSQL sob lock de linha, não em uma checagem prévia.
 *
 * `updateManyAndReturn` mantém o `UPDATE` condicional e ainda devolve a linha
 * (`RETURNING`), o que evita uma releitura só para saber o `canceledAt` gravado.
 *
 * @returns O conteúdo já cancelado, ou `null` quando nenhuma linha satisfez o
 * predicado — id inexistente **ou** estado terminal. O service diferencia os
 * dois, apenas neste caminho.
 */
export async function cancelIfCancelable(db: DbClient, id: string): Promise<Content | null> {
  const canceled = await db.content.updateManyAndReturn({
    where: { id, status: { in: [...CANCELABLE_STATUSES] } },
    data: { status: ContentStatus.CANCELED, canceledAt: new Date() },
  });

  return canceled[0] ?? null;
}
