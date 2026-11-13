import { ApiFailure, ok } from '@/lib/api';
import { NO_STORE } from '@/lib/request-guards';
import { withRoute } from '@/lib/route';
import { createCheckoutSession } from '@/server/billing-checkout';
import {
  BILLING_UNAVAILABLE,
  billingSessionContext,
  rethrowStripeError,
} from '@/server/billing-routes';
import { StripeCatalogError } from '@/server/stripe';

export const dynamic = 'force-dynamic';
// The Stripe SDK runs on Node (T29).
export const runtime = 'nodejs';

/**
 * `POST /api/v1/billing/checkout` (PRD §10, T29): a Stripe Checkout URL for Pro. Entitlements do
 * not change here or on the success redirect — only the signed webhook grants Pro (T30).
 */
export const POST = withRoute('POST /api/v1/billing/checkout', async (request, scope) => {
  const { user, deps } = await billingSessionContext(request, scope);
  try {
    const session = await createCheckoutSession(deps, user);
    scope.log.info('checkout session created', { accountId: user.userId });
    return ok(session, scope.requestId, { headers: NO_STORE });
  } catch (error) {
    if (error instanceof StripeCatalogError) {
      // Operator error (setup script not run in this Stripe mode): names lookup keys only.
      scope.log.error('stripe catalog incomplete', { missing: error.missing });
      throw new ApiFailure(BILLING_UNAVAILABLE);
    }
    rethrowStripeError(error, scope, 'checkout');
  }
});
