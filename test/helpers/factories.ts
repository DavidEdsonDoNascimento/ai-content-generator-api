import { randomUUID } from 'node:crypto';

import type { Content, User } from '../../src/generated/prisma/client.js';
import { ContentStatus } from '../../src/generated/prisma/enums.js';
import { prisma } from '../../src/infra/db/prisma.js';

/**
 * Fixtures dos testes de integração.
 *
 * Cada teste cria os dados de que precisa, com UUID aleatório: depender dos três
 * usuários do seed acoplaria a suíte a um artefato de desenvolvimento e faria os
 * testes se contaminarem entre si. O saldo relevante para o caso fica **na
 * chamada**, visível junto da asserção.
 */

export async function createUser(credits: number, name = 'Usuário de teste'): Promise<User> {
  return prisma.user.create({
    data: { id: randomUUID(), name, credits },
  });
}

export async function createContent(input: {
  userId: string;
  status?: ContentStatus;
  topic?: string;
  fileUrl?: string | null;
  completedAt?: Date | null;
  canceledAt?: Date | null;
}): Promise<Content> {
  const status = input.status ?? ContentStatus.PENDING;

  return prisma.content.create({
    data: {
      id: randomUUID(),
      userId: input.userId,
      topic: input.topic ?? 'Tópico de teste',
      status,
      fileUrl: input.fileUrl ?? null,
      // Timestamps coerentes com o estado: um COMPLETED sem `completedAt` seria
      // um registro que a aplicação nunca produz, e testar contra ele valida um
      // cenário impossível.
      completedAt: input.completedAt ?? (status === ContentStatus.COMPLETED ? new Date() : null),
      canceledAt: input.canceledAt ?? (status === ContentStatus.CANCELED ? new Date() : null),
    },
  });
}

export async function creditsOf(userId: string): Promise<number> {
  const user = await prisma.user.findUniqueOrThrow({
    where: { id: userId },
    select: { credits: true },
  });

  return user.credits;
}

export async function countContents(userId: string): Promise<number> {
  return prisma.content.count({ where: { userId } });
}
