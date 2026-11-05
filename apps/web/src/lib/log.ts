import { createLogger, parseLogLevel } from '@lumra/observability';

/**
 * Process-wide structured logger for the web runtime. Read `process.env` directly (not
 * `serverEnv()`) so this module stays importable from Edge code and unit tests.
 */
export const logger = createLogger({
  service: 'web',
  level: parseLogLevel(process.env.LOG_LEVEL),
  production: process.env.NODE_ENV === 'production',
});
