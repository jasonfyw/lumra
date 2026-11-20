import { eq } from 'drizzle-orm';
import { updateAccountRequestSchema, type UpdateAccountResponse } from '@lumra/contracts';
import { profiles } from '@lumra/db';
import { getAuthenticatedUser } from '@/lib/actor';
import { fail, ok } from '@/lib/api';
import { getDb } from '@/lib/db';
import { serverEnv } from '@/lib/env';
import { enforceRateLimit } from '@/lib/rate-limit';
import { NO_STORE, UNAUTHENTICATED, crossOriginError, parseJsonBody } from '@/lib/request-guards';
import { withRoute } from '@/lib/route';

export const dynamic = 'force-dynamic';

/**
 * `PATCH /api/v1/account`: the signed-in user sets their display name (`profiles.display_name`).
 * Trimmed, at most 80 characters; a blank name clears it. The target is always the session's own
 * profile: there is no user id in the request, so one user cannot change another's name. The name
 * is shown in the browser-tab title of that user's public galleries.
 */
export const PATCH = withRoute('PATCH /api/v1/account', async (request, { requestId, log }) => {
  const csrf = crossOriginError(request, serverEnv().NEXT_PUBLIC_APP_URL);
  if (csrf) return fail(csrf, requestId);
  const user = await getAuthenticatedUser();
  if (!user) return fail(UNAUTHENTICATED, requestId, { headers: NO_STORE });
  const body = await parseJsonBody(request, updateAccountRequestSchema);
  if (!body.ok) return fail(body.error, requestId);

  const db = getDb();
  await enforceRateLimit(
    request,
    'accountSettings',
    { kind: 'user', userId: user.userId },
    { db, log },
  );
  await db
    .update(profiles)
    .set({ displayName: body.data.name })
    .where(eq(profiles.userId, user.userId));
  log.info('account name updated', { accountId: user.userId, cleared: body.data.name === null });
  const data: UpdateAccountResponse = { name: body.data.name };
  return ok(data, requestId, { headers: NO_STORE });
});
