import type { StorageService, UploadInput } from '../../src/infra/storage/storage.types.js';

/**
 * Storage em memória com as alavancas que os testes precisam: modo de falha,
 * barreira para bloquear o upload, e histórico de operações.
 *
 * Por que **não** Minio real na suíte: o que os testes desta fase provam é
 * decisão do processor — quando fazer upload, quando **não** fazer, e sobretudo
 * quando remover um objeto sem apagar o arquivo de outra execução. Nada disso é
 * garantia do S3; usar o real só acrescentaria latência, um container a mais e
 * uma razão de falhar alheia ao que se quer verificar. O upload de verdade é
 * validado manualmente contra o Minio (0005 §9).
 *
 * O que **é** garantia do S3 — round-trip UTF-8, `Content-Type` preservado, URL
 * path-style pública, `DeleteObject` idempotente — foi verificado contra o Minio
 * real antes de a integração ser escrita.
 */

export interface StoredObject {
  readonly body: Uint8Array;
  readonly contentType: string;
}

export interface FakeStorageOptions {
  readonly publicBaseUrl?: string;
  readonly bucket?: string;
  /** Número de uploads a falhar a partir do primeiro, ou `'always'`. */
  readonly failUploads?: number | 'always';
  /** Erro lançado por `remove`, para exercitar a limpeza best-effort. */
  readonly removeError?: Error;
  /** Executado no início do upload — a barreira dos testes de concorrência. */
  readonly onUpload?: (key: string) => Promise<void>;
}

export interface FakeStorage extends StorageService {
  readonly objects: Map<string, StoredObject>;
  readonly removed: string[];
  /** Sequência de operações, para asserções de ordem. */
  readonly history: string[];
  uploadCount(): number;
  /** Conteúdo do objeto decodificado como UTF-8. */
  text(key: string): string | undefined;
}

export function createFakeStorage(options: FakeStorageOptions = {}): FakeStorage {
  const objects = new Map<string, StoredObject>();
  const removed: string[] = [];
  const history: string[] = [];
  const publicBase = (options.publicBaseUrl ?? 'http://localhost:9000').replace(/\/+$/, '');
  const bucket = options.bucket ?? 'ai-content';

  let uploads = 0;

  return {
    objects,
    removed,
    history,

    uploadCount: () => uploads,

    text(key: string): string | undefined {
      const stored = objects.get(key);
      return stored === undefined ? undefined : Buffer.from(stored.body).toString('utf8');
    },

    async upload(input: UploadInput): Promise<void> {
      uploads += 1;
      history.push(`upload:${input.key}`);

      if (options.onUpload !== undefined) {
        await options.onUpload(input.key);
      }

      const shouldFail =
        options.failUploads === 'always' ||
        (typeof options.failUploads === 'number' && uploads <= options.failUploads);

      if (shouldFail) {
        history.push(`upload-failed:${input.key}`);
        // Mensagem no estilo do SDK, para os testes provarem que ela **não**
        // chega ao banco nem ao cliente.
        throw new Error(`NoSuchBucket: bucket ${bucket} não existe em http://minio:9000`);
      }

      objects.set(input.key, { body: input.body, contentType: input.contentType });
    },

    async remove(key: string): Promise<void> {
      history.push(`remove:${key}`);
      removed.push(key);

      if (options.removeError !== undefined) {
        throw options.removeError;
      }

      objects.delete(key);
    },

    buildPublicUrl(key: string): string {
      return `${publicBase}/${bucket}/${key.replace(/^\/+/, '')}`;
    },

    close(): void {
      history.push('close');
    },
  };
}
