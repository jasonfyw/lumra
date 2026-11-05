import { mediaGatewayEnvSchema, parseEnv, type MediaGatewayEnv } from '@lumra/config';
import type { QueueMessage } from '@lumra/contracts';
import { createKvGalleryAccessStore, type GalleryAccessStore } from '@lumra/tokens';
import { handleMediaRequest, type GatewayDeps } from './handler';
import { corsHeaders } from './http';

export interface Env {
  /** Comma-separated allowed CORS origins. */
  APP_ORIGIN: string;
  /** Verification keyring `kid:secret[,kid:secret]` (ADR-001). Secret. */
  MEDIA_TOKEN_SECRET: string;
  SENTRY_DSN?: string;
  ORIGINALS: R2Bucket;
  DERIVATIVES: R2Bucket;
  ARCHIVES: R2Bucket;
  /** Gallery access state mirrored by the web app (`gallery:{id}`). */
  ACCESS_STATE: KVNamespace;
  /** Producer for `delivery.served` usage events. */
  USAGE: Queue<QueueMessage>;
}

function log(level: 'info' | 'warn' | 'error', msg: string, fields: Record<string, unknown> = {}) {
  const sink = { info: console.info, warn: console.warn, error: console.error }[level];
  sink(JSON.stringify({ level, msg, service: 'media-gateway', ...fields }));
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

/**
 * Media gateway (PRD §6.1, ADR-001): the only read path into the private R2 buckets.
 * `GET|HEAD /m/:token` — verify token → check gallery access state → stream from R2.
 */
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const requestId = request.headers.get('cf-ray') ?? crypto.randomUUID();

    if (url.pathname === '/health') {
      return Response.json({ status: 'ok' }, { headers: { 'Cache-Control': 'no-store' } });
    }

    let config: MediaGatewayEnv;
    try {
      config = loadEnv(env);
      if (!env.ORIGINALS || !env.DERIVATIVES || !env.ARCHIVES || !env.ACCESS_STATE || !env.USAGE) {
        throw new Error('missing binding');
      }
    } catch (error) {
      // Misconfiguration fails closed without revealing which setting is wrong.
      log('error', 'gateway misconfigured', {
        requestId,
        error: error instanceof Error ? error.name : 'unknown',
      });
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
      usage: env.USAGE,
      allowedOrigins: config.APP_ORIGIN,
      now: () => new Date(),
      waitUntil: (promise) => ctx.waitUntil(promise),
      log,
    };

    try {
      return await handleMediaRequest(request, deps, requestId);
    } catch (error) {
      // R2 or runtime failure: generic, uncacheable, details only in structured logs.
      log('error', 'media request failed', {
        requestId,
        error: error instanceof Error ? error.name : 'unknown',
      });
      return noStore(503, 'Service Unavailable');
    }
  },
} satisfies ExportedHandler<Env>;
