import { OTLPLogExporter } from '@opentelemetry/exporter-logs-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { BatchLogRecordProcessor, LoggerProvider } from '@opentelemetry/sdk-logs';
import * as Sentry from '@sentry/nextjs';

const posthogToken = process.env.NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN;
const posthogHost = process.env.NEXT_PUBLIC_POSTHOG_HOST;
const posthogLogProcessors =
  posthogToken && posthogHost
    ? [
        new BatchLogRecordProcessor({
          exporter: new OTLPLogExporter({
            url: new URL('/i/v1/logs', posthogHost).toString(),
            headers: {
              Authorization: `Bearer ${posthogToken}`,
              'Content-Type': 'application/json',
            },
            timeoutMillis: 2_000,
          }),
        }),
      ]
    : [];

// This provider is intentionally not global: only posthogLogLogger emits to PostHog.
export const posthogLogProvider = new LoggerProvider({
  resource: resourceFromAttributes({ 'service.name': 'lumra-web' }),
  processors: posthogLogProcessors,
});
export const posthogLogLogger = posthogLogProvider.getLogger('lumra.posthog');

export async function flushPostHogLogs() {
  await posthogLogProvider.forceFlush().catch(() => undefined);
}

let shutdownHandlerRegistered = false;

export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { serverEnv } = await import('./lib/env');
    serverEnv();

    if (!posthogToken || !posthogHost) {
      if (process.env.NODE_ENV !== 'production') {
        const missingVariable = posthogToken
          ? 'NEXT_PUBLIC_POSTHOG_HOST'
          : 'NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN';
        console.warn(
          `${missingVariable} variable required by PostHog is missing or un-configured, this causes events to be silently missed. This error stops appearing once ${missingVariable} is configured`,
        );
      }
    } else if (!shutdownHandlerRegistered) {
      shutdownHandlerRegistered = true;
      const flushLogs = () => void posthogLogProvider.shutdown().catch(() => undefined);
      process.once('SIGINT', flushLogs);
      process.once('SIGTERM', flushLogs);
    }
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
