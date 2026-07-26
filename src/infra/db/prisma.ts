import { PrismaPg } from '@prisma/adapter-pg';

import { env } from '../../config/env.js';
import { PrismaClient } from '../../generated/prisma/client.js';

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

/** Fecha o pool de conexões. Chamado no encerramento gracioso do processo. */
export async function disconnectPrisma(): Promise<void> {
  await prisma.$disconnect();
}
