import { DeleteObjectCommand, PutObjectCommand, type S3Client } from '@aws-sdk/client-s3';

import type { StorageService, UploadInput } from './storage.types.js';

/**
 * Implementação sobre o S3/Minio.
 *
 * O ponto delicado desta classe não é o upload — é a **URL**. O Worker fala com
 * o storage por um endereço (`endpoint`, interno à rede do Compose) e persiste
 * outro (`publicBaseUrl`, o que abre no navegador). Os dois nunca se cruzam
 * aqui: `buildPublicUrl` só conhece o público, e o `S3Client` só conhece o
 * interno. Essa separação física é o que impede o erro clássico de gravar
 * `http://minio:9000/...` no banco e entregar ao cliente um link que não resolve
 * fora do Docker (ADR-009).
 */

export interface StorageServiceConfig {
  readonly client: S3Client;
  readonly bucket: string;
  /** Base pública, sem o bucket. Barras finais são normalizadas. */
  readonly publicBaseUrl: string;
}

/** `contents/{contentId}.txt` — determinística, o que torna o retry idempotente. */
export function buildContentKey(contentId: string): string {
  // O `contentId` já é um UUID validado pelo Zod na rota, mas a chave compõe uma
  // URL e um caminho no bucket: recusar qualquer coisa fora do formato fecha a
  // porta para `..`, barra e caractere de escape chegarem até aqui por um
  // caminho que ainda não existe.
  if (!/^[0-9a-fA-F-]{36}$/.test(contentId)) {
    throw new Error('contentId inválido para compor a chave do objeto.');
  }

  return `contents/${contentId}.txt`;
}

export function createStorageService(config: StorageServiceConfig): StorageService {
  const publicBase = config.publicBaseUrl.replace(/\/+$/, '');

  return {
    async upload(input: UploadInput): Promise<void> {
      await config.client.send(
        new PutObjectCommand({
          Bucket: config.bucket,
          Key: input.key,
          Body: input.body,
          ContentType: input.contentType,
        }),
      );
    },

    async remove(key: string): Promise<void> {
      await config.client.send(new DeleteObjectCommand({ Bucket: config.bucket, Key: key }));
    },

    buildPublicUrl(key: string): string {
      // Path-style, batendo com o `forcePathStyle` do cliente. As barras são
      // normalizadas nas duas pontas para a URL não sair com `//`.
      return `${publicBase}/${config.bucket}/${key.replace(/^\/+/, '')}`;
    },

    close(): void {
      config.client.destroy();
    },
  };
}
