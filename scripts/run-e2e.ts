/**
 * Runner do E2E.
 *
 * Existe por causa de um defeito real da Fase 8: o ciclo era
 * `pretest:e2e` → `test:e2e` → `posttest:e2e`, e o npm **só executa o
 * `post<script>` quando o script principal termina com sucesso**. Um E2E
 * vermelho deixava o Worker rodando com `AI_FAILURE_RATE=0` — exatamente o
 * cenário em que ninguém repara, porque a atenção está na falha do teste. O
 * ambiente ficava mentindo: passaria a esconder justamente as falhas de IA que a
 * suíte de integração existe para provar.
 *
 * Aqui a restauração vive num `finally`, que roda em qualquer desfecho, e o
 * código de saída do Vitest é preservado para que o comando continue sendo um
 * sinal honesto de sucesso ou falha.
 *
 * Uso:
 *
 *   npm run test:e2e
 *
 * Não é preciso exportar `RUN_E2E`: invocar este runner **é** o opt-in
 * explícito, e ele repassa a variável ao Vitest. A proteção contra execução
 * acidental continua sendo estrutural — o E2E mora em `vitest.e2e.config.ts`,
 * fora dos projects de `vitest.config.ts`, então `npm test` e `npm run validate`
 * não o alcançam de jeito nenhum.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const envFilePath = resolve(import.meta.dirname, '..', '.env');
if (existsSync(envFilePath)) {
  process.loadEnvFile(envFilePath);
}

/** Padrões do enunciado. O Worker precisa voltar exatamente a estes valores. */
const PRODUCTION_AI = { AI_FAILURE_RATE: '0.2', AI_DELAY_MS: '5000' } as const;

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]', '0.0.0.0']);

/**
 * Executa um comando com argumentos **separados** — nunca uma string montada por
 * concatenação, que transformaria qualquer valor de ambiente em injeção de shell.
 */
function run(
  command: string,
  args: readonly string[],
  options: { readonly capture?: boolean; readonly env?: NodeJS.ProcessEnv } = {},
): Promise<{ code: number; stdout: string }> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, [...args], {
      // `shell: true` no Windows porque `docker` e `npx` são `.cmd`, que o
      // `CreateProcess` não executa diretamente. Os argumentos seguem separados.
      shell: process.platform === 'win32',
      stdio: options.capture === true ? ['ignore', 'pipe', 'inherit'] : 'inherit',
      env: options.env ?? process.env,
    });

    let stdout = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });

    child.on('error', rejectPromise);
    child.on('close', (code) => {
      resolvePromise({ code: code ?? 1, stdout });
    });
  });
}

function assertLocalTarget(rawUrl: string | undefined, label: string): void {
  if (rawUrl === undefined || rawUrl === '') {
    throw new Error(`${label} ausente. Copie o .env.example para .env antes de rodar o E2E.`);
  }

  let host: string;
  try {
    host = new URL(rawUrl).hostname;
  } catch {
    throw new Error(`${label} não é uma URL válida.`);
  }

  if (!LOCAL_HOSTS.has(host)) {
    // Mensagem cita só o host: a URL carrega senha.
    throw new Error(
      `Recusando rodar o E2E contra ${label} no host "${host}": ` +
        'este comando recria containers e apaga dados, e só roda contra a stack local.',
    );
  }
}

/** Sobe o Worker com um conjunto de arquivos Compose, sempre recriando o container. */
async function recreateWorker(composeFiles: readonly string[]): Promise<void> {
  const args = composeFiles.flatMap((file) => ['-f', file]);
  const { code } = await run('docker', [
    'compose',
    ...args,
    'up',
    '-d',
    '--force-recreate',
    'worker',
  ]);

  if (code !== 0) {
    throw new Error(`Falha ao recriar o serviço worker (exit ${String(code)}).`);
  }
}

/** Id do container do Worker, pelo Compose — não pelo nome, que depende do project. */
async function workerContainerId(): Promise<string> {
  const { stdout } = await run('docker', ['compose', 'ps', '-q', 'worker'], { capture: true });
  return stdout.trim().split(/\r?\n/)[0] ?? '';
}

/**
 * Confirma que o Worker voltou **de fato**: container rodando e com os padrões
 * do enunciado no ambiente. Sem esta verificação, a restauração seria uma
 * intenção, não um fato — e o modo de falha silencioso é o mesmo que motivou
 * este runner.
 */
async function assertWorkerRestored(): Promise<void> {
  const containerId = await workerContainerId();

  if (containerId === '') {
    throw new Error('Worker não encontrado depois da restauração.');
  }

  // `docker inspect` sem `--format`: um template como `{{json .Config.Env}}`
  // contém espaço, e no Windows o `shell: true` — necessário porque `docker` é
  // um `.cmd` — junta os argumentos e reparte por espaço, quebrando o template
  // em dois tokens. Ler o JSON completo evita a questão de citação por inteiro,
  // e ainda troca duas chamadas por uma.
  const { stdout: raw } = await run('docker', ['inspect', containerId], { capture: true });

  const [inspected] = JSON.parse(raw) as {
    State: { Running: boolean };
    Config: { Env: string[] };
  }[];

  if (inspected === undefined) {
    throw new Error('`docker inspect` não devolveu dados do worker restaurado.');
  }

  if (!inspected.State.Running) {
    throw new Error('Worker restaurado não está ativo.');
  }

  const entries = inspected.Config.Env.reduce<Record<string, string>>((acc, line) => {
    const index = line.indexOf('=');
    if (index > 0) {
      acc[line.slice(0, index)] = line.slice(index + 1);
    }
    return acc;
  }, {});

  for (const [name, expected] of Object.entries(PRODUCTION_AI)) {
    if (entries[name] !== expected) {
      throw new Error(
        `Worker restaurado com ${name}=${entries[name] ?? '(ausente)'}, esperado ${expected}. ` +
          'Rode `docker compose up -d --force-recreate worker` para corrigir.',
      );
    }
  }

  process.stdout.write(
    `[e2e] worker restaurado: AI_FAILURE_RATE=${PRODUCTION_AI.AI_FAILURE_RATE}, ` +
      `AI_DELAY_MS=${PRODUCTION_AI.AI_DELAY_MS}\n`,
  );
}

async function main(): Promise<number> {
  assertLocalTarget(process.env['DATABASE_URL'], 'DATABASE_URL');
  assertLocalTarget(process.env['S3_ENDPOINT'], 'S3_ENDPOINT');

  process.stdout.write('[e2e] recriando o worker em modo determinístico…\n');
  await recreateWorker(['docker-compose.yml', 'docker-compose.e2e.yml']);

  try {
    const { code } = await run('npx', ['vitest', 'run', '-c', 'vitest.e2e.config.ts'], {
      // Invocar este runner é o opt-in; o Vitest recebe a variável pronta.
      env: { ...process.env, RUN_E2E: 'true' },
    });
    return code;
  } finally {
    // Roda em qualquer desfecho — sucesso, falha ou exceção. É o ponto inteiro
    // deste arquivo.
    process.stdout.write('\n[e2e] restaurando o worker…\n');
    await recreateWorker(['docker-compose.yml']);
    await assertWorkerRestored();
  }
}

main()
  .then((code) => {
    // Preserva o código do Vitest: o comando precisa continuar sendo um sinal
    // honesto, e não virar verde só porque o cleanup funcionou.
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    process.stderr.write(
      `\n[e2e] ${error instanceof Error ? error.message : 'erro desconhecido'}\n`,
    );
    process.exitCode = 1;
  });
