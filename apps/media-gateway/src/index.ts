import { mediaGatewayEnvSchema, parseEnv } from '@lumra/config';

export interface Env {
  APP_ORIGIN: string;
  MEDIA_TOKEN_SECRET?: string;
  SENTRY_DSN?: string;
  ORIGINALS: R2Bucket;
  DERIVATIVES: R2Bucket;
  ARCHIVES: R2Bucket;
}

/**
 * Media gateway entry point. Until T20 lands, every media request fails closed:
 * there is deliberately no code path that reads from R2 without token verification.
 */
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    parseEnv('media-gateway', mediaGatewayEnvSchema, env as unknown as Record<string, unknown>);
    const url = new URL(request.url);

    if (url.pathname === '/health') {
      return Response.json({ status: 'ok' }, { headers: { 'Cache-Control': 'no-store' } });
    }

    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response('Method Not Allowed', { status: 405, headers: { Allow: 'GET, HEAD' } });
    }

    return new Response('Unauthorized', { status: 401, headers: { 'Cache-Control': 'no-store' } });
  },
} satisfies ExportedHandler<Env>;
