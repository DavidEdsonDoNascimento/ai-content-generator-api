import type { LoggerOptions } from 'pino';

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
