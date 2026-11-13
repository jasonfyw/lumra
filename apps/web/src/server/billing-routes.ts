import 'server-only';
import type { ApiError } from '@lumra/contracts';
import { billingRedirectRequestSchema } from '@lumra/contracts';
import { getAuthenticatedUser, type AuthenticatedUser } from '@/lib/actor';
import { ApiFailure } from '@/lib/api';
import { getDb } from '@/lib/db';
import { serverEnv } from '@/lib/env';
import { enforceRateLimit } from '@/lib/rate-limit';
import { crossOriginError, parseJsonBody, UNAUTHENTICATED } from '@/lib/request-guards';
import type { RouteScope } from '@/lib/route';
import type { BillingSessionDeps } from './billing-checkout';
import { getStripe } from './stripe';

export const BILLING_UNAVAILABLE: ApiError = {
  code: 'billing_unavailable',
  message: 'Payments are not available right now. Please try again later.',
  retryable: true,
};

/**
 * Shared preamble for the checkout/portal endpoints: same-origin check, verified user, empty JSON
 * body, per-user rate limit, then Stripe (absent ⇒ `billing_unavailable`, never a crash).
 */
export async function billingSessionContext(
  request: Request,
  scope: RouteScope,
): Promise<{ user: AuthenticatedUser; deps: BillingSessionDeps }> {
  const appUrl = serverEnv().NEXT_PUBLIC_APP_URL;
  const csrf = crossOriginError(request, appUrl);
  if (csrf) throw new ApiFailure(csrf);
  const user = await getAuthenticatedUser();
  if (!user) throw new ApiFailure(UNAUTHENTICATED);
  const body = await parseJsonBody(request, billingRedirectRequestSchema);
  if (!body.ok) throw new ApiFailure(body.error);
  const db = getDb();
  await enforceRateLimit(
    request,
    'billingSession',
    { kind: 'user', userId: user.userId },
    { db, log: scope.log },
  );
  const stripe = getStripe();
  if (!stripe) throw new ApiFailure(BILLING_UNAVAILABLE);
  return { user, deps: { db, stripe, appUrl: new URL(appUrl).origin } };
}
