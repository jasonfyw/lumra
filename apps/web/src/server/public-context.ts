import 'server-only';
import { cookies } from 'next/headers';
import type { RateLimitRuleName } from '@lumra/config';
import { getDb } from '@/lib/db';
import { requireEnv } from '@/lib/env';
import { GALLERY_SESSION_COOKIE } from '@/lib/gallery-session';
import { clientIp, enforceRateLimit } from '@/lib/rate-limit';
import type { RouteScope } from '@/lib/route';
import type { MintDeps } from './public-gallery';

/**
 * Recipient responses are per-viewer (password sessions, short-lived URLs): never cached by
 * browsers or shared caches (PRD §6.1 "never cache protected HTML or decisions across users").
 */
export const PRIVATE_NO_STORE = { 'Cache-Control': 'private, no-store' } as const;

/** Signing key = first keyring entry; URLs point at the media gateway (ADR-001). */
export function mintDeps(): Omit<MintDeps, 'now'> {
  return {
    keyring: requireEnv('MEDIA_TOKEN_SECRET'),
    mediaBaseUrl: requireEnv('NEXT_PUBLIC_MEDIA_URL'),
  };
}

/** The gallery session cookie (path-scoped to this gallery, so at most one is sent). */
export async function gallerySessionToken(): Promise<string | undefined> {
  return (await cookies()).get(GALLERY_SESSION_COOKIE)?.value;
}

/** Per-IP rate limit for public endpoints; returns the DB handle for the handler. */
export async function publicRequestContext(
  request: Request,
  scope: RouteScope,
  rule: RateLimitRuleName,
) {
  const db = getDb();
  await enforceRateLimit(
    request,
    rule,
    { kind: 'ip', ip: clientIp(request.headers) },
    { db, log: scope.log },
  );
  return { db };
}
