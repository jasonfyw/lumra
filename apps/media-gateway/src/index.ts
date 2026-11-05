import * as Sentry from '@sentry/cloudflare';
import { mediaGatewayEnvSchema, parseEnv } from '@lumra/config';
import {
  createLogger,
  healthPayload,
  REQUEST_ID_HEADER,
  resolveRequestId,
  sentryBaseOptions,
} from '@lumra/observability';

export interface Env {
  APP_ORIGIN: string;
  MEDIA_TOKEN_SECRET?: string;
  SENTRY_DSN?: string;
  SENTRY_ENVIRONMENT?: string;
  LOG_LEVEL?: string;
  /** Deployed git SHA, e.g. `wrangler deploy --var COMMIT_SHA:$GITHUB_SHA`. */
  COMMIT_SHA?: string;
  ORIGINALS: R2Bucket;
  DERIVATIVES: R2Bucket;
  ARCHIVES: R2Bucket;
}

/**
 * Media gateway entry point. Until T20 lands, every media request fails closed:
 * there is deliberately no code path that reads from R2 without token verification.
 *
 * Request paths are never logged: they identify objects and may carry tokens (PRD §6.2).
 */
export const gateway = {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const requestId = resolveRequestId(request);
    const log = createLogger({
      service: 'media-gateway',
      level: env.LOG_LEVEL,
      production: env.SENTRY_ENVIRONMENT === 'production',
      base: { requestId },
    });
    const noStore = { 'Cache-Control': 'no-store', [REQUEST_ID_HEADER]: requestId };

    try {
      parseEnv('media-gateway', mediaGatewayEnvSchema, env as unknown as Record<string, unknown>);
    } catch (error) {
      // Misconfiguration: fail closed, report, never reveal which variable is wrong.
      log.error('invalid environment', { err: error });
      Sentry.withScope((scope) => {
        scope.setTag('requestId', requestId);
        Sentry.captureException(error);
      });
      return new Response('Service Unavailable', { status: 503, headers: noStore });
    }

    const url = new URL(request.url);

    if (url.pathname === '/health') {
      return Response.json(healthPayload('media-gateway', env.COMMIT_SHA), { headers: noStore });
    }

    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response('Method Not Allowed', {
        status: 405,
        headers: { Allow: 'GET, HEAD', [REQUEST_ID_HEADER]: requestId },
      });
    }

    log.debug('media request denied', {
      method: request.method,
      status: 401,
      reason: 'no_token_verifier',
    });
    return new Response('Unauthorized', { status: 401, headers: noStore });
  },
} satisfies ExportedHandler<Env>;

/** No `SENTRY_DSN` (dev/CI): returning undefined leaves the SDK uninitialised. */
export function sentryOptions(env: Env) {
  const options = sentryBaseOptions({
    dsn: env.SENTRY_DSN,
    environment: env.SENTRY_ENVIRONMENT,
    release: env.COMMIT_SHA,
  });
  return options.enabled ? options : undefined;
}

export default Sentry.withSentry<Env, unknown, unknown, typeof gateway>(sentryOptions, gateway);
