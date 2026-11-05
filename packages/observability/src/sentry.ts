import { createRedactor, type Redactor } from './redact';

/**
 * SDK-agnostic Sentry helpers shared by `@sentry/nextjs` (web) and `@sentry/cloudflare`
 * (Workers). No Sentry import here: the scrubbers operate on plain event objects so this
 * package stays dependency-free.
 */

// Sentry events nest deeper and carry longer strings (stack frames) than log lines.
const sentryRedactor: Redactor = createRedactor({
  maxDepth: 16,
  maxStringLength: 16_384,
  maxArrayLength: 500,
});

/** SDK-internal fields that are not sent and may hold non-serializable objects. */
const PASSTHROUGH_KEYS = ['sdkProcessingMetadata'] as const;

/**
 * `beforeSend` scrubber: applies the log redaction policy to the whole event (headers,
 * cookies, query strings, request data, extras, breadcrumbs, exception messages, frame vars)
 * and drops user email / IP entirely.
 */
export function scrubSentryEvent<T>(event: T): T {
  if (event === null || typeof event !== 'object') return event;
  const source = event as Record<string, unknown>;
  const kept: Record<string, unknown> = {};
  const rest: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(source)) {
    if ((PASSTHROUGH_KEYS as readonly string[]).includes(key)) kept[key] = value;
    else rest[key] = value;
  }
  const request = rest.request as Record<string, unknown> | undefined;
  if (request && typeof request.query_string === 'string') {
    // Raw query strings have no leading `?`; scan them as one so the first param is covered.
    rest.request = {
      ...request,
      query_string: sentryRedactor.redactString(`?${request.query_string}`).slice(1),
    };
  }
  const scrubbed = sentryRedactor.redact(rest) as Record<string, unknown>;
  const user = scrubbed.user as Record<string, unknown> | undefined;
  if (user && typeof user === 'object') {
    delete user.ip_address;
    delete user.email;
  }
  return { ...scrubbed, ...kept } as T;
}

/** `beforeBreadcrumb` scrubber (console messages, fetch/XHR URLs, navigation). */
export function scrubSentryBreadcrumb<T>(breadcrumb: T): T {
  return sentryRedactor.redact(breadcrumb) as T;
}

export interface SentryBaseOptionsInput {
  dsn?: string | null;
  environment?: string | null;
  release?: string | null;
}

/**
 * Common SDK options. With no DSN the SDK is disabled and every capture call is a no-op,
 * which is the expected state in local dev and CI.
 */
export function sentryBaseOptions(input: SentryBaseOptionsInput) {
  const dsn = input.dsn?.trim() || undefined;
  return {
    dsn,
    enabled: Boolean(dsn),
    environment: input.environment?.trim() || undefined,
    release: input.release?.trim() || undefined,
    sendDefaultPii: false,
    // Errors only; request tracing is done with request IDs in logs (PRD §12).
    tracesSampleRate: 0,
    beforeSend: scrubSentryEvent,
    beforeSendTransaction: scrubSentryEvent,
    beforeBreadcrumb: scrubSentryBreadcrumb,
  };
}
