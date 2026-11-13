import 'server-only';
import { and, eq, isNull } from 'drizzle-orm';
import type Stripe from 'stripe';
import { billingAccounts, type Database } from '@lumra/db';
import { ApiFailure } from '@/lib/api';
import { resolveCatalogPrices, resolvePortalConfiguration } from './stripe';

/**
 * Stripe Checkout and Billing Portal sessions (T29, PRD §9.1/§9.5). Callers have authenticated the
 * user; every read and write is scoped to that user's own billing account. Nothing here grants
 * an entitlement: Pro starts only when the signed webhook confirms the subscription (T30).
 */

export interface BillingSessionDeps {
  db: Database;
  stripe: Stripe;
  /** `NEXT_PUBLIC_APP_URL` (validated origin) for the return URLs. */
  appUrl: string;
}

export const alreadySubscribedError = () =>
  new ApiFailure({
    code: 'conflict',
    message: 'You already have Pro. Manage your subscription from the billing portal.',
    retryable: false,
    details: { reason: 'already_subscribed' },
  });

export const noCustomerError = () =>
  new ApiFailure({
    code: 'conflict',
    message: 'There is no billing account to manage yet. Upgrade to Pro first.',
    retryable: false,
    details: { reason: 'no_customer' },
  });

/** Billing statuses that already hold a live subscription (manage it in the portal instead). */
const SUBSCRIBED = new Set(['active', 'past_due', 'restricted']);

async function loadAccount(db: Database, userId: string) {
  const [account] = await db
    .select({
      status: billingAccounts.status,
      stripeCustomerId: billingAccounts.stripeCustomerId,
    })
    .from(billingAccounts)
    .where(eq(billingAccounts.userId, userId));
  // handle_new_user creates the row with the auth user; its absence is a broken invariant.
  if (!account) throw new Error('billing account missing');
  return account;
}

/**
 * The account's Stripe customer, created on first use. The idempotency key collapses concurrent
 * or retried creations into one customer (Stripe keeps keys ≥ 24 h), and the compare-and-set
 * update keeps the first stored id if two requests still race.
 */
export async function ensureStripeCustomer(
  deps: BillingSessionDeps,
  user: { userId: string; email: string | null },
  existing: string | null,
): Promise<string> {
  if (existing) return existing;
  const customer = await deps.stripe.customers.create(
    {
      ...(user.email ? { email: user.email } : {}),
      metadata: { lumra_user_id: user.userId },
    },
    { idempotencyKey: `lumra-customer-${user.userId}` },
  );
  const [stored] = await deps.db
    .update(billingAccounts)
    .set({ stripeCustomerId: customer.id })
    .where(and(eq(billingAccounts.userId, user.userId), isNull(billingAccounts.stripeCustomerId)))
    .returning({ id: billingAccounts.stripeCustomerId });
  if (stored?.id) return stored.id;
  const account = await loadAccount(deps.db, user.userId);
  return account.stripeCustomerId ?? customer.id;
}

/**
 * Checkout Session for Pro: the $2 base price plus both metered overage prices on one
 * subscription (prices found by lookup key, `STRIPE_CATALOG_V1`). `client_reference_id` and the
 * subscription metadata carry the user id so the webhook can map the subscription back.
 */
export async function createCheckoutSession(
  deps: BillingSessionDeps,
  user: { userId: string; email: string | null },
): Promise<{ url: string }> {
  const account = await loadAccount(deps.db, user.userId);
  if (SUBSCRIBED.has(account.status)) throw alreadySubscribedError();

  const prices = await resolveCatalogPrices(deps.stripe);
  const customer = await ensureStripeCustomer(deps, user, account.stripeCustomerId);
  const session = await deps.stripe.checkout.sessions.create({
    mode: 'subscription',
    customer,
    client_reference_id: user.userId,
    line_items: [
      { price: prices.base, quantity: 1 },
      // Metered prices take no quantity: usage arrives through Billing Meter events (T31).
      { price: prices.storageOverage },
      { price: prices.deliveryOverage },
    ],
    subscription_data: { metadata: { lumra_user_id: user.userId } },
    metadata: { lumra_user_id: user.userId },
    success_url: `${deps.appUrl}/account?checkout=success`,
    cancel_url: `${deps.appUrl}/pricing?checkout=canceled`,
  });
  if (!session.url) throw new Error('checkout session has no url');
  return { url: session.url };
}

/** Billing Portal session (payment method, invoices, cancel) for the account's customer. */
export async function createPortalSession(
  deps: BillingSessionDeps,
  user: { userId: string },
): Promise<{ url: string }> {
  const account = await loadAccount(deps.db, user.userId);
  if (!account.stripeCustomerId) throw noCustomerError();
  const configuration = await resolvePortalConfiguration(deps.stripe);
  const session = await deps.stripe.billingPortal.sessions.create({
    customer: account.stripeCustomerId,
    return_url: `${deps.appUrl}/account`,
    ...(configuration ? { configuration } : {}),
  });
  return { url: session.url };
}
