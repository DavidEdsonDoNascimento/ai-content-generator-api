import { pino, type Logger, type LoggerOptions } from 'pino';

import { env } from './env.js';

/**
 * Opções do pino usadas pela instância de log do Fastify. Em desenvolvimento a
 * saída passa pelo `pino-pretty`; em qualquer outro ambiente o log é JSON puro,
 * que é o formato esperado por coletores.
 */
export const loggerOptions: LoggerOptions = {
  level: env.LOG_LEVEL,
  redact: {
    paths: ['req.headers.authorization', 'req.headers.cookie', 'res.headers["set-cookie"]'],
    remove: true,
  },
  ...(env.NODE_ENV === 'development'
    ? {
        transport: {
          target: 'pino-pretty',
          options: {
            translateTime: 'SYS:HH:MM:ss.l',
            ignore: 'pid,hostname',
          },
        },
      }
    : {}),
};

/**
 * Instância de log para o que roda **fora** de uma requisição HTTP: o Worker, os
 * *composition roots* e os avisos de operação best-effort dos services.
 *
 * O Fastify constrói a sua a partir de `loggerOptions`, e não recebe esta —
 * passar a instância pronta faz o tipo do logger da aplicação deixar de ser
 * `FastifyBaseLogger`, o que estoura sob `exactOptionalPropertyTypes` e obrigaria
 * a um cast. Como as duas nascem das mesmas opções, o formato e o destino são os
 * mesmos; o que a de requisição tem a mais é o `reqId`, que só existe lá.
 */
export const logger: Logger = pino(loggerOptions);
