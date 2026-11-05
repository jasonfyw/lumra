import * as Sentry from '@sentry/nextjs';

export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { serverEnv } = await import('./lib/env');
    serverEnv();
  }

  if (process.env.NEXT_RUNTIME === 'nodejs' || process.env.NEXT_RUNTIME === 'edge') {
    const { serverSentryOptions } = await import('./lib/sentry');
    const options = serverSentryOptions();
    // No DSN (dev/CI): skip init entirely so nothing is instrumented or sent.
    if (options.enabled) Sentry.init(options);
  }
}

/** Errors Next.js catches itself (Server Components, actions, route handlers that throw). */
export const onRequestError = Sentry.captureRequestError;
