import * as Sentry from '@sentry/cloudflare';
import { mediaGatewayEnvSchema, parseEnv, type MediaGatewayEnv } from '@lumra/config';
import {
  createLogger,
  generateRequestId,
  healthPayload,
  isValidRequestId,
  REQUEST_ID_HEADER,
  sentryBaseOptions,
  type Logger,
} from '@lumra/observability';
import { createKvGalleryAccessStore, type GalleryAccessStore } from '@lumra/tokens';
import { handleMediaRequest, type GatewayDeps } from './handler';
import { corsHeaders } from './http';

export interface Env {
  /** Comma-separated allowed CORS origins. */
  APP_ORIGIN: string;
  /** Verification keyring `kid:secret[,kid:secret]` (ADR-001). Secret. */
  MEDIA_TOKEN_SECRET: string;
  SENTRY_DSN?: string;
  SENTRY_ENVIRONMENT?: string;
  LOG_LEVEL?: string;
  /** Deployed git SHA, e.g. `wrangler deploy --var COMMIT_SHA:$GITHUB_SHA`. */
  COMMIT_SHA?: string;
  ORIGINALS: R2Bucket;
  DERIVATIVES: R2Bucket;
  ARCHIVES: R2Bucket;
  /** Gallery access state mirrored by the web app (`gallery:{id}`). */
  ACCESS_STATE: KVNamespace;
}

// Per-isolate caches: parsed env and the KV store (whose ≤5 s memo must outlive a request).
const parsedEnvCache = new WeakMap<Env, MediaGatewayEnv>();
const storeCache = new WeakMap<KVNamespace, GalleryAccessStore>();

function loadEnv(env: Env): MediaGatewayEnv {
  let parsed = parsedEnvCache.get(env);
  if (!parsed) {
    parsed = parseEnv(
      'media-gateway',
      mediaGatewayEnvSchema,
      env as unknown as Record<string, unknown>,
    );
    parsedEnvCache.set(env, parsed);
  }
  return parsed;
}

function accessStore(kv: KVNamespace): GalleryAccessStore {
  let store = storeCache.get(kv);
  if (!store) {
    store = createKvGalleryAccessStore(kv);
    storeCache.set(kv, store);
  }
  return store;
}

const noStore = (status: number, body: string, headers?: HeadersInit) => {
  const h = new Headers(headers);
  h.set('Cache-Control', 'no-store');
  h.set('Content-Type', 'text/plain; charset=utf-8');
  return new Response(body, { status, headers: h });
};

/** Valid inbound `x-request-id`, else Cloudflare's `cf-ray`, else a fresh UUID. */
function requestIdFor(request: Request): string {
  const inbound = request.headers.get(REQUEST_ID_HEADER)?.trim();
  if (isValidRequestId(inbound)) return inbound;
  const ray = request.headers.get('cf-ray')?.trim();
  return isValidRequestId(ray) ? ray : generateRequestId();
}

function report(error: unknown, requestId: string) {
  Sentry.withScope((scope) => {
    scope.setTag('requestId', requestId);
    Sentry.captureException(error);
  });
}

function withRequestId(response: Response, requestId: string): Response {
  try {
    response.headers.set(REQUEST_ID_HEADER, requestId);
    return response;
  } catch {
    const copy = new Response(response.body, response);
    copy.headers.set(REQUEST_ID_HEADER, requestId);
    return copy;
  }
}

async function route(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  requestId: string,
  log: Logger,
): Promise<Response> {
  const url = new URL(request.url);

  if (url.pathname === '/health') {
    // Sanitized liveness (T04): status, service and short commit SHA only.
    return Response.json(healthPayload('media-gateway', env.COMMIT_SHA), {
      headers: { 'Cache-Control': 'no-store' },
    });
  }

  let config: MediaGatewayEnv;
  try {
    config = loadEnv(env);
    if (!env.ORIGINALS || !env.DERIVATIVES || !env.ARCHIVES || !env.ACCESS_STATE) {
      throw new Error('missing binding');
    }
  } catch (error) {
    // Misconfiguration fails closed without revealing which setting is wrong.
    log.error('gateway misconfigured', {
      error: error instanceof Error ? error.name : 'unknown',
    });
    report(error, requestId);
    return noStore(503, 'Service Unavailable');
  }

  if (!url.pathname.startsWith('/m/')) return noStore(404, 'Not Found');

  if (request.method === 'OPTIONS') {
    const headers = corsHeaders(request.headers.get('Origin'), config.APP_ORIGIN);
    if (headers.has('Access-Control-Allow-Origin')) {
      headers.set('Access-Control-Allow-Methods', 'GET, HEAD');
      headers.set('Access-Control-Allow-Headers', 'Range, If-None-Match, If-Range');
      headers.set('Access-Control-Max-Age', '600');
    }
    headers.set('Cache-Control', 'no-store');
    return new Response(null, { status: 204, headers });
  }

  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return noStore(405, 'Method Not Allowed', { Allow: 'GET, HEAD, OPTIONS' });
  }

  const deps: GatewayDeps = {
    keyring: config.MEDIA_TOKEN_SECRET,
    accessStore: accessStore(env.ACCESS_STATE),
    buckets: { originals: env.ORIGINALS, derivatives: env.DERIVATIVES, archives: env.ARCHIVES },
    allowedOrigins: config.APP_ORIGIN,
    now: () => new Date(),
    log: (level, msg, fields) => log[level](msg, fields),
  };

  try {
    return await handleMediaRequest(request, deps, requestId);
  } catch (error) {
    // R2 or runtime failure: generic, uncacheable, details only in structured logs.
    log.error('media request failed', {
      error: error instanceof Error ? error.name : 'unknown',
    });
    report(error, requestId);
    return noStore(503, 'Service Unavailable');
  }
}

/**
 * Media gateway (PRD §6.1, ADR-001): the only read path into the private R2 buckets.
 * `GET|HEAD /m/:token` — verify token → check gallery access state → stream from R2.
 *
 * T04 layer: request ID (echoed as `x-request-id` on every response), shared redacting
 * logger, Sentry via `withSentry`. Request paths are never logged (they carry tokens).
 */
export const gateway = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const requestId = requestIdFor(request);
    const log = createLogger({
      service: 'media-gateway',
      level: env.LOG_LEVEL,
      production: env.SENTRY_ENVIRONMENT === 'production',
      base: { requestId },
    });
    return withRequestId(await route(request, env, ctx, requestId, log), requestId);
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
