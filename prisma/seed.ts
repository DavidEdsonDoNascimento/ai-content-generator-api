/**
 * Seed de DESENVOLVIMENTO. Cria os três usuários usados para exercitar as regras
 * de crédito do desafio — sem eles, não há como testar `POST /api/content/generate`
 * (risco R-10 de docs/0001_Challenge_Analysis.md).
 *
 * Idempotente: usa `upsert` com UUIDs fixos. Rodar duas vezes não duplica nada e
 * **restaura** os saldos documentados — esse é justamente o contrato do seed,
 * deixar o banco num estado conhecido. Ele nunca toca em nenhuma linha além
 * destes três UUIDs, e nunca cria conteúdos.
 *
 * Execução: `npm run prisma:seed` (ou `npx prisma db seed`). No Docker, roda
 * apenas quando `RUN_SEED=true` — ver docker/migrate-entrypoint.sh e ADR-023.
 */
import { disconnectPrisma, prisma } from '../src/infra/db/prisma.js';

/** UUIDs fixos e documentados: o avaliador usa estes valores direto no `curl`. */
const SEED_USERS = [
  {
    id: '00000000-0000-4000-8000-000000000001',
    name: 'Usuário de teste — 10 créditos',
    credits: 10,
  },
  {
    id: '00000000-0000-4000-8000-000000000002',
    name: 'Usuário de teste — 1 crédito (corrida de crédito)',
    credits: 1,
  },
  {
    id: '00000000-0000-4000-8000-000000000003',
    name: 'Usuário de teste — sem créditos',
    credits: 0,
  },
] as const;

async function seed(): Promise<void> {
  for (const user of SEED_USERS) {
    await prisma.user.upsert({
      where: { id: user.id },
      create: { id: user.id, name: user.name, credits: user.credits },
      update: { name: user.name, credits: user.credits },
    });
    process.stdout.write(`[seed] usuário ${user.id} · ${user.credits} crédito(s)\n`);
  }

  process.stdout.write(`[seed] concluído: ${String(SEED_USERS.length)} usuário(s) garantido(s)\n`);
}

try {
  await seed();
} catch (error) {
  const reason = error instanceof Error ? error.message : 'erro desconhecido';
  process.stderr.write(`[seed] falhou: ${reason}\n`);
  process.exitCode = 1;
} finally {
  await disconnectPrisma();
}
