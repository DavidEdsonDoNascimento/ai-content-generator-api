/**
 * Endereço do Redis de testes e a guarda que impede o `FLUSHDB` de encostar no
 * database de trabalho.
 *
 * Mesmo raciocínio do banco de dados (`test-database.ts`): os testes precisam de
 * um Redis limpo entre os casos, a limpeza é destrutiva, então o alvo é
 * verificado no momento do uso — e não só na configuração, porque quem decide
 * onde o comando cai é a variável de ambiente do processo.
 */

/** Índice reservado aos testes. O 0 é o padrão do IORedis e o de trabalho. */
export const TEST_REDIS_DATABASE = 15;

/**
 * URL do Redis de testes: `TEST_REDIS_URL` quando definida, senão a `REDIS_URL`
 * com o índice do database trocado pelo reservado.
 */
export function resolveTestRedisUrl(): string {
  const explicit = process.env['TEST_REDIS_URL'];
  if (explicit !== undefined && explicit !== '') {
    return explicit;
  }

  const base = process.env['REDIS_URL'];
  if (base === undefined || base === '') {
    throw new Error(
      'Nem TEST_REDIS_URL nem REDIS_URL estão definidas. ' +
        'Copie o .env.example para .env antes de rodar os testes de integração.',
    );
  }

  const url = new URL(base);
  url.pathname = `/${String(TEST_REDIS_DATABASE)}`;
  return url.toString();
}

/**
 * Extrai o índice do database e **recusa** o 0.
 *
 * Um `FLUSHDB` no índice 0 apagaria a fila de trabalho — inclusive jobs reais em
 * espera. A guarda é o que torna seguro limpar o Redis a cada teste.
 */
export function assertTestRedisDatabase(url: string): number {
  const path = new URL(url).pathname.replace(/^\//, '');
  const database = path === '' ? 0 : Number(path);

  if (!Number.isInteger(database) || database <= 0) {
    throw new Error(
      `Recusando operar sobre o Redis database "${path || '0'}": os testes só rodam ` +
        'contra um database dedicado (índice maior que 0). Ajuste TEST_REDIS_URL.',
    );
  }

  return database;
}
