import { createLogger, type Logger } from '@lumra/observability';
import type { Env } from './env';

export type { Logger } from '@lumra/observability';

/** Structured JSON logger (T04). Never log tokens, signed URLs, filenames or object bytes. */
export function loggerFor(env: Pick<Env, 'LOG_LEVEL' | 'SENTRY_ENVIRONMENT'>): Logger {
  return createLogger({
    service: 'worker',
    level: env.LOG_LEVEL,
    production: env.SENTRY_ENVIRONMENT === 'production',
  });
}

/** Logger that drops everything; for unit tests. */
export const silentLogger: Logger = createLogger({ service: 'worker', sink: () => {} });
