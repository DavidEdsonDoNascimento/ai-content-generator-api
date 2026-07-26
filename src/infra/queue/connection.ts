import { Redis } from 'ioredis';

/**
 * Conexões Redis com **políticas opostas**, de propósito.
 *
 * API e Worker usam o mesmo Redis, mas querem coisas incompatíveis dele:
 *
 * - a **API** está dentro de uma requisição HTTP. Se o Redis sumir, o pior
 *   resultado possível é a requisição ficar pendurada: o usuário espera, o
 *   crédito já foi debitado e ninguém compensa. Ela precisa **falhar rápido**
 *   para que o service execute o estorno e responda `503`;
 * - o **Worker** é um processo de fundo que vive de comandos bloqueantes
 *   (`BRPOPLPUSH` e afins). Para ele, desistir de um comando é o erro: o BullMQ
 *   exige `maxRetriesPerRequest: null`, e um `commandTimeout` derrubaria a
 *   espera normal por um job novo.
 *
 * São, portanto, duas conexões distintas — não a mesma instância compartilhada.
 * Reaproveitar a do publicador no Worker importaria o *fail-fast* para dentro do
 * consumidor e o faria morrer no primeiro soluço da rede.
 */

/** Teto de espera de um comando do publicador, em milissegundos. */
const PUBLISHER_COMMAND_TIMEOUT_MS = 2_000;

/** Teto para estabelecer a conexão TCP do publicador. */
const PUBLISHER_CONNECT_TIMEOUT_MS = 2_000;

/** Reconexões toleradas por comando antes de ele falhar, no publicador. */
const PUBLISHER_MAX_RETRIES_PER_REQUEST = 2;

function attachErrorLogging(connection: Redis, role: string): Redis {
  // Sem um listener de 'error', um erro de conexão do IORedis vira exceção não
  // tratada e derruba o processo — justamente o que não pode acontecer quando o
  // Redis cai e a API ainda precisa responder 503.
  connection.on('error', (error: Error) => {
    process.stderr.write(`[redis:${role}] ${error.message}\n`);
  });

  return connection;
}

/**
 * Conexão do publicador (API). Falha em tempo **limitado** quando o Redis está
 * indisponível, para que `ContentService.generate` chegue à compensação em vez
 * de deixar o cliente pendurado.
 */
export function createPublisherConnection(url: string): Redis {
  const connection = new Redis(url, {
    maxRetriesPerRequest: PUBLISHER_MAX_RETRIES_PER_REQUEST,
    commandTimeout: PUBLISHER_COMMAND_TIMEOUT_MS,
    connectTimeout: PUBLISHER_CONNECT_TIMEOUT_MS,
    // Backoff curto e limitado: aqui há um usuário esperando do outro lado.
    retryStrategy: (times) => Math.min(times * 200, 1_000),
    lazyConnect: true,
  });

  return attachErrorLogging(connection, 'publisher');
}

/**
 * Conexão do Worker. `maxRetriesPerRequest: null` é **exigência do BullMQ** — o
 * consumidor não pode desistir de um comando bloqueante — e não há
 * `commandTimeout` pelo mesmo motivo: esperar por um job novo é o estado normal,
 * não uma falha.
 */
export function createWorkerConnection(url: string): Redis {
  const connection = new Redis(url, {
    maxRetriesPerRequest: null,
    // Backoff mais folgado: ninguém está esperando uma resposta HTTP, e
    // martelar um Redis que caiu não o traz de volta mais cedo.
    retryStrategy: (times) => Math.min(times * 500, 5_000),
    lazyConnect: true,
  });

  return attachErrorLogging(connection, 'worker');
}

/** Fecha a conexão sem lançar: usado em shutdown, onde erro não muda o desfecho. */
export async function closeConnection(connection: Redis): Promise<void> {
  try {
    await connection.quit();
  } catch {
    connection.disconnect();
  }
}
