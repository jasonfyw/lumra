import 'server-only';
import { after } from 'next/server';
import type { RateLimitRuleName } from '@lumra/config';
import type { Logger } from '@lumra/observability';
import { getPrincipals, type Principals } from '@/lib/actor';
import { getDb } from '@/lib/db';
import { serverEnv } from '@/lib/env';
import { assertSameOrigin } from '@/lib/origin';
import { getOriginalsBucket } from '@/lib/r2';
import { enforceRateLimit } from '@/lib/rate-limit';
import type { RouteScope } from '@/lib/route';
import { requirePrincipal, type UploadDeps } from './uploads';
import { kickWorkerRelay } from './worker-kick';

/**
 * Schedules the post-commit worker relay kick with Next's `after()`, so it runs once the response
 * has been sent. No-op unless both `WORKER_URL` and `WORKER_KICK_SECRET` are configured.
 */
export function scheduleRelayKick(log: Logger, requestId: string): void {
  const { WORKER_URL: workerUrl, WORKER_KICK_SECRET: secret } = serverEnv();
  if (!workerUrl || !secret) return;
  after(() => kickWorkerRelay({ workerUrl, secret, log, requestId }).then(() => undefined));
}

/**
 * Shared preamble for upload endpoints: origin check (mutations), credential resolution
 * (session user and/or guest capability cookie), and the per-principal rate limit.
 */
export async function uploadRequestContext(
  request: Request,
  scope: RouteScope,
  rule: RateLimitRuleName,
): Promise<{ principals: Principals; deps: UploadDeps }> {
  if (request.method !== 'GET') assertSameOrigin(request);
  const principals = await getPrincipals();
  requirePrincipal(principals);
  const subject = principals.user
    ? ({ kind: 'user', userId: principals.user.userId } as const)
    : ({ kind: 'guest', guestSessionId: principals.guest!.guestSessionId } as const);
  const db = getDb();
  await enforceRateLimit(request, rule, subject, { db, log: scope.log });
  return {
    principals,
    deps: {
      db,
      r2: getOriginalsBucket,
      log: scope.log,
      requestId: scope.requestId,
      kickRelay: () => scheduleRelayKick(scope.log, scope.requestId),
    },
  };
}

export const NO_STORE = { 'Cache-Control': 'no-store' } as const;
