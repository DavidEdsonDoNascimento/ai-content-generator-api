/**
 * Endereço do banco de testes e a guarda que impede o `TRUNCATE` de encostar em
 * qualquer outro banco.
 *
 * Os testes de concorrência precisam de **commits reais** em conexões distintas
 * (0005 §5): a alternativa comum — uma transação por teste com rollback — não
 * serve, porque duas transações concorrentes que nunca comitam não disputam nada.
 * Como consequência, a limpeza entre testes tem de ser destrutiva, e por isso
 * existe a guarda deste módulo.
 */

/** Sufixo obrigatório: nenhum comando destrutivo roda fora de um banco `*_test`. */
const TEST_DATABASE_SUFFIX = '_test';

/** Nomes de banco aceitos. Restringe o que pode ser interpolado em `CREATE DATABASE`. */
const SAFE_DATABASE_NAME = /^[a-z][a-z0-9_]*_test$/;

/**
 * URL do banco de testes: `TEST_DATABASE_URL` quando definida, senão a
 * `DATABASE_URL` de desenvolvimento com `_test` no nome do banco.
 *
 * Derivar em vez de exigir uma segunda variável mantém `npm test` funcionando
 * com o mesmo `.env` que já sobe o projeto — e o sufixo é justamente o que a
 * guarda exige, então o caminho fácil é também o seguro.
 */
export function resolveTestDatabaseUrl(): string {
  const explicit = process.env['TEST_DATABASE_URL'];
  if (explicit !== undefined && explicit !== '') {
    return explicit;
  }

  const base = process.env['DATABASE_URL'];
  if (base === undefined || base === '') {
    throw new Error(
      'Nem TEST_DATABASE_URL nem DATABASE_URL estão definidas. ' +
        'Copie o .env.example para .env antes de rodar os testes de integração.',
    );
  }

  const url = new URL(base);
  const database = url.pathname.replace(/^\//, '');

  if (database === '') {
    // Mensagem sem a URL: ela carrega senha.
    throw new Error('DATABASE_URL não indica um banco de dados no caminho.');
  }

  url.pathname = `/${database}${TEST_DATABASE_SUFFIX}`;
  return url.toString();
}

/** URL do banco de manutenção (`postgres`), usada só para criar o banco de teste. */
export function adminDatabaseUrl(testUrl: string): string {
  const url = new URL(testUrl);
  url.pathname = '/postgres';
  return url.toString();
}

/**
 * Extrai o nome do banco **e recusa** qualquer coisa que não seja um banco de
 * teste. Chamada antes de criar o banco e antes de cada `TRUNCATE`: a guarda
 * roda no momento do uso, não só na configuração, porque é a variável de
 * ambiente do processo que decide onde o comando cai.
 */
export function assertTestDatabaseName(url: string): string {
  const database = new URL(url).pathname.replace(/^\//, '');

  if (!SAFE_DATABASE_NAME.test(database)) {
    throw new Error(
      `Recusando operar sobre o banco "${database}": testes só rodam contra um banco ` +
        `terminado em "${TEST_DATABASE_SUFFIX}". Ajuste TEST_DATABASE_URL.`,
    );
  }

  return database;
}
