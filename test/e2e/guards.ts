/**
 * Guardas do E2E.
 *
 * A suíte de integração pode ser destrutiva porque só toca um banco `*_test` e o
 * Redis database 15 — as guardas de lá recusam qualquer outro alvo. O E2E é o
 * oposto: ele fala com o banco de **trabalho** e com o bucket de verdade, porque
 * o que ele prova é a stack real respondendo em HTTP.
 *
 * Então a segurança aqui não pode ser "limpar com cuidado". Ela é estrutural:
 *
 * - o teste **nunca** trunca, nunca faz `FLUSHDB`, nunca esvazia bucket;
 * - ele só apaga linhas cujo `id` ele mesmo gerou, e um único objeto cuja chave
 *   ele confere caractere a caractere;
 * - e nada disso roda se o alvo não for comprovadamente local.
 */

/** Hosts aceitos. Qualquer outro é tratado como ambiente que não é desta máquina. */
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]', '0.0.0.0']);

/**
 * Recusa qualquer URL que não aponte para esta máquina.
 *
 * O E2E escreve e apaga dados reais. Se `DATABASE_URL` estiver apontando para
 * qualquer coisa que não seja o Compose local — um banco compartilhado, um
 * ambiente de homologação, o que for —, a resposta certa é parar antes de
 * escrever a primeira linha, não confiar que o cleanup vai dar conta.
 *
 * A mensagem cita só o host, nunca a URL: ela carrega senha.
 */
export function assertLocalTarget(rawUrl: string, label: string): URL {
  let url: URL;

  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error(`${label} não é uma URL válida.`);
  }

  if (!LOCAL_HOSTS.has(url.hostname)) {
    throw new Error(
      `Recusando rodar o E2E contra ${label} no host "${url.hostname}": ` +
        'este teste cria e apaga dados reais e só roda contra a stack local ' +
        `(${[...LOCAL_HOSTS].join(', ')}).`,
    );
  }

  return url;
}

/**
 * Confere que a chave a ser removida é **exatamente** a do conteúdo criado por
 * esta execução.
 *
 * Comparação por igualdade, não por prefixo: `startsWith('contents/')` aceitaria
 * qualquer objeto do bucket, e um `contentId` errado na variável apagaria o
 * arquivo de outra pessoa. A chave é determinística, então a forma exata é
 * conhecida e não há motivo para aceitar menos que ela.
 */
export function assertOwnObjectKey(key: string, contentId: string): string {
  const expected = `contents/${contentId}.txt`;

  if (key !== expected) {
    throw new Error(`Recusando remover a chave "${key}": esperada exatamente "${expected}".`);
  }

  return key;
}

/** Lê uma variável obrigatória do ambiente, falhando com instrução em vez de `undefined`. */
export function requireEnv(name: string): string {
  const value = process.env[name];

  if (value === undefined || value === '') {
    throw new Error(`${name} ausente. Copie o .env.example para .env antes de rodar o E2E.`);
  }

  return value;
}
