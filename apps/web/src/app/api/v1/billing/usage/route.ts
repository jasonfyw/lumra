import { getAuthenticatedUser } from '@/lib/actor';
import { fail, ok } from '@/lib/api';
import { getDb } from '@/lib/db';
import { NO_STORE, UNAUTHENTICATED } from '@/lib/request-guards';
import { withRoute } from '@/lib/route';
import { getAccountUsageSummary } from '@/server/account';

export const dynamic = 'force-dynamic';

/**
 * Owner usage summary (PRD §10 `GET /api/v1/billing/usage`, FR-N03). Read-only; the spending-cap
 * PATCH arrives with T32. Always the signed-in user's own account — there is no account parameter.
 */
export const GET = withRoute('GET /api/v1/billing/usage', async (_request, { requestId }) => {
  const user = await getAuthenticatedUser();
  if (!user) return fail(UNAUTHENTICATED, requestId, { headers: NO_STORE });
  const summary = await getAccountUsageSummary(getDb(), user);
  return ok(summary, requestId, { headers: NO_STORE });
});
