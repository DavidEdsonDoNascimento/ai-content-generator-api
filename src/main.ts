import { buildApp, type AppInstance } from './app.js';
import { env } from './config/env.js';
import { disconnectPrisma } from './infra/db/prisma.js';

/** Tempo máximo que o encerramento gracioso tem antes de o processo ser derrubado. */
const SHUTDOWN_TIMEOUT_MS = 10_000;

function registerShutdownHandlers(app: AppInstance): void {
  let shuttingDown = false;

  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    app.log.info({ signal }, 'encerrando a API');

    // Rede de segurança: se algo travar o `close`, o processo não fica pendurado.
    const forceExit = setTimeout(() => {
      app.log.error('tempo limite de encerramento excedido; finalizando à força');
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);
    forceExit.unref();

    try {
      // Ordem importa: primeiro para de aceitar requisições e drena as que estão
      // em voo, só então fecha o pool do banco que elas ainda podem estar usando.
      await app.close();
      await disconnectPrisma();
      app.log.info('API encerrada com sucesso');
      process.exit(0);
    } catch (error) {
      app.log.error({ err: error }, 'falha ao encerrar a API');
      process.exit(1);
    }
  };

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      void shutdown(signal);
    });
  }
}

async function start(): Promise<void> {
  const app = await buildApp();
  registerShutdownHandlers(app);

  await app.listen({ host: env.HOST, port: env.PORT });
}

start().catch((error: unknown) => {
  const reason = error instanceof Error ? error.message : 'erro desconhecido';
  process.stderr.write(`Falha ao iniciar a API: ${reason}\n`);
  process.exit(1);
});
