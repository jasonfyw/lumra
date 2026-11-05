import * as Sentry from '@sentry/nextjs';
import { sentryBaseOptions } from '@lumra/observability';

/**
 * Server/Edge SDK options. Without `SENTRY_DSN` (local dev, CI) `enabled` is false and
 * `instrumentation.ts` skips `Sentry.init` entirely, so every capture is a no-op.
 */
export function serverSentryOptions() {
  return sentryBaseOptions({
    dsn: process.env.SENTRY_DSN,
    environment: process.env.SENTRY_ENVIRONMENT ?? process.env.VERCEL_ENV ?? process.env.NODE_ENV,
    release: process.env.VERCEL_GIT_COMMIT_SHA,
  });
}

/** Reports an error caught by our own code (e.g. `withRoute`), tagged for log correlation. */
export function reportError(error: unknown, tags: { requestId: string; route?: string }) {
  Sentry.withScope((scope) => {
    scope.setTag('requestId', tags.requestId);
    if (tags.route) scope.setTag('route', tags.route);
    Sentry.captureException(error);
  });
}
