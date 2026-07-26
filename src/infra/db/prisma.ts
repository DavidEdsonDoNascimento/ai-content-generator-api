import { PrismaPg } from '@prisma/adapter-pg';

import { env } from '../../config/env.js';
import { PrismaClient } from '../../generated/prisma/client.js';
import type { Prisma } from '../../generated/prisma/client.js';

/**
 * Cliente Prisma único, compartilhado por API e (a partir da Fase 5) Worker.
 *
 * Prisma 7 é "Rust-free": a conexão passa por um driver adapter (`pg`) em vez de
 * um engine binário. Instanciar não abre conexão — o pool sobe de forma lazy, na
 * primeira query —, então importar este módulo é barato e não faz I/O.
 */
const adapter = new PrismaPg({ connectionString: env.DATABASE_URL });

export const prisma = new PrismaClient({
  adapter,
  // `query` só em desenvolvimento: o log de query inclui o SQL executado, que em
  // produção é ruído e superfície desnecessária de exposição de dados.
  log: env.NODE_ENV === 'development' ? ['query', 'warn', 'error'] : ['warn', 'error'],
});

/**
 * Executor de banco aceito pelos repositórios: o client normal **ou** o client
 * de dentro de uma `$transaction`.
 *
 * É isso que permite ao service decidir o escopo transacional sem que o
 * repositório precise saber em qual dos dois está rodando — o débito de crédito
 * e o insert do conteúdo compartilham a mesma transação justamente assim.
 */
export type DbClient = PrismaClient | Prisma.TransactionClient;

/**
 * Verifica se o banco responde. Usada pela sonda de readiness (`GET /ready`).
 *
 * `SELECT 1` de propósito: prova que há conexão disponível no pool e que o
 * PostgreSQL responde, sem depender de nenhuma tabela — uma consulta a `users`
 * confundiria "banco fora do ar" com "migration não aplicada", que são incidentes
 * diferentes. Não lança: readiness é uma resposta, não um erro.
 */
export async function pingDatabase(): Promise<boolean> {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return true;
  } catch {
    return false;
  }
}

/** Fecha o pool de conexões. Chamado no encerramento gracioso do processo. */
export async function disconnectPrisma(): Promise<void> {
  await prisma.$disconnect();
}
