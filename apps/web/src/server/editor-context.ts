import 'server-only';
import type { ZodType } from 'zod';
import { getActor } from '@/lib/actor';
import { ApiFailure } from '@/lib/api';
import { getDb } from '@/lib/db';
import { serverEnv } from '@/lib/env';
import { assertSameOrigin } from '@/lib/origin';
import { parseJsonBody } from '@/lib/request-guards';
import type { RouteScope } from '@/lib/route';
import type { EditorDeps } from './gallery-editor';

export const NO_STORE = { 'Cache-Control': 'no-store' } as const;

/**
 * Shared preamble for the owner-only gallery editor endpoints (T15/T16/T19): origin check on
 * mutations (PRD §6.2), then a verified Supabase user. A guest capability is not enough — guests
 * sign in (and claim their draft) before they can edit settings or publish (J1) — so guests and
 * anonymous callers get 401. Ownership is checked per gallery (concealed 404).
 */
export async function editorRequestContext(
  request: Request,
  scope: RouteScope,
): Promise<{ userId: string; deps: EditorDeps }> {
  if (request.method !== 'GET') assertSameOrigin(request);
  const actor = await getActor();
  if (actor.kind !== 'user') {
    throw new ApiFailure({
      code: 'unauthenticated',
      message:
        actor.kind === 'guest'
          ? 'Sign in to publish or change this gallery’s settings.'
          : 'Sign in to continue.',
      retryable: false,
    });
  }
  return {
    userId: actor.userId,
    deps: {
      db: getDb(),
      log: scope.log,
      requestId: scope.requestId,
      appUrl: serverEnv().NEXT_PUBLIC_APP_URL,
    },
  };
}

/** JSON-only body parsing (non-JSON content types are refused, forcing a CORS preflight). */
export async function readJsonBody<T>(request: Request, schema: ZodType<T>): Promise<T> {
  const parsed = await parseJsonBody(request, schema);
  if (!parsed.ok) throw new ApiFailure(parsed.error);
  return parsed.data;
}
