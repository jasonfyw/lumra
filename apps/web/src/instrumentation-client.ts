import * as Sentry from '@sentry/nextjs';
import { sentryBaseOptions } from '@lumra/observability';
import posthog from 'posthog-js';

// Browser SDK. `NEXT_PUBLIC_SENTRY_DSN` is inlined at build time; when it is absent the SDK
// is never initialised. Release is injected by `withSentryConfig` during source map upload.
const options = sentryBaseOptions({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
  environment: process.env.NEXT_PUBLIC_SENTRY_ENVIRONMENT ?? process.env.NEXT_PUBLIC_VERCEL_ENV,
});

if (options.enabled) Sentry.init(options);

const posthogToken = process.env.NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN;
const posthogHost = process.env.NEXT_PUBLIC_POSTHOG_HOST;

if (posthogToken && posthogHost) {
  posthog.init(posthogToken, {
    api_host: posthogHost,
    capture_exceptions: true,
    defaults: '2025-05-24',
    debug: process.env.NODE_ENV === 'development',
  });
} else if (process.env.NODE_ENV === 'development') {
  const missingVariable = posthogToken
    ? 'NEXT_PUBLIC_POSTHOG_HOST'
    : 'NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN';
  console.error(
    `${missingVariable} variable required by PostHog is missing or un-configured, this causes events to be silently missed. This error stops appearing once ${missingVariable} is configured`,
  );
}

export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
