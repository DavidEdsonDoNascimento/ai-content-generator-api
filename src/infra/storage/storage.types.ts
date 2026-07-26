/**
 * Contrato de storage que o Worker conhece.
 *
 * Pequeno de propósito: três operações e um fechamento. Não é uma porta de
 * arquitetura hexagonal — é o mínimo que o processor precisa, e que um duplo em
 * memória consegue implementar sem cerimônia (ADR-011). O tipo existe porque há
 * **duas** implementações de verdade (S3 real e fake dos testes), não por
 * princípio.
 */

export interface UploadInput {
  readonly key: string;
  readonly body: Uint8Array;
  readonly contentType: string;
}

export interface StorageService {
  /** Grava o objeto. Lança em falha — o processor classifica como `UPLOAD_FAILED`. */
  upload(input: UploadInput): Promise<void>;

  /**
   * Remove o objeto. Usada **apenas** na limpeza de órfão, e chamada de dentro
   * de um bloco best-effort: o `DeleteObject` do S3 é idempotente (remover chave
   * inexistente não é erro), o que torna a limpeza segura de repetir.
   */
  remove(key: string): Promise<void>;

  /**
   * URL **pública** do objeto — a que vai para `Content.fileUrl` e precisa abrir
   * no navegador. Nunca deriva do endpoint interno (ADR-009).
   */
  buildPublicUrl(key: string): string;

  /** Libera sockets e agentes HTTP no encerramento do processo. */
  close(): void;
}
