import type { Content } from '../../generated/prisma/client.js';
import { ContentStatus } from '../../generated/prisma/enums.js';
import type { DbClient } from '../../infra/db/prisma.js';
import { CONTENT_FAILURE_CODES } from './content.failure.js';
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

/**
 * Compensação de `QUEUE_UNAVAILABLE`: marca o conteúdo como falho **e** libera o
 * estorno, numa única instrução condicional (ADR-008).
 *
 * O predicado carrega as duas guardas que importam:
 *
 * - `status: PENDING` — o conteúdo acabou de ser criado e nada mais aconteceu
 *   com ele. Se um Worker já o pegou (job publicado, resposta perdida no
 *   caminho), a compensação não deve atropelar o processamento;
 * - `creditRefundedAt: null` — **esta é a idempotência**. Uma segunda chamada
 *   encontra o campo preenchido, não afeta linha alguma, e o `count = 0` impede
 *   o segundo estorno.
 *
 * @returns `true` quando a linha foi compensada agora — e **somente** nesse caso
 * o crédito deve ser devolvido.
 */
export async function failForQueueUnavailable(db: DbClient, id: string): Promise<boolean> {
  const { count } = await db.content.updateMany({
    where: { id, status: ContentStatus.PENDING, creditRefundedAt: null },
    data: {
      status: ContentStatus.FAILED,
      // Código sanitizado, nunca a mensagem do Redis (ADR-010).
      errorMessage: CONTENT_FAILURE_CODES.QUEUE_UNAVAILABLE,
      creditRefundedAt: new Date(),
    },
  });

  return count === 1;
}

/**
 * Claim do Worker: assume o conteúdo para processamento e conta a tentativa.
 *
 * Aceita `PENDING` (primeira execução) **e** `PROCESSING` (retry), porque entre
 * as tentativas o conteúdo permanece em `PROCESSING` — voltar para `PENDING`
 * seria uma transição que a máquina de estados proíbe (ADR-005). `CANCELED`,
 * `COMPLETED` e `FAILED` estão fora do conjunto: o claim simplesmente não os
 * encontra, e o `count = 0` diz ao Worker que outro ator já decidiu o destino.
 *
 * O incremento de `attempts` vive **dentro** do mesmo `UPDATE` de propósito: uma
 * escrita separada poderia contar uma tentativa que nunca começou.
 */
export async function claimForProcessing(db: DbClient, id: string): Promise<boolean> {
  const { count } = await db.content.updateMany({
    where: { id, status: { in: [...CANCELABLE_STATUSES] } },
    data: { status: ContentStatus.PROCESSING, attempts: { increment: 1 } },
  });

  return count === 1;
}

/**
 * Finalização com sucesso. **Esta é a garantia** contra o Worker ressuscitar um
 * conteúdo cancelado (ADR-006): o `WHERE status = PROCESSING` é avaliado
 * atomicamente, então um `CANCELED` gravado durante os 5 s da IA ou durante o
 * upload faz este `UPDATE` não encontrar linha nenhuma.
 *
 * `status`, `fileKey`, `fileUrl` e `completedAt` são gravados **na mesma
 * instrução**, de propósito. Marcar `COMPLETED` primeiro e preencher a URL
 * depois abriria uma janela em que o cliente veria um conteúdo concluído sem
 * arquivo — e uma consulta nesse instante devolveria `fileUrl: null` para algo
 * que o contrato promete preenchido.
 */
export async function completeIfProcessing(
  db: DbClient,
  id: string,
  file: { fileKey: string; fileUrl: string },
): Promise<boolean> {
  const { count } = await db.content.updateMany({
    where: { id, status: ContentStatus.PROCESSING },
    data: {
      status: ContentStatus.COMPLETED,
      fileKey: file.fileKey,
      fileUrl: file.fileUrl,
      completedAt: new Date(),
      // Limpa o motivo de uma falha anterior que acabou sendo superada no retry.
      errorMessage: null,
    },
  });

  return count === 1;
}

/**
 * Falha definitiva, gravada **apenas** quando as tentativas se esgotaram
 * (ADR-005) e ainda assim de forma condicional: se o usuário cancelou no meio,
 * o predicado não casa e o `CANCELED` sobrevive.
 *
 * `errorCode` é um código do catálogo, jamais `err.message` ou stack (ADR-010).
 */
export async function failIfProcessing(
  db: DbClient,
  id: string,
  errorCode: string,
): Promise<boolean> {
  const { count } = await db.content.updateMany({
    where: { id, status: ContentStatus.PROCESSING },
    data: { status: ContentStatus.FAILED, errorMessage: errorCode },
  });

  return count === 1;
}
