import { randomUUID } from 'node:crypto';

import { PrismaPg } from '@prisma/adapter-pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PrismaClient } from '../../src/generated/prisma/client.js';
import { ContentStatus } from '../../src/generated/prisma/enums.js';
import { createS3Client } from '../../src/infra/storage/s3-client.js';
import { buildContentKey, createStorageService } from '../../src/infra/storage/storage.service.js';
import type { StorageService } from '../../src/infra/storage/storage.types.js';
import { assertLocalTarget, assertOwnObjectKey, requireEnv } from './guards.js';

/**
 * E-01 — o fluxo do enunciado, ponta a ponta, sem nenhum duplo.
 *
 * API real em HTTP, Worker real consumindo a fila real, PostgreSQL real, Redis
 * real, Minio real, download real pelo mesmo link que o avaliador abriria no
 * navegador. É o único teste do repositório em que **nada** é substituído — e é
 * por isso que ele vale, e também por isso que ele fica fora de `npm test`.
 *
 * O que ele prova que a suíte de integração não prova: que as peças montadas
 * pelo Compose — imagem, variáveis, rede, endpoint interno versus URL pública —
 * se encaixam. A suíte prova as **regras**; este prova a **montagem**. Um
 * `S3_PUBLIC_BASE_URL` errado passa em 184 testes de integração e falha aqui,
 * que é exatamente onde deve falhar.
 *
 * ## Opt-in
 *
 * Exige `RUN_E2E=true` **e** a stack de pé. Sem isso, os casos são pulados com
 * instrução — nunca vermelho por ambiente ausente, que seria ruído.
 *
 *   PowerShell:  $env:RUN_E2E='true'; npm run test:e2e
 *   bash/zsh:    RUN_E2E=true npm run test:e2e
 *
 * `pretest:e2e` recria o Worker com `AI_FAILURE_RATE=0` (ver
 * `docker-compose.e2e.yml`) e `posttest:e2e` devolve o padrão do enunciado.
 *
 * ## Segurança
 *
 * Este é o único teste que escreve no banco de **trabalho**. Ele nunca trunca,
 * nunca faz `FLUSHDB` e nunca esvazia bucket: cria um usuário com UUID próprio,
 * e no fim apaga esse usuário (o conteúdo vai junto por `ON DELETE CASCADE`) e
 * um único objeto, cuja chave é conferida por igualdade. Ver `guards.ts`.
 */

const ENABLED = process.env['RUN_E2E'] === 'true';

if (!ENABLED) {
  process.stdout.write(
    '\n[e2e] pulado: defina RUN_E2E=true para executar.\n' +
      "      PowerShell:  $env:RUN_E2E='true'; npm run test:e2e\n" +
      '      bash/zsh:    RUN_E2E=true npm run test:e2e\n\n',
  );
}

const API = process.env['E2E_API_URL'] ?? 'http://localhost:3000';
const TOPIC = 'Fluxo completo ponta a ponta do E2E';
/** Reconhecível no banco caso uma execução morra antes do cleanup. */
const USER_NAME = 'e2e-full-flow';

interface ContentBody {
  readonly id: string;
  readonly userId: string;
  readonly topic: string;
  readonly status: ContentStatus;
  readonly fileUrl: string | null;
  readonly errorMessage: string | null;
  readonly attempts: number;
  readonly completedAt: string | null;
  readonly canceledAt: string | null;
}

let prisma: PrismaClient;
let storage: StorageService;
let userId: string;
/** Preenchido assim que o conteúdo existe, para o cleanup saber o que remover. */
let createdContentId: string | undefined;

async function getJson<T>(url: string): Promise<{ status: number; body: T }> {
  const response = await fetch(url);
  return { status: response.status, body: (await response.json()) as T };
}

/**
 * Polling com teto — nunca `sleep` fixo. Quem decide o fim é a **condição**: um
 * atraso a mais na IA não pode virar falha, e um estado terminal alcançado antes
 * não pode virar espera desperdiçada.
 */
async function waitForTerminal(contentId: string, timeoutMs = 60_000): Promise<ContentBody> {
  const deadline = Date.now() + timeoutMs;
  const seen = new Set<string>();

  for (;;) {
    const { body } = await getJson<ContentBody>(`${API}/api/content/${contentId}`);
    seen.add(body.status);

    if (body.status !== ContentStatus.PENDING && body.status !== ContentStatus.PROCESSING) {
      return body;
    }

    if (Date.now() >= deadline) {
      throw new Error(
        `Conteúdo ${contentId} não chegou a estado terminal em ${String(timeoutMs)} ms. ` +
          `Estados observados: ${[...seen].join(' → ')}.`,
      );
    }

    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

beforeAll(async () => {
  if (!ENABLED) {
    return;
  }

  // Guarda antes de qualquer escrita: se o alvo não for local, o teste para aqui
  // e não cria nada.
  const databaseUrl = requireEnv('DATABASE_URL');
  assertLocalTarget(databaseUrl, 'DATABASE_URL');
  assertLocalTarget(API, 'a API do E2E');

  const endpoint = requireEnv('S3_ENDPOINT');
  assertLocalTarget(endpoint, 'S3_ENDPOINT');

  // Preflight: uma stack fora do ar deve dizer isso, e não falhar num `fetch`
  // solto no meio do caso, onde a mensagem não ajudaria ninguém.
  let health: Response;
  try {
    health = await fetch(`${API}/health`);
  } catch (error) {
    throw new Error(
      `Stack inacessível em ${API}. Suba com \`docker compose up -d\` antes do E2E.`,
      { cause: error },
    );
  }
  expect(health.status, `GET ${API}/health`).toBe(200);

  prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: databaseUrl }),
    log: ['warn', 'error'],
  });

  storage = createStorageService({
    client: createS3Client({
      endpoint,
      region: process.env['S3_REGION'] ?? 'us-east-1',
      accessKeyId: requireEnv('S3_ACCESS_KEY_ID'),
      secretAccessKey: requireEnv('S3_SECRET_ACCESS_KEY'),
    }),
    bucket: requireEnv('S3_BUCKET'),
    publicBaseUrl: requireEnv('S3_PUBLIC_BASE_URL'),
  });

  // Usuário exclusivo, com UUID novo a cada execução: os do seed ficam
  // intocados, e duas execuções nunca disputam o mesmo saldo.
  userId = randomUUID();
  await prisma.user.create({ data: { id: userId, name: USER_NAME, credits: 1 } });
});

afterAll(async () => {
  if (!ENABLED) {
    return;
  }

  // Cleanup cirúrgico, e tolerante: se o teste falhou no meio, ainda assim o
  // ambiente volta ao que era. Cada passo é independente do anterior.
  try {
    if (createdContentId !== undefined) {
      await storage.remove(assertOwnObjectKey(buildContentKey(createdContentId), createdContentId));
    }
  } catch {
    // Objeto pode nunca ter existido (falha antes do upload). `DeleteObject` é
    // idempotente, então o único caso que sobra é storage fora do ar — e falhar
    // o cleanup por isso esconderia a causa real da falha do teste.
  }

  if (prisma !== undefined) {
    // O conteúdo vai junto por `ON DELETE CASCADE`. Nenhum TRUNCATE, nenhuma
    // linha que não seja deste usuário.
    await prisma.user.deleteMany({ where: { id: userId } });
    await prisma.$disconnect();
  }

  storage?.close();
});

describe.skipIf(!ENABLED)('E-01 — fluxo completo contra a stack real', () => {
  it('gera, processa, publica o arquivo e entrega uma URL que abre', async () => {
    // ---------------------------------------------------------------- geração
    const startedAt = Date.now();
    const created = await fetch(`${API}/api/content/generate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ topic: TOPIC, userId }),
    });
    const elapsedMs = Date.now() - startedAt;
    const createdBody = (await created.json()) as ContentBody;

    expect(created.status).toBe(201);
    expect(createdBody.status).toBe(ContentStatus.PENDING);
    expect(createdBody.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
    // A resposta não espera a IA. O teto é folgado para não medir a máquina, mas
    // qualquer coisa acima dele significa que o `await` da geração voltou para o
    // caminho da requisição — o defeito que a arquitetura inteira existe para
    // evitar.
    expect(elapsedMs, 'POST /generate não pode esperar a IA').toBeLessThan(3_000);

    createdContentId = createdBody.id;
    const contentId = createdBody.id;

    // -------------------------------------------------------------- conclusão
    const finished = await waitForTerminal(contentId);

    expect(finished.status, `errorMessage: ${finished.errorMessage ?? 'nenhum'}`).toBe(
      ContentStatus.COMPLETED,
    );
    expect(finished.attempts).toBeGreaterThanOrEqual(1);
    expect(finished.completedAt).not.toBeNull();
    expect(finished.errorMessage).toBeNull();
    expect(finished.canceledAt).toBeNull();
    expect(finished.topic).toBe(TOPIC);

    // ------------------------------------------------------------- URL pública
    const fileUrl = finished.fileUrl;
    expect(fileUrl).not.toBeNull();

    if (fileUrl === null) {
      throw new Error('inalcançável: fileUrl nulo em COMPLETED');
    }

    // O endpoint interno da rede do Compose resolve para o Worker e para mais
    // ninguém. Se ele vazar para cá, o link entregue ao cliente não abre —
    // exatamente o erro que a separação de endereços existe para impedir
    // (ADR-009), e que só um teste de fora da rede consegue pegar.
    expect(fileUrl).not.toContain('minio:9000');
    expect(fileUrl).not.toContain(process.env['S3_ACCESS_KEY_ID'] ?? '###');
    expect(fileUrl).not.toContain(process.env['S3_SECRET_ACCESS_KEY'] ?? '###');
    // Sem credencial em query string: nada de URL pré-assinada disfarçada.
    expect(fileUrl).not.toMatch(/[?&](X-Amz-|AWSAccessKeyId|Signature)/i);
    expect(fileUrl).toBe(
      `${process.env['S3_PUBLIC_BASE_URL'] ?? ''}/${process.env['S3_BUCKET'] ?? ''}/contents/${contentId}.txt`,
    );

    // ------------------------------------------------------------- download
    const download = await fetch(fileUrl);

    expect(download.status, `GET ${fileUrl}`).toBe(200);
    expect(download.headers.get('content-type')).toContain('text/plain');

    const text = await download.text();
    expect(text).toContain(TOPIC);
    expect(text.length).toBeGreaterThan(0);

    // ------------------------------------------------------------------ banco
    const persisted = await prisma.content.findUniqueOrThrow({ where: { id: contentId } });

    expect(persisted.fileKey).toBe(`contents/${contentId}.txt`);
    expect(persisted.fileUrl).toBe(fileUrl);
    expect(persisted.status).toBe(ContentStatus.COMPLETED);

    // Exatamente um crédito consumido, exatamente um conteúdo. O usuário é
    // exclusivo desta execução, então a contagem é fechada.
    const user = await prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { credits: true },
    });
    expect(user.credits).toBe(0);
    expect(await prisma.content.count({ where: { userId } })).toBe(1);

    // Sem execução duplicada: com `AI_FAILURE_RATE=0` a primeira tentativa
    // sucede, então qualquer valor acima de 1 significa que o job foi entregue
    // e processado mais de uma vez.
    expect(persisted.attempts, 'attempts > 1 indica processamento duplicado').toBe(1);

    // E o `fileKey` continua interno: o contrato HTTP não o expõe.
    const { body: publicBody } = await getJson<Record<string, unknown>>(
      `${API}/api/content/${contentId}`,
    );
    expect(publicBody).not.toHaveProperty('fileKey');
  });
});
