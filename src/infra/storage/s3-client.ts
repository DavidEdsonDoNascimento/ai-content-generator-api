import { S3Client } from '@aws-sdk/client-s3';

/**
 * Cliente S3 apontado para o Minio.
 *
 * Criado por **factory**, nunca no topo do módulo: importar este arquivo não
 * pode instanciar cliente nem abrir socket, senão um teste unitário passaria a
 * depender de credenciais e de rede. Quem constrói é o composition root do
 * Worker — o único processo que faz upload.
 */

export interface S3ClientConfig {
  /** Endereço **interno** (`http://minio:9000` no Compose). Nunca vai para o banco. */
  readonly endpoint: string;
  readonly region: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
}

export function createS3Client(config: S3ClientConfig): S3Client {
  return new S3Client({
    endpoint: config.endpoint,
    region: config.region,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
    // Minio serve `{endpoint}/{bucket}/{key}`; o padrão do SDK é virtual-hosted
    // (`{bucket}.{endpoint}`), que exigiria DNS por bucket. Manter path-style é
    // também o que faz a URL pública montada por `buildPublicUrl` bater com o
    // caminho real do objeto.
    forcePathStyle: true,
  });
}
