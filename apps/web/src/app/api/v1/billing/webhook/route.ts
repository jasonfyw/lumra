import { fail, ok } from '@/lib/api';
import { getDb } from '@/lib/db';
import { serverEnv } from '@/lib/env';
import { NO_STORE, validation } from '@/lib/request-guards';
import { withRoute } from '@/lib/route';
import { reevaluateSpendAlerts } from '@/server/billing-state';
import { handleStripeEvent, recordFailedEvent } from '@/server/billing-webhook';
import { BILLING_UNAVAILABLE } from '@/server/billing-routes';
import { getStripe } from '@/server/stripe';

export const dynamic = 'force-dynamic';
// Raw-body signature verification with the Stripe SDK needs the Node runtime.
export const runtime = 'nodejs';

/** Webhook bodies are small JSON; refuse anything absurd before hashing it. */
const MAX_BODY_BYTES = 512 * 1024;

/**
 * `POST /api/v1/billing/webhook` (PRD §9.5, T29). The signature is verified against the **raw**
 * body (`request.text()`, never re-serialised JSON) with `STRIPE_WEBHOOK_SECRET`; anything
 * unsigned or stale is a 400 and is never parsed further. A replayed event is a no-op (G-06).
 * Unconfigured ⇒ 503 so Stripe keeps retrying until the secret is set.
 */
export const POST = withRoute(
  'POST /api/v1/billing/webhook',
  async (request, { requestId, log }) => {
    const stripe = getStripe();
    const secret = serverEnv().STRIPE_WEBHOOK_SECRET;
    if (!stripe || !secret) {
      log.warn('stripe webhook received but billing is not configured');
      return fail(BILLING_UNAVAILABLE, requestId, { headers: NO_STORE });
    }
    const signature = request.headers.get('stripe-signature');
    const body = await request.text();
    if (!signature || body.length > MAX_BODY_BYTES) {
      return fail(validation('Invalid webhook request.'), requestId, { headers: NO_STORE });
    }

    let event;
    try {
      event = stripe.webhooks.constructEvent(body, signature, secret);
    } catch {
      // Never log the header, the body or the secret.
      log.warn('stripe webhook signature rejected');
      return fail(validation('Invalid webhook signature.'), requestId, { headers: NO_STORE });
    }

    const db = getDb();
    let result;
    try {
      result = await handleStripeEvent(db, event, { log });
    } catch (error) {
      await recordFailedEvent(db, event, error);
      throw error; // → 500, Stripe retries with backoff
    }
    log.info('stripe webhook handled', {
      eventId: event.id,
      type: event.type,
      outcome: result.outcome,
      ...(result.reason ? { reason: result.reason } : {}),
    });
    if (result.reevaluate && result.accountId) {
      await reevaluateSpendAlerts(db, result.accountId, { traceId: `stripe:${event.id}`, log });
    }
    return ok({ received: true, outcome: result.outcome }, requestId, { headers: NO_STORE });
  },
);
