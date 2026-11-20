import { ok } from '@/lib/api';
import { NO_STORE } from '@/lib/request-guards';
import { withRoute } from '@/lib/route';
import { createPortalSession } from '@/server/billing-checkout';
import { billingSessionContext, rethrowStripeError } from '@/server/billing-routes';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * `POST /api/v1/billing/portal` (PRD §10, T29): a Stripe Billing Portal URL for the signed-in
 * owner's own customer (payment method, invoices, cancellation). 409 without a customer yet.
 */
export const POST = withRoute('POST /api/v1/billing/portal', async (request, scope) => {
  const { user, deps } = await billingSessionContext(request, scope);
  try {
    const session = await createPortalSession(deps, user);
    scope.log.info('portal session created', { accountId: user.userId });
    return ok(session, scope.requestId, { headers: NO_STORE });
  } catch (error) {
    rethrowStripeError(error, scope, 'portal');
  }
});
