/**
 * Contrato do job de geração de conteúdo.
 *
 * O payload é **mínimo de propósito** (ADR-007): só o `contentId`. Tudo o mais
 * — `topic`, `userId`, status — é lido do banco no momento do processamento.
 * Carregar o `topic` no job pareceria uma economia de consulta, mas cria um dado
 * que pode envelhecer entre a publicação e a execução, e um job que sobrevive na
 * fila depois de o conteúdo ser cancelado passaria a carregar uma versão dos
 * fatos que o banco já desmentiu.
 */
export interface ContentJobData {
  readonly contentId: string;
}

/** Nome estável da fila. Mudá-lo abandona os jobs pendentes da fila anterior. */
export const CONTENT_QUEUE_NAME = 'content-generation';

/** Nome do job dentro da fila. Só aparece em logs e no painel. */
export const CONTENT_JOB_NAME = 'generate-content';
