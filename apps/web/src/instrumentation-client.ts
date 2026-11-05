import * as Sentry from '@sentry/nextjs';
import { sentryBaseOptions } from '@lumra/observability';

// Browser SDK. `NEXT_PUBLIC_SENTRY_DSN` is inlined at build time; when it is absent the SDK
// is never initialised. Release is injected by `withSentryConfig` during source map upload.
const options = sentryBaseOptions({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
  environment: process.env.NEXT_PUBLIC_SENTRY_ENVIRONMENT ?? process.env.NEXT_PUBLIC_VERCEL_ENV,
});

if (options.enabled) Sentry.init(options);

export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
